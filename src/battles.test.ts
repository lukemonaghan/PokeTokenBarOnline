import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./app.js";
import { redisConfigured } from "./sessionStore.js";

// node:test + Fastify's built-in .inject() — no supertest, no test framework dependency, matches
// this repo's "no database, minimal deps" stance. Each test creates its own session (random uuid
// per POST /battles) so tests can share one app instance without colliding on session state.

const Z = { hp: 10, atk: 10, def: 10, spa: 10, spd: 10, spe: 10 };
const bulbasaur = (moves: string[] = ["tackle"]) =>
  ({ speciesID: 1, level: 5, nature: "hardy", ability: "overgrow", ivs: Z, evs: Z, moves });
const squirtle = (moves: string[] = ["tackle"]) =>
  ({ speciesID: 7, level: 5, nature: "hardy", ability: "torrent", ivs: Z, evs: Z, moves });
const charmander = (moves: string[] = ["scratch"]) =>
  ({ speciesID: 4, level: 5, nature: "hardy", ability: "blaze", ivs: Z, evs: Z, moves });
const charizard = (moves: string[] = ["scratch"]) =>
  ({ speciesID: 6, level: 30, nature: "hardy", ability: "blaze", ivs: Z, evs: Z, moves });

async function createAndJoin(
  app: ReturnType<typeof buildApp>,
  partyA: unknown[],
  partyB: unknown[],
  uuidA = "uuid-a",
  uuidB = "uuid-b",
) {
  const create = await app.inject({
    method: "POST",
    url: "/battles",
    payload: { uuid: uuidA, displayName: "Ash", party: partyA },
  });
  const { sessionId } = create.json();
  const join = await app.inject({
    method: "POST",
    url: `/battles/${sessionId}/join`,
    payload: { uuid: uuidB, displayName: "Gary", party: partyB },
  });
  return { sessionId, joinBody: join.json() };
}

test("create + join starts an active battle", async () => {
  const app = buildApp();
  const { joinBody } = await createAndJoin(app, [bulbasaur()], [charmander()]);
  assert.equal(joinBody.status, "active");
});

test("hostLeadSpeciesID is the creator's first roster slot, the same for both sides' polls", async () => {
  const app = buildApp();
  const { sessionId } = await createAndJoin(app, [bulbasaur()], [charmander()]);
  const creatorPoll = await app.inject({ method: "GET", url: `/battles/${sessionId}?uuid=uuid-a` });
  const joinerPoll = await app.inject({ method: "GET", url: `/battles/${sessionId}?uuid=uuid-b` });
  assert.equal(creatorPoll.json().hostLeadSpeciesID, 1, "bulbasaur()'s speciesID");
  assert.equal(joinerPoll.json().hostLeadSpeciesID, 1, "same value regardless of who's asking");
});

test("a resolved turn deals damage and increments the turn counter", async () => {
  const app = buildApp();
  const { sessionId } = await createAndJoin(app, [bulbasaur()], [charmander()]);
  await app.inject({ method: "POST", url: `/battles/${sessionId}/choose`, payload: { uuid: "uuid-a", choice: "move 1" } });
  const res = await app.inject({ method: "POST", url: `/battles/${sessionId}/choose`, payload: { uuid: "uuid-b", choice: "move 1" } });
  const body = res.json();
  assert.equal(body.turn, 2);
  assert.ok(body.you.roster[0].hpFraction < 1, "attacker's own mon should show undamaged");
  assert.ok(body.opponent.active.hpFraction < 1, "opponent's active mon should have taken damage");
});

// Gen 5 move audit, Fix B — `you.activeMoves` must reflect @pkmn/sim's live per-slot request data
// (id/PP/disabled), not just echo whatever the client originally submitted.
test("you.activeMoves exposes live move slots with slugs matching the submitted primitives", async () => {
  const app = buildApp();
  const { sessionId } = await createAndJoin(app, [bulbasaur(["tackle", "growl"])], [charmander()]);
  const poll = await app.inject({ method: "GET", url: `/battles/${sessionId}?uuid=uuid-a` });
  const view = poll.json();
  assert.deepEqual(
    view.you.activeMoves.map((m: { moveSlug: string }) => m.moveSlug),
    ["tackle", "growl"],
  );
  assert.equal(view.you.activeMoves[0].pp, view.you.activeMoves[0].maxPP, "unused move starts at full PP");
  assert.equal(view.you.activeMoves[0].disabled, false);
});

