import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { Battle, toID } from "@pkmn/sim";
import type { Pokemon } from "@pkmn/sim";
import type { PokemonSet } from "@pkmn/types";
import { type MonPrimitive, isRoster, toPokemonSet, hasSpecies, UnknownSpeciesError } from "./pkmnAdapter.js";

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

interface Session {
  a: RosterSide;
  b?: RosterSide;
  battle?: Battle;
  // `@pkmn/sim` reorders `side.pokemon` on every switch (the active mon moves to index 0) — so
  // positional indexing against the originally-submitted `primitives` array goes wrong the instant
  // either side switches. Built once, right after `Battle` construction (before any choice can
  // reorder anything), as a stable identity → original-roster-index lookup that survives reordering.
  originalIndex?: WeakMap<Pokemon, number>;
  lastActivityAt: number;
}

const sessions = new Map<string, Session>();

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

/** Lazy expiry-on-access, same reasoning as trades.ts (a timer in one Vercel instance can't clean
 * up another instance's memory anyway) — but sliding on `lastActivityAt`, not fixed from creation. */
export function getSession(id: string): Session | undefined {
  const session = sessions.get(id);
  if (!session) return undefined;
  if (Date.now() - session.lastActivityAt > IDLE_TTL_MS) {
    sessions.delete(id);
    return undefined;
  }
  return session;
}

/** Clears team preview for a side by submitting the identity order (1, 2, 3, ...) — this app has
 * no team-preview strategy layer (scope: just pick your roster ahead of time), so it's cleared
 * automatically the instant both sides are in rather than surfaced as a client-visible step. */
function skipTeamPreview(battle: Battle, sideid: "p1" | "p2", count: number): void {
  const side = sideid === "p1" ? battle.p1 : battle.p2;
  if (side.requestState === "teampreview") {
    const order = Array.from({ length: count }, (_, i) => i + 1).join("");
    battle.choose(sideid, `team ${order}`);
  }
}

