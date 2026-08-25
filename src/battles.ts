import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { Battle, toID } from "@pkmn/sim";
import type { Pokemon, PRNGSeed } from "@pkmn/sim";
import type { PokemonSet } from "@pkmn/types";
import { type MonPrimitive, isRoster, toPokemonSet, hasSpecies, UnknownSpeciesError } from "./pkmnAdapter.js";
import { createSessionStore, redisConfigured } from "./sessionStore.js";

// gen 5, unrestricted — matches the client's pinned MoveDataVersion.versionGroup ("black-white")
// and has no competitive tier/clause validation to fight against (this app isn't enforcing a
// tier, just running the mechanics). `toID` wraps the literal in `@pkmn/sim`'s branded `ID` type.
const FORMAT = toID("gen5customgame");

/** Real games can stall indefinitely with certain move/status combinations (e.g. double
 * Protect/PP-stall loops); cap turns and call it a draw rather than let a session run forever.
 * Placeholder value — battles.md flags the exact number/handling as an open decision. */
const TURN_CAP = 100;

/** Sliding TTL: unlike trading's fixed 10-minutes-from-creation window, a team battle can run
 * many turns over several minutes of real back-and-forth, so the clock resets on every `/choose`
 * (and on `/join`) instead of counting down from creation. See battles.md's Flow §6. */
const IDLE_TTL_MS = 5 * 60 * 1000;

interface RosterSide {
  uuid: string;
  displayName: string;
  primitives: MonPrimitive[];
}

/**
 * No live `Battle` object is ever stored — it isn't cheaply serializable, and holding it in
 * process memory is exactly the thing that can't survive Vercel's multi-instance serverless
 * scaling. Instead this is the deterministic recipe to rebuild one: `@pkmn/sim` is a pure
 * function of (seed, ordered exogenous choices), so a fresh `Battle` constructed with the same
 * seed and replayed through the same choice log ends up in bit-for-bit the same state as the
 * "real" one would be. `seed` is set once, at join (`battle.prngSeed` from the throwaway battle
 * built to validate the join and skip team preview); the log then lives in the store's separate,
 * atomically-appendable `log` — see `sessionStore.ts`.
 */
interface SessionMeta {
  a: RosterSide;
  b?: RosterSide;
  seed?: PRNGSeed;
}

const store = createSessionStore<SessionMeta>("battle:");

function packEntry(side: "p1" | "p2", choice: string): string {
  return `${side}:${choice}`;
}

function unpackEntry(entry: string): { side: "p1" | "p2"; choice: string } {
  return { side: entry.slice(0, 2) as "p1" | "p2", choice: entry.slice(3) };
}

function isCreatePayload(body: unknown): body is { uuid: string; displayName: string; party: MonPrimitive[] } {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.uuid === "string" && b.uuid.length > 0 &&
    typeof b.displayName === "string" && b.displayName.length > 0 && b.displayName.length <= 60 &&
    isRoster(b.party)
  );
}

function isChoicePayload(body: unknown): body is { uuid: string; choice: string } {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return typeof b.uuid === "string" && b.uuid.length > 0 &&
    typeof b.choice === "string" && b.choice.length > 0 && b.choice.length <= 40;
}

function sideIdFor(meta: SessionMeta, uuid: string): "p1" | "p2" | null {
  if (uuid === meta.a.uuid) return "p1";
  if (uuid === meta.b?.uuid) return "p2";
  return null;
}

interface RebuiltBattle {
  battle: Battle;
  // `@pkmn/sim` reorders `side.pokemon` on every switch (the active mon moves to index 0) — so
  // positional indexing against the originally-submitted `primitives` array goes wrong the instant
  // either side switches. Built fresh on every rebuild, right after `Battle` construction (before
  // any replayed choice can reorder anything), as a stable identity → original-roster-index
  // lookup that survives reordering.
  originalIndex: WeakMap<Pokemon, number>;
}

/** Reconstructs the live battle from `meta` + the store's persisted choice log. Cheap enough to
 * do on every request: a battle is bounded by `TURN_CAP` turns, and each replayed choice is a
 * fast, pure computation. */
async function rebuildBattle(id: string, meta: SessionMeta): Promise<RebuiltBattle | undefined> {
  if (!meta.b || !meta.seed) return undefined;
  const teamA = meta.a.primitives.map((m, i) => toPokemonSet(m, `${meta.a.displayName}-${i}`));
  const teamB = meta.b.primitives.map((m, i) => toPokemonSet(m, `${meta.b!.displayName}-${i}`));
  const battle = new Battle({
    formatid: FORMAT,
    seed: meta.seed,
    p1: { name: meta.a.displayName, team: teamA },
    p2: { name: meta.b.displayName, team: teamB },
  });
  const originalIndex = new WeakMap<Pokemon, number>();
  battle.p1.pokemon.forEach((mon, i) => originalIndex.set(mon, i));
  battle.p2.pokemon.forEach((mon, i) => originalIndex.set(mon, i));
  for (const entry of await store.loadLog(id)) {
    const { side, choice } = unpackEntry(entry);
    battle.choose(side, choice);
  }
  return { battle, originalIndex };
}