test("you.activeMoves marks a Disabled slot, and drops PP as it's used — not derivable from the submitted roster alone", async () => {
  const app = buildApp();
  const { sessionId } = await createAndJoin(app, [bulbasaur(["tackle", "growl"])], [squirtle(["disable", "tackle"])]);
  // Turn 1: both attack, so squirtle's Disable (turn 2) has a real "target's most-recently-used move" to lock.
  await app.inject({ method: "POST", url: `/battles/${sessionId}/choose`, payload: { uuid: "uuid-a", choice: "move 1" } });
  await app.inject({ method: "POST", url: `/battles/${sessionId}/choose`, payload: { uuid: "uuid-b", choice: "move 2" } });
  // Turn 2: squirtle disables bulbasaur's tackle.
  await app.inject({ method: "POST", url: `/battles/${sessionId}/choose`, payload: { uuid: "uuid-a", choice: "move 1" } });
  const res = await app.inject({ method: "POST", url: `/battles/${sessionId}/choose`, payload: { uuid: "uuid-b", choice: "move 1" } });
  const bView = res.json();
  assert.equal(bView.turn, 3);
  const aPoll = await app.inject({ method: "GET", url: `/battles/${sessionId}?uuid=uuid-a` });
  const aView = aPoll.json();
  const tackle = aView.you.activeMoves.find((m: { moveSlug: string }) => m.moveSlug === "tackle");
  assert.equal(tackle.disabled, true, "tackle was just Disabled by squirtle");
  assert.ok(tackle.pp < tackle.maxPP, "tackle was used twice, PP should reflect that");
});

test("a resolved turn's log has no |split| markers and no doubled switch/damage lines", async () => {
  // @pkmn/sim writes `|split|pN` followed by the same event twice — once with the full detail
  // only pN's own client should see, once redacted for everyone else — expecting the receiving
  // client to pick one and drop the other. `battleView` now does that picking server-side (see its
  // `extractChannelMessages` call); left undone, a viewer's log carried the raw `|split|` marker
  // line plus both copies of every switch/damage line verbatim.
  const app = buildApp();
  const { sessionId } = await createAndJoin(app, [bulbasaur()], [charmander()]);
  const res = await app.inject({ method: "POST", url: `/battles/${sessionId}/choose`, payload: { uuid: "uuid-a", choice: "move 1" } });
  await app.inject({ method: "POST", url: `/battles/${sessionId}/choose`, payload: { uuid: "uuid-b", choice: "move 1" } });
  const pollA = await app.inject({ method: "GET", url: `/battles/${sessionId}?uuid=uuid-a` });
  const log: string[] = pollA.json().log;
  assert.ok(!log.some((line) => line.startsWith("|split|")), "split markers should be resolved away, not shown");
  const switchLines = log.filter((line) => line.startsWith("|switch|p1a"));
  assert.equal(switchLines.length, 1, "the initial send-out shouldn't appear twice");
  const damageLines = log.filter((line) => line.startsWith("|-damage|p1a"));
  assert.equal(damageLines.length, 1, "the hit this side's own mon took shouldn't appear twice");
});

test("voluntary switch changes the active mon without a faint", async () => {
  const app = buildApp();
  const { sessionId } = await createAndJoin(app, [bulbasaur(), squirtle()], [charmander()]);
  await app.inject({ method: "POST", url: `/battles/${sessionId}/choose`, payload: { uuid: "uuid-a", choice: "switch 2" } });
  await app.inject({ method: "POST", url: `/battles/${sessionId}/choose`, payload: { uuid: "uuid-b", choice: "move 1" } });

  const pollA = await app.inject({ method: "GET", url: `/battles/${sessionId}?uuid=uuid-a` });
  const body = pollA.json();
  assert.equal(body.you.activeIndex, 1);
  assert.equal(body.you.roster[1].speciesID, 7);
  assert.equal(body.you.roster[0].speciesID, 1, "roster order stays stable across a switch, not reshuffled");
});

