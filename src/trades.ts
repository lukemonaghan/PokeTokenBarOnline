import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { createSessionStore } from "./sessionStore.js";

export interface Offer {
  uuid: string;
  displayName: string;
  /** 0-6 entries, opaque to the server (see isOffer) — see trading-overhaul.md's wire format change. */
  pokemon: Record<string, unknown>[];
  /** Not opaque, unlike pokemon — validated below. Moves TradeStore's spentTokens ledger on
   * completion; the server never interprets it otherwise. */
  tokens: number;
}

interface TradeMeta {
  a: Offer;
  b?: Offer;
  createdAt: number;
}

/** Fixed window from creation (not sliding, unlike battles' — a trade's whole handshake is a
 * handful of requests, not dozens of turns, so there's no "still actively being played" case to
 * protect against a fixed deadline the way battles.md's Flow §6 reasons through for battles). */
const TTL_MS = 10 * 60 * 1000;

const store = createSessionStore<TradeMeta>("trade:");

const OPEN_INDEX_KEY = "open";
const MAX_OPEN_LISTED = 50;

function confirmedKey(id: string): string {
  return `${id}:confirmed`;
}

/** How much of the original fixed 10-minute window is left, as of now — passed as the `ttlMs` for
 * every `saveMeta`/`addToSet` call after creation so the *store's* TTL keeps counting down to the
 * same original deadline instead of resetting to a fresh 10 minutes on every join/confirm. */
function remainingTtl(createdAt: number): number {
  return Math.max(0, TTL_MS - (Date.now() - createdAt));
}

function isOffer(body: unknown): body is Offer {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  if (
    typeof b.uuid !== "string" || b.uuid.length === 0 ||
    typeof b.displayName !== "string" || b.displayName.length === 0 || b.displayName.length > 60 ||
    !Array.isArray(b.pokemon) || b.pokemon.length > 6 ||
    !b.pokemon.every((p) => typeof p === "object" && p !== null && !Array.isArray(p)) ||
    typeof b.tokens !== "number" || !Number.isInteger(b.tokens) || b.tokens < 0
  ) {
    return false;
  }
  // Nothing offered isn't a trade — mirrors displayName's "reject client-side too" rule.
  return b.pokemon.length > 0 || b.tokens > 0;
}

/** `store.loadMeta` already returns `undefined` once the TTL this session was last saved with has
 * elapsed (Redis enforces it natively; `MemoryStore` checks it on read) — nothing extra to check
 * here as long as every `saveMeta` after creation is given `remainingTtl`, not a fresh `TTL_MS`. */
export async function getSession(id: string): Promise<TradeMeta | undefined> {
  return store.loadMeta(id);
}

async function status(id: string, meta: TradeMeta): Promise<"open" | "offered" | "completed"> {
  if (!meta.b) return "open";
  const confirmedBy = await store.setMembers(confirmedKey(id));
  return confirmedBy.length >= 2 ? "completed" : "offered";
}

export function registerTradeRoutes(app: FastifyInstance): void {
  app.post("/trades", async (req, reply) => {
    if (!isOffer(req.body)) return reply.code(400).send({ error: "invalid offer" });
    const id = randomUUID();
    await store.saveMeta(id, { a: req.body, createdAt: Date.now() }, TTL_MS);
    await store.addToSet(OPEN_INDEX_KEY, id);
    return { sessionId: id };
  });

  // Lists sessions still waiting for a second player — the alternative to sharing a link. Reads
  // every open id's meta both to render the listing and to lazily prune ones whose session
  // already expired without ever being joined, same spirit as `getSession`'s lazy expiry.
  app.get("/trades/open", async () => {
    const ids = await store.setMembers(OPEN_INDEX_KEY);
    const entries: { sessionId: string; displayName: string; pokemon: Record<string, unknown>[]; tokens: number; createdAt: number }[] = [];
    for (const id of ids) {
      const meta = await store.loadMeta(id);
      if (!meta || meta.b) {
        await store.removeFromSet(OPEN_INDEX_KEY, id);
        continue;
      }
      entries.push({ sessionId: id, displayName: meta.a.displayName, pokemon: meta.a.pokemon, tokens: meta.a.tokens, createdAt: meta.createdAt });
    }
    entries.sort((a, b) => b.createdAt - a.createdAt);
    return { trades: entries.slice(0, MAX_OPEN_LISTED) };
  });

  app.post("/trades/:id/join", async (req, reply) => {
    const { id } = req.params as { id: string };
    const meta = await getSession(id);
    if (!meta) return reply.code(404).send({ error: "not found" });
    if (!isOffer(req.body)) return reply.code(400).send({ error: "invalid offer" });
    if (meta.b || req.body.uuid === meta.a.uuid) {
      return reply.code(409).send({ error: "cannot join" });
    }
    const next: TradeMeta = { a: meta.a, b: req.body, createdAt: meta.createdAt };
    await store.saveMeta(id, next, remainingTtl(meta.createdAt));
    await store.removeFromSet(OPEN_INDEX_KEY, id);
    return { status: await status(id, next) };
  });

  app.get("/trades/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { uuid } = req.query as { uuid?: string };
    const meta = await getSession(id);
    if (!meta) return reply.code(404).send({ error: "not found" });
    if (!uuid) return reply.code(400).send({ error: "uuid required" });
    if (uuid !== meta.a.uuid && uuid !== meta.b?.uuid) {
      return reply.code(403).send({ error: "not a participant" });
    }
    const counterpart = meta.b
      ? uuid === meta.a.uuid
        ? { displayName: meta.b.displayName, pokemon: meta.b.pokemon, tokens: meta.b.tokens }
        : { displayName: meta.a.displayName, pokemon: meta.a.pokemon, tokens: meta.a.tokens }
      : null;
    return { status: await status(id, meta), counterpart };
  });

  app.post("/trades/:id/confirm", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { uuid } = (req.body ?? {}) as { uuid?: string };
    const meta = await getSession(id);
    if (!meta) return reply.code(404).send({ error: "not found" });
    if (!uuid || (uuid !== meta.a.uuid && uuid !== meta.b?.uuid)) {
      return reply.code(403).send({ error: "not a participant" });
    }
    if ((await status(id, meta)) !== "offered") return reply.code(409).send({ error: "not ready to confirm" });
    // addToSet (Redis SADD) is atomic — safe when both sides hit confirm around the same moment,
    // which previewing-then-confirming makes an entirely plausible timing, not a rare edge case.
    await store.addToSet(confirmedKey(id), uuid, remainingTtl(meta.createdAt));
    return { status: await status(id, meta) };
  });

  // Lets a side that already confirmed take it back, as long as the trade hasn't actually
  // completed yet (both sides confirmed) — the client's only way to genuinely "back out" after
  // tapping Confirm, not just stop looking at the screen. Once status is "completed" this always
  // 409s: that's the trade actually going through, not a race to fix client-side.
  app.post("/trades/:id/unconfirm", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { uuid } = (req.body ?? {}) as { uuid?: string };
    const meta = await getSession(id);
    if (!meta) return reply.code(404).send({ error: "not found" });
    if (!uuid || (uuid !== meta.a.uuid && uuid !== meta.b?.uuid)) {
      return reply.code(403).send({ error: "not a participant" });
    }
    if ((await status(id, meta)) === "completed") return reply.code(409).send({ error: "already completed" });
    await store.removeFromSet(confirmedKey(id), uuid);
    return { status: await status(id, meta) };
  });
}