interface PublicMon {
  speciesID: number;
  name: string;
  fainted: boolean;
  hpFraction: number;
}

/** Emits the roster in the client's originally-submitted order (stable across polls) rather than
 * `side.pokemon`'s iteration order, which `@pkmn/sim` reorders on every switch — a switch picker
 * whose rows silently reshuffled every time you tapped one would be unusable. */
function publicRoster(
  battle: Battle,
  sideid: "p1" | "p2",
  primitives: MonPrimitive[],
  originalIndex: WeakMap<Pokemon, number>,
): PublicMon[] {
  const side = sideid === "p1" ? battle.p1 : battle.p2;
  return side.pokemon
    .map((mon) => ({ mon, i: originalIndex.get(mon)! }))
    .sort((a, b) => a.i - b.i)
    .map(({ mon, i }) => ({
      speciesID: primitives[i].speciesID,
      name: mon.name,
      fainted: mon.fainted,
      hpFraction: mon.maxhp > 0 ? mon.hp / mon.maxhp : 0,
    }));
}

function battleView(meta: SessionMeta, rebuilt: RebuiltBattle | undefined, mySideID: "p1" | "p2"): Record<string, unknown> {
  if (!rebuilt || !meta.b) return { status: "waiting", turn: 0 };
  const { battle, originalIndex } = rebuilt;
  const oppSideID = mySideID === "p1" ? "p2" : "p1";
  const oppRosterSide = mySideID === "p1" ? meta.b : meta.a;
  const mySide = mySideID === "p1" ? battle.p1 : battle.p2;
  const oppSide = mySideID === "p1" ? battle.p2 : battle.p1;

  // Turn cap: called once, lazily, the first time either participant polls/chooses past it —
  // `battle.tie()` flips `ended`/emits a `|tie|` log line through the engine itself rather than
  // this endpoint faking a result. Not recorded in the log — it's a pure function of `battle.turn`,
  // itself deterministically reproduced by replay, so every rebuild reaches the same conclusion.
  if (!battle.ended && battle.turn > TURN_CAP) battle.tie();

  let result: "win" | "loss" | "draw" | undefined;
  if (battle.ended) {
    result = !battle.winner ? "draw" : battle.winner === (mySideID === "p1" ? meta.a.displayName : meta.b.displayName)
      ? "win" : "loss";
  }

  const oppActive = oppSide.active[0];
  return {
    status: battle.ended ? "completed" : "active",
    turn: battle.turn,
    pendingChoice: battle.ended ? "" : mySide.requestState,
    you: {
      displayName: mySideID === "p1" ? meta.a.displayName : meta.b.displayName,
      roster: publicRoster(battle, mySideID, mySideID === "p1" ? meta.a.primitives : meta.b.primitives, originalIndex),
      activeIndex: originalIndex.get(mySide.active[0])!,
    },
    opponent: {
      displayName: oppRosterSide.displayName,
      // Only the active mon is public — the bench stays hidden, same reasoning trading's opaque
      // blob doesn't apply here to (this is arbitrated, not relayed) but scouting a full 6-mon
      // roster mid-battle is still more information than a casual 1:1 battle should hand over.
      active: oppActive
        ? {
            speciesID: (oppSideID === "p1" ? meta.a.primitives : meta.b!.primitives)[
              originalIndex.get(oppActive)!
            ].speciesID,
            name: oppActive.name,
            fainted: oppActive.fainted,
            hpFraction: oppActive.maxhp > 0 ? oppActive.hp / oppActive.maxhp : 0,
          }
        : null,
      rosterSize: oppSide.pokemon.length,
    },
    log: battle.log,
    result,
  };
}

