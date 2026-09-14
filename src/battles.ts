import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { Battle, extractChannelMessages, toID } from "@pkmn/sim";
import type { Pokemon, PRNGSeed, Side } from "@pkmn/sim";
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
  createdAt: number;
  /** Set by POST /battles/:id/leave when a side abandons a battle that's already started (the
   * pre-join case just deletes the session outright — see that route). Deliberately not modeled
   * as a Battle.win() call: this app never stores a live Battle, only replays one fresh per
   * request, so any engine-side mutation would vanish the instant the request ends. A flag on
   * meta survives every future rebuild the same way seed/log already do; battleView overrides
   * status/result from it directly instead of asking the (unaware) engine. */
  forfeitedBy?: "p1" | "p2";
}

const store = createSessionStore<SessionMeta>("battle:");

/** Sessions still waiting for a second player — every id here is browsable via `GET
 * /battles/open` as an alternative to sharing a link. Kept in sync explicitly (added at create,
 * removed at join) rather than derived by scanning every session, which Redis has no cheap way to
 * do; a stale id (its session expired before ever being joined) is pruned lazily the next time
 * someone browses, the same lazy-expiry spirit as everything else in this file. */
const OPEN_INDEX_KEY = "open";
const MAX_OPEN_LISTED = 50;

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
  originalIndex: WeakMap<Pokemon, number>,
): PublicMon[] {
  const side = sideid === "p1" ? battle.p1 : battle.p2;
  return side.pokemon
    .map((mon) => ({ mon, i: originalIndex.get(mon)! }))
    .sort((a, b) => a.i - b.i)
    .map(({ mon }) => ({
      // Gen 5 move audit, Fix A: a Transformed/Illusion-disguised mon's *displayed* species
      // diverges from the one it was sent out as — read the live, post-transform identity
      // (`illusion` first, since an active Illusion still reports its own `.species` underneath)
      // rather than the static pre-battle `primitives[]` this roster used to index into.
      speciesID: (mon.illusion ?? mon).species.num,
      name: mon.name,
      fainted: mon.fainted,
      hpFraction: mon.maxhp > 0 ? mon.hp / mon.maxhp : 0,
    }));
}

/**
 * The client shows/picks a switch target by *stable* roster position (`you.roster[i]`, see
 * `publicRoster` above) — but `Battle.choose(side, "switch N")` expects `N` as a 1-indexed
 * position in `side.pokemon`, which `@pkmn/sim` reorders on every switch (the active mon always
 * moves to slot 0, everything before it shifts down, everything after stays put). Left
 * untranslated, a "switch N" built from the stable index only happens to still be correct for
 * mons that were already *after* the currently-active mon's original slot; for anything before
 * it (very often slot 0, the original lead) it silently targets the wrong mon — usually the
 * active mon itself, always rejected, which is exactly the client-reported "I can't switch to my
 * slot 0 Venusaur / works fine for slot 2 Blastoise" split. Rewritten here, once, right before the
 * choice ever reaches the engine or the log — the log's own replay (`rebuildBattle`) must see the
 * same live-indexed string a fresh rebuild resolves identically, since `@pkmn/sim`'s reordering at
 * any given point in a battle's history is itself deterministic.
 */
function toEngineChoice(choice: string, side: Side, originalIndex: WeakMap<Pokemon, number>): string {
  const match = /^switch (\d+)$/.exec(choice);
  if (!match) return choice;
  const stableIndex = Number(match[1]) - 1;
  const target = side.pokemon.find((mon) => originalIndex.get(mon) === stableIndex);
  if (!target) return choice; // no match for that stable index — let the engine reject it on its own terms
  return `switch ${side.pokemon.indexOf(target) + 1}`;
}

interface PublicMoveSlot {
  moveSlug: string;
  pp: number;
  maxPP: number;
  disabled: boolean;
}

/** The structural shape read off `side.activeRequest` — cast rather than imported, since
 * `@pkmn/sim`'s package root only re-exports the `Side` class, not the request interfaces (
 * `MoveRequest`/`PokemonMoveRequestData`) living alongside it in `./side`. */
interface ActiveMoveRequest {
  active?: {
    moves?: { move: string; id: string; pp?: number; maxpp?: number; disabled?: string | boolean }[];
    trapped?: boolean;
    maybeTrapped?: boolean;
  }[];
}

