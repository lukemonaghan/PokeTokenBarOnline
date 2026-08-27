import { Redis } from "@upstash/redis";

/** Same precedence `Redis.fromEnv()` uses internally — checked here too so we can detect "is
 * Redis configured" without constructing a client first (`fromEnv()` never throws on missing
 * vars, it just warns and builds a client that fails at request time). Vercel's Upstash
 * Marketplace integration injects one of these two pairs depending on how it was provisioned. */
const hasRedisCreds = Boolean(
  (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL) &&
  (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN),
);

/** `SESSION_STORE` lets a caller override the auto-detected backend — `npm test` sets `memory` so
 * local/CI runs stay fast and network-free even with real credentials sitting in `.env`; `npm run
 * test:integration` sets `redis` so it fails loudly on missing credentials instead of silently
 * downgrading to memory and reporting green for a check it didn't actually run. Unset (normal dev,
 * production) keeps today's auto-detect: Redis if configured, memory otherwise. */
const requestedStore = process.env.SESSION_STORE;
if (requestedStore === "redis" && !hasRedisCreds) {
  throw new Error(
    "SESSION_STORE=redis was requested but no Upstash credentials were found " +
    "(UPSTASH_REDIS_REST_URL/TOKEN or KV_REST_API_URL/TOKEN) — see PokeTokenBarOnline/README.md",
  );
}

export const redisConfigured = requestedStore === "memory" ? false : requestedStore === "redis" ? true : hasRedisCreds;

const redisClient = redisConfigured ? Redis.fromEnv() : undefined;

/**
 * Split into `meta` (roster + PRNG seed) and `log` (each side's turn choices) because they have
 * different concurrency needs. `meta` is written once at create and once at join — never
 * contended. `log` is appended once per `/choose` call from *either* side, and both players
 * routinely submit around the same moment — that's the normal case for a turn-based battle, not
 * an edge case — so a naive read-modify-write over one JSON blob would silently drop whichever
 * side's choice lost the race. `appendLog` is a real atomic append instead.
 */
export interface SessionStore<Meta> {
  loadMeta(id: string): Promise<Meta | undefined>;
  saveMeta(id: string, meta: Meta, ttlMs: number): Promise<void>;
  appendLog(id: string, entry: string, ttlMs: number): Promise<void>;
  loadLog(id: string): Promise<string[]>;
}

/** Self-host/dev/test default — same in-process behavior this app always had, just behind the
 * same async interface as the Redis backend so callers don't care which one they got. */
class MemoryStore<Meta> implements SessionStore<Meta> {
  private readonly meta = new Map<string, { value: Meta; expiresAt: number }>();
  private readonly log = new Map<string, string[]>();

  async loadMeta(id: string): Promise<Meta | undefined> {
    const entry = this.meta.get(id);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.meta.delete(id);
      this.log.delete(id);
      return undefined;
    }
    return entry.value;
  }

  async saveMeta(id: string, value: Meta, ttlMs: number): Promise<void> {
    this.meta.set(id, { value, expiresAt: Date.now() + ttlMs });
  }

  async appendLog(id: string, entry: string, ttlMs: number): Promise<void> {
    const existing = this.meta.get(id);
    if (existing) existing.expiresAt = Date.now() + ttlMs; // slide TTL alongside the log entry
    const entries = this.log.get(id) ?? [];
    entries.push(entry);
    this.log.set(id, entries);
  }

  async loadLog(id: string): Promise<string[]> {
    return this.log.get(id) ?? [];
  }
}

/** Shared, reachable from every Vercel instance — this is what actually fixes the multi-instance
 * problem in-memory sessions can't survive there. */
class RedisStore<Meta> implements SessionStore<Meta> {
  constructor(private readonly redis: Redis, private readonly prefix: string) {}

  private metaKey(id: string): string { return `${this.prefix}${id}:meta`; }
  private logKey(id: string): string { return `${this.prefix}${id}:log`; }

  async loadMeta(id: string): Promise<Meta | undefined> {
    const value = await this.redis.get<Meta>(this.metaKey(id));
    return value ?? undefined;
  }

  async saveMeta(id: string, value: Meta, ttlMs: number): Promise<void> {
    await this.redis.set(this.metaKey(id), value, { px: ttlMs });
  }

  async appendLog(id: string, entry: string, ttlMs: number): Promise<void> {
    // RPUSH is atomic — safe when both sides submit their choice around the same moment.
    await this.redis.rpush(this.logKey(id), entry);
    await this.redis.pexpire(this.logKey(id), ttlMs);
    await this.redis.pexpire(this.metaKey(id), ttlMs); // slide both keys' TTL together
  }

  async loadLog(id: string): Promise<string[]> {
    return this.redis.lrange<string>(this.logKey(id), 0, -1);
  }
}

export function createSessionStore<Meta>(keyPrefix: string): SessionStore<Meta> {
  return redisClient ? new RedisStore<Meta>(redisClient, keyPrefix) : new MemoryStore<Meta>();
}
