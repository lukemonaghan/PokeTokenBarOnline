import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./app.js";

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

test("refuses to create a battle when running on Vercel (in-memory sessions can't survive its multi-instance scaling)", async () => {
  const app = buildApp();
  process.env.VERCEL = "1";
  try {
    const res = await app.inject({ method: "POST", url: "/battles", payload: { uuid: "u", displayName: "X", party: [bulbasaur()] } });
    assert.equal(res.statusCode, 501);
  } finally {
    delete process.env.VERCEL;
  }
});