/**
 * Gen 5 move audit, Fix B: `MonState.knownMoves` on the client reflects what this side
 * *submitted* at battle start — never updated after Disable/Taunt/Encore/Torment/Imprison lock a
 * slot, Mimic/Sketch overwrite one, or a charge/recharge/locked-in move restricts the turn.
 * `@pkmn/sim` already computes the true post-restriction slots (id/PP/disabled) once per turn as
 * the move request it hands the side — read that back here (`side.activeRequest`, populated
 * whenever `requestState === "move"`) rather than calling `Pokemon.getMoveRequestData()`
 * ourselves, which mutates the mon's trap/lock flags as a side effect and is meant to be called
 * exactly once, internally, when the engine builds the request.
 *
 * Locked into a charge/recharge/repeat turn (Fly's "flew up high" beat, Hyper Beam's forced
 * recharge, mid-Outrage) — `getMoves()`'s locked-move branch (`@pkmn/sim`'s pokemon.js) returns
 * *only* `{move, id}` for that one slot, dropping `pp`/`maxpp` entirely (its reference client,
 * Showdown, never renders a PP number for a locked turn — there's nothing to choose either way).
 * Left as `?? 0`, that read as "0 PP left", indistinguishable from an exhausted move. Backfilled
 * here from `pokemon.moveSlots` (the mon's own real, always-current PP ledger) by move id, which
 * covers every locked-in-a-real-move case (Fly, Outrage, Bide, ...). The one case that *isn't* a
 * real known move — Hyper Beam's synthetic `"recharge"` pseudo-move — has no PP to backfill (it's
 * not a move the mon knows), so it still reports 0/0; the client falls back to the slug itself as
 * display text there rather than a `moveDetail` lookup, since PokéAPI has no "recharge" move either.
 */
/** The one known case (of all 458 real Gen<=5 moves, checked 2026-09-14) where the generic
 * lowercase-and-hyphenate slug doesn't match PokéAPI: Game Freak's official spelling is "Vise
 * Grip" (what `@pkmn/sim` says here), but PokéAPI never updated its slug from "Vice Grip". */
const MOVE_SLUG_ALIASES: Record<string, string> = { "vise-grip": "vice-grip" };

function activeMoveSlots(side: Side, active: Pokemon): PublicMoveSlot[] | null {
  const slot = (side.activeRequest as ActiveMoveRequest | null)?.active?.[0];
  if (side.requestState !== "move" || !slot?.moves) return null;
  return slot.moves.map((m) => {
    const real = active.moveSlots.find((s) => s.id === m.id);
    const slug = m.move.toLowerCase().replace(/\s+/g, "-");
    return {
      moveSlug: MOVE_SLUG_ALIASES[slug] ?? slug,
      pp: m.pp ?? real?.pp ?? 0,
      maxPP: m.maxpp ?? real?.maxpp ?? 0,
      disabled: !!m.disabled,
    };
  });
}

/**
 * Gen 5 move audit, "partial trap" category (Wrap/Bind/Fire Spin/Clamp/Whirlpool/Sand Tomb/Magma
 * Storm): these don't restrict which move you pick, they restrict whether you can switch out at
 * all — a legality fact `activeMoveSlots` above never carried (it only forwards `.moves`). Same
 * source, same request object, just the sibling `trapped`/`maybeTrapped` fields
 * `getMoveRequestData` sets alongside `moves` (`@pkmn/sim`'s pokemon.js: set once, canSwitchIn
 * already factored in — never recomputed here).
 */
function isTrapped(side: Side): boolean {
  const slot = (side.activeRequest as ActiveMoveRequest | null)?.active?.[0];
  return side.requestState === "move" && !!(slot?.trapped || slot?.maybeTrapped);
}