test("switching back to an earlier roster slot still resolves correctly after a prior switch", async () => {
  // [Regression] @pkmn/sim reorders `side.pokemon` on every switch (the active mon moves to
  // slot 0) — a client that always sends its *stable* roster index (what `you.roster[i]` shows,
  // unaffected by that reordering) silently targets the wrong mon, or the active mon itself
  // (always rejected), the instant the target's stable index is *before* whichever mon is
  // currently active. Reported live as "I can't switch to my slot 0 Venusaur [after switching to
  // Mewtwo, roster slot 1] / works fine for slot 2 Blastoise" — Blastoise's stable slot happened
  // to still be correct only because it was already *after* Mewtwo's original slot.
  const app = buildApp();
  const { sessionId } = await createAndJoin(app, [bulbasaur(), squirtle(), charmander()], [charizard()]);
  // Switch to squirtle (stable slot 2) — the only switch so far, so stable and live indexing still
  // coincide here; this alone wouldn't have caught the bug.
  await app.inject({ method: "POST", url: `/battles/${sessionId}/choose`, payload: { uuid: "uuid-a", choice: "switch 2" } });
  await app.inject({ method: "POST", url: `/battles/${sessionId}/choose`, payload: { uuid: "uuid-b", choice: "move 1" } });
  // Now switch back to bulbasaur — stable slot 1, but squirtle (the current active mon) now
  // occupies live slot 1 after the first switch moved it to the front.
  const res = await app.inject({ method: "POST", url: `/battles/${sessionId}/choose`, payload: { uuid: "uuid-a", choice: "switch 1" } });
  await app.inject({ method: "POST", url: `/battles/${sessionId}/choose`, payload: { uuid: "uuid-b", choice: "move 1" } });
  assert.equal(res.statusCode, 200, "a stable-slot-1 switch should be accepted, not rejected by the engine");
  const body = res.json();
  assert.equal(body.you.activeIndex, 0, "back to bulbasaur (stable slot 0), not left on squirtle or rejected");
  assert.equal(body.you.roster[0].speciesID, 1, "bulbasaur");
});

test("a faint forces a switch: pendingChoice flips to 'switch' and the client can resolve it", async () => {
  const app = buildApp();
  const { sessionId } = await createAndJoin(app, [bulbasaur(), squirtle()], [charizard()]);
  await app.inject({ method: "POST", url: `/battles/${sessionId}/choose`, payload: { uuid: "uuid-a", choice: "move 1" } });
  await app.inject({ method: "POST", url: `/battles/${sessionId}/choose`, payload: { uuid: "uuid-b", choice: "move 1" } });

  const poll = await app.inject({ method: "GET", url: `/battles/${sessionId}?uuid=uuid-a` });
  const pollBody = poll.json();
  assert.equal(pollBody.pendingChoice, "switch");
  assert.equal(pollBody.you.roster[0].fainted, true);

  const res = await app.inject({ method: "POST", url: `/battles/${sessionId}/choose`, payload: { uuid: "uuid-a", choice: "switch 2" } });
  const body = res.json();
  assert.equal(body.you.activeIndex, 1);
  assert.equal(body.you.roster[1].fainted, false);
});

test("a whole roster fainting ends the battle with a win/loss result on each side", async () => {
  const app = buildApp();
  const { sessionId } = await createAndJoin(app, [bulbasaur()], [charizard()]);
  await app.inject({ method: "POST", url: `/battles/${sessionId}/choose`, payload: { uuid: "uuid-a", choice: "move 1" } });
  const resB = await app.inject({ method: "POST", url: `/battles/${sessionId}/choose`, payload: { uuid: "uuid-b", choice: "move 1" } });
  assert.equal(resB.json().status, "completed");
  assert.equal(resB.json().result, "win");

  const pollA = await app.inject({ method: "GET", url: `/battles/${sessionId}?uuid=uuid-a` });
  assert.equal(pollA.json().status, "completed");
  assert.equal(pollA.json().result, "loss");
});