export function registerBattleRoutes(app: FastifyInstance): void {
  app.post("/battles", async (req, reply) => {
    // A battle session lives for dozens of polls/choices over several minutes — far more chances
    // for a request to land on a different warm instance than trading's ~4-request handshake, and
    // Vercel serverless can't guarantee session affinity. With the Upstash Redis Marketplace
    // integration installed (`redisConfigured`), session state lives in Redis instead of process
    // memory and this is a non-issue; without it, refuse loudly here rather than let a real battle
    // silently vanish mid-fight. Vercel sets this env var on every deployment, serverless or not.
    if (process.env.VERCEL && !redisConfigured) {
      return reply.code(501).send({
        error: "battles on Vercel require the Upstash Redis Marketplace integration (in-memory session state can't survive multi-instance serverless scaling) — see README",
      });
    }
    if (!isCreatePayload(req.body)) return reply.code(400).send({ error: "invalid roster" });
    const unknown = req.body.party.find((m) => !hasSpecies(m.speciesID));
    if (unknown) return reply.code(400).send({ error: `unknown species ${unknown.speciesID}` });
    const id = randomUUID();
    await store.saveMeta(id, { a: { uuid: req.body.uuid, displayName: req.body.displayName, primitives: req.body.party } }, IDLE_TTL_MS);
    return { sessionId: id };
  });

  app.post("/battles/:id/join", async (req, reply) => {
    const { id } = req.params as { id: string };
    const meta = await store.loadMeta(id);
    if (!meta) return reply.code(404).send({ error: "not found" });
    if (!isCreatePayload(req.body)) return reply.code(400).send({ error: "invalid roster" });
    if (meta.b || req.body.uuid === meta.a.uuid) {
      return reply.code(409).send({ error: "cannot join" });
    }
    const unknown = req.body.party.find((m) => !hasSpecies(m.speciesID));
    if (unknown) return reply.code(400).send({ error: `unknown species ${unknown.speciesID}` });

    const bSide: RosterSide = { uuid: req.body.uuid, displayName: req.body.displayName, primitives: req.body.party };
    let teamA: PokemonSet[], teamB: PokemonSet[];
    try {
      teamA = meta.a.primitives.map((m, i) => toPokemonSet(m, `${meta.a.displayName}-${i}`));
      teamB = bSide.primitives.map((m, i) => toPokemonSet(m, `${bSide.displayName}-${i}`));
    } catch (e) {
      if (e instanceof UnknownSpeciesError) return reply.code(400).send({ error: e.message });
      throw e;
    }

    // Built once, thrown away — its only jobs are picking a PRNG seed and clearing team preview
    // (this app has no team-preview strategy layer, so it's cleared automatically the instant
    // both sides are in rather than surfaced as a client-visible step). Both outcomes are
    // captured into `meta`/the log so every future rebuild reproduces this exact battle.
    const battle = new Battle({
      formatid: FORMAT,
      p1: { name: meta.a.displayName, team: teamA },
      p2: { name: bSide.displayName, team: teamB },
    });
    const teamPreviewEntries: string[] = [];
    for (const [sideid, side, count] of [
      ["p1", battle.p1, teamA.length],
      ["p2", battle.p2, teamB.length],
    ] as const) {
      if (side.requestState === "teampreview") {
        const choice = `team ${Array.from({ length: count }, (_, i) => i + 1).join("")}`;
        battle.choose(sideid, choice);
        teamPreviewEntries.push(packEntry(sideid, choice));
      }
    }

    await store.saveMeta(id, { a: meta.a, b: bSide, seed: battle.prngSeed }, IDLE_TTL_MS);
    for (const entry of teamPreviewEntries) await store.appendLog(id, entry, IDLE_TTL_MS);
    return { status: "active" };
  });

  app.get("/battles/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { uuid } = req.query as { uuid?: string };
    const meta = await store.loadMeta(id);
    if (!meta) return reply.code(404).send({ error: "not found" });
    if (!uuid) return reply.code(400).send({ error: "uuid required" });
    const mySideID = sideIdFor(meta, uuid);
    if (!mySideID) return reply.code(403).send({ error: "not a participant" });
    return battleView(meta, await rebuildBattle(id, meta), mySideID);
  });

  app.post("/battles/:id/choose", async (req, reply) => {
    const { id } = req.params as { id: string };
    const meta = await store.loadMeta(id);
    if (!meta) return reply.code(404).send({ error: "not found" });
    if (!isChoicePayload(req.body)) return reply.code(400).send({ error: "invalid choice" });
    const sideid = sideIdFor(meta, req.body.uuid);
    if (!sideid) return reply.code(403).send({ error: "not a participant" });
    const rebuilt = await rebuildBattle(id, meta);
    if (!rebuilt) return reply.code(409).send({ error: "battle not started" });
    if (rebuilt.battle.ended) return reply.code(409).send({ error: "battle already completed" });
    const accepted = rebuilt.battle.choose(sideid, req.body.choice);
    if (!accepted) return reply.code(400).send({ error: "choice rejected by battle engine" });
    await store.appendLog(id, packEntry(sideid, req.body.choice), IDLE_TTL_MS);
    return battleView(meta, rebuilt, sideid);
  });
}