function battleView(meta: SessionMeta, rebuilt: RebuiltBattle | undefined, mySideID: "p1" | "p2"): Record<string, unknown> {
  if (!rebuilt || !meta.b) return { status: "waiting", turn: 0 };
  const { battle, originalIndex } = rebuilt;
  const oppRosterSide = mySideID === "p1" ? meta.b : meta.a;
  const mySide = mySideID === "p1" ? battle.p1 : battle.p2;
  const oppSide = mySideID === "p1" ? battle.p2 : battle.p1;

  // Turn cap: called once, lazily, the first time either participant polls/chooses past it —
  // `battle.tie()` flips `ended`/emits a `|tie|` log line through the engine itself rather than
  // this endpoint faking a result. Not recorded in the log — it's a pure function of `battle.turn`,
  // itself deterministically reproduced by replay, so every rebuild reaches the same conclusion.
  if (!battle.ended && battle.turn > TURN_CAP) battle.tie();

  // A forfeit overrides the engine's own ended/winner state — see SessionMeta.forfeitedBy's doc for
  // why this can't just be a battle.win() call. The roster/HP/log below still reflect the real
  // battle state at the moment of forfeit; only status/result/pendingChoice are overridden.
  const completed = battle.ended || meta.forfeitedBy !== undefined;
  let result: "win" | "loss" | "draw" | undefined;
  if (meta.forfeitedBy) {
    result = meta.forfeitedBy === mySideID ? "loss" : "win";
  } else if (battle.ended) {
    result = !battle.winner ? "draw" : battle.winner === (mySideID === "p1" ? meta.a.displayName : meta.b.displayName)
      ? "win" : "loss";
  }

  const oppActive = oppSide.active[0];
  return {
    status: completed ? "completed" : "active",
    turn: battle.turn,
    pendingChoice: completed ? "" : mySide.requestState,
    you: {
      displayName: mySideID === "p1" ? meta.a.displayName : meta.b.displayName,
      roster: publicRoster(battle, mySideID, originalIndex),
      activeIndex: originalIndex.get(mySide.active[0])!,
      // Gen 5 move audit, Fix B — see `activeMoveSlots`. `null` while it isn't this side's move
      // choice (switch/team-preview/wait), same as `pendingChoice` distinguishing those states.
      activeMoves: activeMoveSlots(mySide, mySide.active[0]),
      // Gen 5 move audit, "partial trap" category — see `isTrapped`. False (not just absent) while
      // it isn't this side's move choice, matching `activeMoves`' null in that same window — the
      // client can safely treat "can't switch" as the resting default rather than needing a third
      // "don't know yet" state.
      trapped: isTrapped(mySide),
    },
    opponent: {
      displayName: oppRosterSide.displayName,
      // Only the active mon is public — the bench stays hidden, same reasoning trading's opaque
      // blob doesn't apply here to (this is arbitrated, not relayed) but scouting a full 6-mon
      // roster mid-battle is still more information than a casual 1:1 battle should hand over.
      active: oppActive
        ? {
            // Gen 5 move audit, Fix A — a Transformed/Illusion-disguised mon's displayed species
            // diverges from the one it was sent out as; read the live identity, not the static
            // pre-battle primitive this used to index into.
            speciesID: (oppActive.illusion ?? oppActive).species.num,
            name: oppActive.name,
            fainted: oppActive.fainted,
            hpFraction: oppActive.maxhp > 0 ? oppActive.hp / oppActive.maxhp : 0,
          }
        : null,
      rosterSize: oppSide.pokemon.length,
    },
    // The session creator's (`meta.a`, "p1") first roster slot — same value for both sides' polls,
    // regardless of who's asking, since it's read off `meta` directly rather than "you"/"opponent"
    // (which flip per-viewer). Lets the client pick a battle background by type deterministically:
    // both players resolve the same species → the same terrain, without needing to know who's the
    // host (this app never tells a client whether it's p1/p2 — see sideIdFor's callers) or seeing
    // more than a species id, the same amount of information the opponent's own active mon already
    // reveals.
    hostLeadSpeciesID: meta.a.primitives[0].speciesID,
    // `battle.log` is written for a real Showdown *server* to fan out, not for a single viewer to
    // read directly: a `|split|pN` line means the next two lines are the same event twice — once
    // with the full detail only pN's own client should see, once with the redacted detail every
    // other viewer gets — and the receiving client is the one expected to pick a line and drop the
    // other. Nothing here ever did that, so both copies rode along verbatim (visible as doubled
    // "sent out"/"took damage" lines once the client started rendering the log as readable text
    // instead of raw protocol nobody looked at closely). `extractChannelMessages` is `@pkmn/sim`'s
    // own implementation of that same per-viewer pick — channel `1`/`2` for `mySideID`'s own splits
    // resolves to the secret (full-detail) line, and to the shared (redacted) line for the other
    // side's splits, exactly matching what a real client would show this viewer.
    log: extractChannelMessages(battle.log.join("\n"), [mySideID === "p1" ? 1 : 2])[mySideID === "p1" ? 1 : 2],
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
    await store.saveMeta(id, {
      a: { uuid: req.body.uuid, displayName: req.body.displayName, primitives: req.body.party },
      createdAt: Date.now(),
    }, IDLE_TTL_MS);
    await store.addToSet(OPEN_INDEX_KEY, id);
    return { sessionId: id };
  });

  // Lists sessions still waiting for a second player — the alternative to sharing a link. Reads
  // every open id's meta both to render the listing and to lazily prune ones whose session
  // already expired without ever being joined (see `OPEN_INDEX_KEY`'s comment).
  app.get("/battles/open", async () => {
    const ids = await store.setMembers(OPEN_INDEX_KEY);
    const entries: { sessionId: string; displayName: string; rosterSize: number; createdAt: number }[] = [];
    for (const id of ids) {
      const meta = await store.loadMeta(id);
      if (!meta || meta.b) {
        // Expired without being joined, or joined through a path that didn't reach the
        // removeFromSet below (defensive) — either way it doesn't belong in the open list.
        await store.removeFromSet(OPEN_INDEX_KEY, id);
        continue;
      }
      entries.push({ sessionId: id, displayName: meta.a.displayName, rosterSize: meta.a.primitives.length, createdAt: meta.createdAt });
    }
    entries.sort((a, b) => b.createdAt - a.createdAt);
    return { battles: entries.slice(0, MAX_OPEN_LISTED) };
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

    await store.saveMeta(id, { a: meta.a, b: bSide, seed: battle.prngSeed, createdAt: meta.createdAt }, IDLE_TTL_MS);
    for (const entry of teamPreviewEntries) await store.appendLog(id, entry, IDLE_TTL_MS);
    await store.removeFromSet(OPEN_INDEX_KEY, id);
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
    if (meta.forfeitedBy) return reply.code(409).send({ error: "battle already completed" });
    const rebuilt = await rebuildBattle(id, meta);
    if (!rebuilt) return reply.code(409).send({ error: "battle not started" });
    if (rebuilt.battle.ended) return reply.code(409).send({ error: "battle already completed" });
    const engineChoice = toEngineChoice(req.body.choice, sideid === "p1" ? rebuilt.battle.p1 : rebuilt.battle.p2, rebuilt.originalIndex);
    const accepted = rebuilt.battle.choose(sideid, engineChoice);
    if (!accepted) return reply.code(400).send({ error: "choice rejected by battle engine" });
    await store.appendLog(id, packEntry(sideid, engineChoice), IDLE_TTL_MS);
    return battleView(meta, rebuilt, sideid);
  });

  // Explicit "I'm abandoning this battle" — every client exit path (cancel before an opponent
  // joins, a voluntary forfeit mid-battle, best-effort on app quit) routes through here rather than
  // just letting the session sit until its TTL lapses. Before a join, there's nothing to resolve —
  // delete outright. After, the other side deserves a real result on their next poll, not a session
  // that silently goes quiet for up to 5 idle minutes and then 404s — see battleView's
  // meta.forfeitedBy handling.
  app.post("/battles/:id/leave", async (req, reply) => {
    const { id } = req.params as { id: string };
    const meta = await store.loadMeta(id);
    if (!meta) return reply.code(404).send({ error: "not found" });
    const { uuid } = (req.body ?? {}) as { uuid?: string };
    const sideid = sideIdFor(meta, uuid ?? "");
    if (!sideid) return reply.code(403).send({ error: "not a participant" });

    if (!meta.b) {
      await store.remove(id);
      await store.removeFromSet(OPEN_INDEX_KEY, id);
      return { status: "removed" };
    }
    if (meta.forfeitedBy || (await rebuildBattle(id, meta))?.battle.ended) {
      return { status: "already completed" };
    }
    await store.saveMeta(id, { ...meta, forfeitedBy: sideid }, IDLE_TTL_MS);
    return { status: "forfeited" };
  });
}
