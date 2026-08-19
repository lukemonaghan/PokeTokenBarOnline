import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";

export interface Offer {
  uuid: string;
  displayName: string;
  pokemon: Record<string, unknown>;
}

interface Session {
  a: Offer;
  b?: Offer;
  confirmedBy: Set<string>;
  createdAt: number;
}

const TTL_MS = 10 * 60 * 1000;
const sessions = new Map<string, Session>();

function isOffer(body: unknown): body is Offer {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.uuid === "string" && b.uuid.length > 0 &&
    typeof b.displayName === "string" && b.displayName.length > 0 && b.displayName.length <= 60 &&
    typeof b.pokemon === "object" && b.pokemon !== null && !Array.isArray(b.pokemon)
  );
}

/** Lazy expiry-on-access — no background timer (a timer in one Vercel instance can't clean up
 * sessions living in another instance's memory anyway, so on-access is strictly no worse). */
export function getSession(id: string): Session | undefined {
  const session = sessions.get(id);
  if (!session) return undefined;
  if (Date.now() - session.createdAt > TTL_MS) {
    sessions.delete(id);
    return undefined;
  }
  return session;
}

function status(session: Session): "open" | "offered" | "completed" {
  if (!session.b) return "open";
  if (session.confirmedBy.size >= 2) return "completed";
  return "offered";
}

export function registerTradeRoutes(app: FastifyInstance): void {
  app.post("/trades", async (req, reply) => {
    if (!isOffer(req.body)) return reply.code(400).send({ error: "invalid offer" });
    const id = randomUUID();
    sessions.set(id, { a: req.body, confirmedBy: new Set(), createdAt: Date.now() });
    return { sessionId: id };
  });

  app.post("/trades/:id/join", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = getSession(id);
    if (!session) return reply.code(404).send({ error: "not found" });
    if (!isOffer(req.body)) return reply.code(400).send({ error: "invalid offer" });
    if (session.b || req.body.uuid === session.a.uuid) {
      return reply.code(409).send({ error: "cannot join" });
    }
    session.b = req.body;
    return { status: status(session) };
  });

  app.get("/trades/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { uuid } = req.query as { uuid?: string };
    const session = getSession(id);
    if (!session) return reply.code(404).send({ error: "not found" });
    if (!uuid) return reply.code(400).send({ error: "uuid required" });
    if (uuid !== session.a.uuid && uuid !== session.b?.uuid) {
      return reply.code(403).send({ error: "not a participant" });
    }
    const counterpart = session.b
      ? uuid === session.a.uuid
        ? { displayName: session.b.displayName, pokemon: session.b.pokemon }
        : { displayName: session.a.displayName, pokemon: session.a.pokemon }
      : null;
    return { status: status(session), counterpart };
  });

  app.post("/trades/:id/confirm", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { uuid } = (req.body ?? {}) as { uuid?: string };
    const session = getSession(id);
    if (!session) return reply.code(404).send({ error: "not found" });
    if (!uuid || (uuid !== session.a.uuid && uuid !== session.b?.uuid)) {
      return reply.code(403).send({ error: "not a participant" });
    }
    if (status(session) !== "offered") return reply.code(409).send({ error: "not ready to confirm" });
    session.confirmedBy.add(uuid);
    return { status: status(session) };
  });
}
