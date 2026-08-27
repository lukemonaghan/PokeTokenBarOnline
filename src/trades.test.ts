import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./app.js";

// Same approach as battles.test.ts: node:test + Fastify's .inject(), no extra test framework.

const bulbasaurBlob = { species: "bulbasaur", level: 5 };
const charmanderBlob = { species: "charmander", level: 5 };

async function create(app: ReturnType<typeof buildApp>, uuid: string, displayName: string, pokemon: object) {
  const res = await app.inject({ method: "POST", url: "/trades", payload: { uuid, displayName, pokemon } });
  return res.json().sessionId as string;
}

test("create + join moves a trade to offered, with each side seeing the other's offer", async () => {
  const app = buildApp();
  const sessionId = await create(app, "uuid-a", "Ash", bulbasaurBlob);
  const join = await app.inject({
    method: "POST",
    url: `/trades/${sessionId}/join`,
    payload: { uuid: "uuid-b", displayName: "Gary", pokemon: charmanderBlob },
  });
  assert.equal(join.json().status, "offered");

  const pollA = await app.inject({ method: "GET", url: `/trades/${sessionId}?uuid=uuid-a` });
  assert.deepEqual(pollA.json().counterpart, { displayName: "Gary", pokemon: charmanderBlob });

  const pollB = await app.inject({ method: "GET", url: `/trades/${sessionId}?uuid=uuid-b` });
  assert.deepEqual(pollB.json().counterpart, { displayName: "Ash", pokemon: bulbasaurBlob });
});

test("completes only once both sides confirm, and stays completed on a later poll", async () => {
  const app = buildApp();
  const sessionId = await create(app, "uuid-a", "Ash", bulbasaurBlob);
  await app.inject({ method: "POST", url: `/trades/${sessionId}/join`, payload: { uuid: "uuid-b", displayName: "Gary", pokemon: charmanderBlob } });

  const confirmA = await app.inject({ method: "POST", url: `/trades/${sessionId}/confirm`, payload: { uuid: "uuid-a" } });
  assert.equal(confirmA.json().status, "offered", "not completed until both sides confirm");

  const confirmB = await app.inject({ method: "POST", url: `/trades/${sessionId}/confirm`, payload: { uuid: "uuid-b" } });
  assert.equal(confirmB.json().status, "completed");

  const laterPoll = await app.inject({ method: "GET", url: `/trades/${sessionId}?uuid=uuid-a` });
  assert.equal(laterPoll.json().status, "completed", "completed is stable across later polls");
});

test("both sides confirming at once still both land (no lost update)", async () => {
  const app = buildApp();
  const sessionId = await create(app, "uuid-a", "Ash", bulbasaurBlob);
  await app.inject({ method: "POST", url: `/trades/${sessionId}/join`, payload: { uuid: "uuid-b", displayName: "Gary", pokemon: charmanderBlob } });

  await Promise.all([
    app.inject({ method: "POST", url: `/trades/${sessionId}/confirm`, payload: { uuid: "uuid-a" } }),
    app.inject({ method: "POST", url: `/trades/${sessionId}/confirm`, payload: { uuid: "uuid-b" } }),
  ]);

  const poll = await app.inject({ method: "GET", url: `/trades/${sessionId}?uuid=uuid-a` });
  assert.equal(poll.json().status, "completed");
});

test("an open trade is listed for browsing before a join, and drops off after", async () => {
  // The store's open-lobby index is process/instance-wide (shared across every test in this run),
  // so assert on presence of this test's own session rather than an exact listing.
  const app = buildApp();
  const sessionId = await create(app, "uuid-open-a", "Waiting", bulbasaurBlob);

  const beforeJoin = await app.inject({ method: "GET", url: "/trades/open" });
  const before = beforeJoin.json().trades as { sessionId: string; displayName: string; pokemon: unknown }[];
  const entry = before.find((t) => t.sessionId === sessionId);
  assert.ok(entry, "the just-created trade should be in the open list");
  assert.equal(entry!.displayName, "Waiting");
  assert.deepEqual(entry!.pokemon, bulbasaurBlob);

  await app.inject({ method: "POST", url: `/trades/${sessionId}/join`, payload: { uuid: "uuid-open-b", displayName: "Joiner", pokemon: charmanderBlob } });

  const afterJoin = await app.inject({ method: "GET", url: "/trades/open" });
  const after = afterJoin.json().trades as { sessionId: string }[];
  assert.ok(!after.some((t) => t.sessionId === sessionId), "a joined trade should no longer be listed as open");
});

test("rejects a malformed offer", async () => {
  const app = buildApp();
  const res = await app.inject({ method: "POST", url: "/trades", payload: { uuid: "u", displayName: "X", pokemon: "not an object" } });
  assert.equal(res.statusCode, 400);
});

test("a second player can't join with the creator's own uuid, or join twice", async () => {
  const app = buildApp();
  const sessionId = await create(app, "uuid-a", "Ash", bulbasaurBlob);

  const selfJoin = await app.inject({ method: "POST", url: `/trades/${sessionId}/join`, payload: { uuid: "uuid-a", displayName: "Ash2", pokemon: charmanderBlob } });
  assert.equal(selfJoin.statusCode, 409);

  await app.inject({ method: "POST", url: `/trades/${sessionId}/join`, payload: { uuid: "uuid-b", displayName: "Gary", pokemon: charmanderBlob } });
  const secondJoin = await app.inject({ method: "POST", url: `/trades/${sessionId}/join`, payload: { uuid: "uuid-c", displayName: "Misty", pokemon: charmanderBlob } });
  assert.equal(secondJoin.statusCode, 409);
});

test("a non-participant can't poll or confirm", async () => {
  const app = buildApp();
  const sessionId = await create(app, "uuid-a", "Ash", bulbasaurBlob);
  await app.inject({ method: "POST", url: `/trades/${sessionId}/join`, payload: { uuid: "uuid-b", displayName: "Gary", pokemon: charmanderBlob } });

  const poll = await app.inject({ method: "GET", url: `/trades/${sessionId}?uuid=stranger` });
  assert.equal(poll.statusCode, 403);

  const confirm = await app.inject({ method: "POST", url: `/trades/${sessionId}/confirm`, payload: { uuid: "stranger" } });
  assert.equal(confirm.statusCode, 403);
});

test("confirming before both sides have offered is rejected", async () => {
  const app = buildApp();
  const sessionId = await create(app, "uuid-a", "Ash", bulbasaurBlob);
  const confirm = await app.inject({ method: "POST", url: `/trades/${sessionId}/confirm`, payload: { uuid: "uuid-a" } });
  assert.equal(confirm.statusCode, 409);
});