test("an open battle is listed for browsing before a join, and drops off after", async () => {
  // The store's open-lobby index is a process/instance-wide singleton (module-level, shared by
  // every test in this run), so assert on presence of this test's own session rather than an
  // exact listing — other tests' sessions may legitimately still be in there too.
  const app = buildApp();
  const create = await app.inject({
    method: "POST",
    url: "/battles",
    payload: { uuid: "uuid-open-a", displayName: "Waiting", party: [bulbasaur(), squirtle()] },
  });
  const { sessionId } = create.json();

  const beforeJoin = await app.inject({ method: "GET", url: "/battles/open" });
  const before = beforeJoin.json().battles as { sessionId: string; displayName: string; rosterSize: number }[];
  const entry = before.find((b) => b.sessionId === sessionId);
  assert.ok(entry, "the just-created session should be in the open list");
  assert.equal(entry!.displayName, "Waiting");
  assert.equal(entry!.rosterSize, 2);

  await app.inject({
    method: "POST",
    url: `/battles/${sessionId}/join`,
    payload: { uuid: "uuid-open-b", displayName: "Joiner", party: [charmander()] },
  });

  const afterJoin = await app.inject({ method: "GET", url: "/battles/open" });
  const after = afterJoin.json().battles as { sessionId: string }[];
  assert.ok(!after.some((b) => b.sessionId === sessionId), "a joined session should no longer be listed as open");
});

test("concurrent choose calls from both sides don't clobber each other", async () => {
  // The whole reason the session store splits into a separate atomically-appendable log (see
  // sessionStore.ts) instead of one read-modify-write JSON blob: both players routinely submit
  // their turn's choice around the same moment, and a naive read-modify-write would silently drop
  // whichever side's write lost the race, leaving the battle stuck waiting for a choice it
  // actually already received.
  const app = buildApp();
  const { sessionId } = await createAndJoin(app, [bulbasaur()], [charmander()]);
  await Promise.all([
    app.inject({ method: "POST", url: `/battles/${sessionId}/choose`, payload: { uuid: "uuid-a", choice: "move 1" } }),
    app.inject({ method: "POST", url: `/battles/${sessionId}/choose`, payload: { uuid: "uuid-b", choice: "move 1" } }),
  ]);
  const poll = await app.inject({ method: "GET", url: `/battles/${sessionId}?uuid=uuid-a` });
  assert.equal(poll.json().turn, 2, "both sides' choices should have been recorded, resolving turn 1");
});

test("rejects an empty or oversized roster", async () => {
  const app = buildApp();
  const empty = await app.inject({ method: "POST", url: "/battles", payload: { uuid: "u", displayName: "X", party: [] } });
  assert.equal(empty.statusCode, 400);
  const oversized = await app.inject({
    method: "POST",
    url: "/battles",
    payload: { uuid: "u", displayName: "X", party: Array.from({ length: 7 }, () => bulbasaur()) },
  });
  assert.equal(oversized.statusCode, 400);
});

test("rejects a roster referencing a species with no @pkmn/dex entry", async () => {
  const app = buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/battles",
    payload: { uuid: "u", displayName: "X", party: [{ ...bulbasaur(), speciesID: 999999 }] },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /unknown species/);
});

test("a second player can't join with the creator's own uuid, or join twice", async () => {
  const app = buildApp();
  const create = await app.inject({ method: "POST", url: "/battles", payload: { uuid: "uuid-a", displayName: "Ash", party: [bulbasaur()] } });
  const { sessionId } = create.json();

  const selfJoin = await app.inject({ method: "POST", url: `/battles/${sessionId}/join`, payload: { uuid: "uuid-a", displayName: "Ash2", party: [charmander()] } });
  assert.equal(selfJoin.statusCode, 409);

  await app.inject({ method: "POST", url: `/battles/${sessionId}/join`, payload: { uuid: "uuid-b", displayName: "Gary", party: [charmander()] } });
  const secondJoin = await app.inject({ method: "POST", url: `/battles/${sessionId}/join`, payload: { uuid: "uuid-c", displayName: "Misty", party: [squirtle()] } });
  assert.equal(secondJoin.statusCode, 409);
});