function sideIdFor(session: Session, uuid: string): "p1" | "p2" | null {
  if (uuid === session.a.uuid) return "p1";
  if (uuid === session.b?.uuid) return "p2";
  return null;
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

function battleView(session: Session, uuid: string): Record<string, unknown> {
  const mySideID = sideIdFor(session, uuid);
  if (!mySideID) throw new Error("unreachable — caller already checked participancy");
  if (!session.battle || !session.b) {
    return { status: "waiting", turn: 0 };
  }
  const battle = session.battle;
  const originalIndex = session.originalIndex!;
  const oppSideID = mySideID === "p1" ? "p2" : "p1";
  const oppRosterSide = mySideID === "p1" ? session.b : session.a;
  const mySide = mySideID === "p1" ? battle.p1 : battle.p2;
  const oppSide = mySideID === "p1" ? battle.p2 : battle.p1;

  // Turn cap: called once, lazily, the first time either participant polls/chooses past it —
  // `battle.tie()` flips `ended`/emits a `|tie|` log line through the engine itself rather than
  // this endpoint faking a result.
  if (!battle.ended && battle.turn > TURN_CAP) battle.tie();

  let result: "win" | "loss" | "draw" | undefined;
  if (battle.ended) {
    result = !battle.winner ? "draw" : battle.winner === (mySideID === "p1" ? session.a.displayName : session.b.displayName)
      ? "win" : "loss";
  }

  const oppActive = oppSide.active[0];
  return {
    status: battle.ended ? "completed" : "active",
    turn: battle.turn,
    pendingChoice: battle.ended ? "" : mySide.requestState,
    you: {
      displayName: mySideID === "p1" ? session.a.displayName : session.b.displayName,
      roster: publicRoster(battle, mySideID, mySideID === "p1" ? session.a.primitives : session.b.primitives, originalIndex),
      activeIndex: originalIndex.get(mySide.active[0])!,
    },
    opponent: {
      displayName: oppRosterSide.displayName,
      // Only the active mon is public — the bench stays hidden, same reasoning trading's opaque
      // blob doesn't apply here to (this is arbitrated, not relayed) but scouting a full 6-mon
      // roster mid-battle is still more information than a casual 1:1 battle should hand over.
      active: oppActive
        ? {
            speciesID: (oppSideID === "p1" ? session.a.primitives : session.b!.primitives)[
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
    // Unlike trading, a battle session lives for dozens of polls/choices over several minutes —
    // far more chances for a request to land on a different warm instance than trading's ~4-request
    // handshake. Vercel serverless can't guarantee session affinity, so battles require self-hosting
    // as a single process (README's "Known limitation" section); refuse loudly here rather than let
    // a real battle silently vanish mid-fight when a request lands on an instance with no memory of
    // it. Vercel sets this env var on every deployment, serverless or not.
    if (process.env.VERCEL) {
      return reply.code(501).send({
        error: "battles require self-hosting as a single process (in-memory session state can't survive Vercel's multi-instance serverless scaling) — see README",
      });
    }
    if (!isCreatePayload(req.body)) return reply.code(400).send({ error: "invalid roster" });
    const unknown = req.body.party.find((m) => !hasSpecies(m.speciesID));
    if (unknown) return reply.code(400).send({ error: `unknown species ${unknown.speciesID}` });
    const id = randomUUID();
    sessions.set(id, {
      a: { uuid: req.body.uuid, displayName: req.body.displayName, primitives: req.body.party },
      lastActivityAt: Date.now(),
    });
    return { sessionId: id };
  });

  app.post("/battles/:id/join", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = getSession(id);
    if (!session) return reply.code(404).send({ error: "not found" });
    if (!isCreatePayload(req.body)) return reply.code(400).send({ error: "invalid roster" });
    if (session.b || req.body.uuid === session.a.uuid) {
      return reply.code(409).send({ error: "cannot join" });
    }
    const unknown = req.body.party.find((m) => !hasSpecies(m.speciesID));
    if (unknown) return reply.code(400).send({ error: `unknown species ${unknown.speciesID}` });

    session.b = { uuid: req.body.uuid, displayName: req.body.displayName, primitives: req.body.party };
    let teamA: PokemonSet[], teamB: PokemonSet[];
    try {
      teamA = session.a.primitives.map((m, i) => toPokemonSet(m, `${session.a.displayName}-${i}`));
      teamB = session.b.primitives.map((m, i) => toPokemonSet(m, `${session.b!.displayName}-${i}`));
    } catch (e) {
      session.b = undefined; // roll back the join — the session stays open for a real join
      if (e instanceof UnknownSpeciesError) return reply.code(400).send({ error: e.message });
      throw e;
    }
    const battle = new Battle({
      formatid: FORMAT,
      p1: { name: session.a.displayName, team: teamA },
      p2: { name: session.b.displayName, team: teamB },
    });
    // `side.pokemon` matches submitted team order only right now, before any switch reorders it —
    // capture that correspondence immediately, by object identity, so it survives every reorder
    // for the rest of the battle. See the `Session.originalIndex` comment.
    const originalIndex = new WeakMap<Pokemon, number>();
    battle.p1.pokemon.forEach((mon, i) => originalIndex.set(mon, i));
    battle.p2.pokemon.forEach((mon, i) => originalIndex.set(mon, i));
    session.originalIndex = originalIndex;
    skipTeamPreview(battle, "p1", teamA.length);
    skipTeamPreview(battle, "p2", teamB.length);
    session.battle = battle;
    session.lastActivityAt = Date.now();
    return { status: "active" };
  });

  app.get("/battles/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { uuid } = req.query as { uuid?: string };
    const session = getSession(id);
    if (!session) return reply.code(404).send({ error: "not found" });
    if (!uuid) return reply.code(400).send({ error: "uuid required" });
    if (!sideIdFor(session, uuid)) return reply.code(403).send({ error: "not a participant" });
    return battleView(session, uuid);
  });

  app.post("/battles/:id/choose", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = getSession(id);
    if (!session) return reply.code(404).send({ error: "not found" });
    if (!isChoicePayload(req.body)) return reply.code(400).send({ error: "invalid choice" });
    const sideid = sideIdFor(session, req.body.uuid);
    if (!sideid) return reply.code(403).send({ error: "not a participant" });
    if (!session.battle) return reply.code(409).send({ error: "battle not started" });
    if (session.battle.ended) return reply.code(409).send({ error: "battle already completed" });
    const accepted = session.battle.choose(sideid, req.body.choice);
    if (!accepted) return reply.code(400).send({ error: "choice rejected by battle engine" });
    session.lastActivityAt = Date.now();
    return battleView(session, req.body.uuid);
  });
}