test("a non-participant can't poll or submit a choice", async () => {
  const app = buildApp();
  const { sessionId } = await createAndJoin(app, [bulbasaur()], [charmander()]);
  const poll = await app.inject({ method: "GET", url: `/battles/${sessionId}?uuid=stranger` });
  assert.equal(poll.statusCode, 403);
  const choose = await app.inject({ method: "POST", url: `/battles/${sessionId}/choose`, payload: { uuid: "stranger", choice: "move 1" } });
  assert.equal(choose.statusCode, 403);
});

test("leaving before an opponent joins fully removes the session", async () => {
  const app = buildApp();
  const create = await app.inject({
    method: "POST",
    url: "/battles",
    payload: { uuid: "uuid-a", displayName: "Ash", party: [bulbasaur()] },
  });
  const { sessionId } = create.json();

  const openBefore = await app.inject({ method: "GET", url: "/battles/open" });
  assert.ok(openBefore.json().battles.some((b: { sessionId: string }) => b.sessionId === sessionId));

  const leave = await app.inject({ method: "POST", url: `/battles/${sessionId}/leave`, payload: { uuid: "uuid-a" } });
  assert.equal(leave.statusCode, 200);
  assert.equal(leave.json().status, "removed");

  const poll = await app.inject({ method: "GET", url: `/battles/${sessionId}?uuid=uuid-a` });
  assert.equal(poll.statusCode, 404);

  const openAfter = await app.inject({ method: "GET", url: "/battles/open" });
  assert.ok(!openAfter.json().battles.some((b: { sessionId: string }) => b.sessionId === sessionId));
});

test("leaving mid-battle forfeits: the leaver sees a loss, the opponent sees a win", async () => {
  const app = buildApp();
  const { sessionId } = await createAndJoin(app, [bulbasaur()], [charmander()]);

  const leave = await app.inject({ method: "POST", url: `/battles/${sessionId}/leave`, payload: { uuid: "uuid-a" } });
  assert.equal(leave.statusCode, 200);
  assert.equal(leave.json().status, "forfeited");

  const leaverPoll = await app.inject({ method: "GET", url: `/battles/${sessionId}?uuid=uuid-a` });
  assert.equal(leaverPoll.json().status, "completed");
  assert.equal(leaverPoll.json().result, "loss");

  const opponentPoll = await app.inject({ method: "GET", url: `/battles/${sessionId}?uuid=uuid-b` });
  assert.equal(opponentPoll.json().status, "completed");
  assert.equal(opponentPoll.json().result, "win");
});

test("choosing a move after a forfeit is rejected", async () => {
  const app = buildApp();
  const { sessionId } = await createAndJoin(app, [bulbasaur()], [charmander()]);
  await app.inject({ method: "POST", url: `/battles/${sessionId}/leave`, payload: { uuid: "uuid-a" } });

  const choose = await app.inject({ method: "POST", url: `/battles/${sessionId}/choose`, payload: { uuid: "uuid-b", choice: "move 1" } });
  assert.equal(choose.statusCode, 409);
});

test("a non-participant cannot leave someone else's battle", async () => {
  const app = buildApp();
  const { sessionId } = await createAndJoin(app, [bulbasaur()], [charmander()]);
  const leave = await app.inject({ method: "POST", url: `/battles/${sessionId}/leave`, payload: { uuid: "stranger" } });
  assert.equal(leave.statusCode, 403);
});

test("on Vercel, refuses to create a battle unless Redis is configured", async () => {
  // Whether this environment has real Redis credentials (a local .env with Upstash creds, say)
  // determines which branch is actually exercised here — checked against the same flag the route
  // itself reads, rather than assuming "no Redis" the way a CI/sandboxed run would have it.
  const app = buildApp();
  process.env.VERCEL = "1";
  try {
    const res = await app.inject({ method: "POST", url: "/battles", payload: { uuid: "u", displayName: "X", party: [bulbasaur()] } });
    assert.equal(res.statusCode, redisConfigured ? 200 : 501);
  } finally {
    delete process.env.VERCEL;
  }
});
