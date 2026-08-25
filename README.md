# PokeTokenBarOnline

Optional, self-hostable backend for [PokeTokenBar](https://github.com/lukemonaghan/PokeTokenBar):
adds trading companions with friends via an invite link (and later,
battles). PokeTokenBar works entirely offline by default; pointing it at a
server here is opt-in.

There is no official hosted instance. Anyone can run their own: point the
app's Settings → Online at your server's domain, the same way you'd point a
game client at a server IP.

## Status

**M0** (health check, Settings → Online ping) and **M1** (trading) are
shipped. See [`PLAN.md`](./PLAN.md) for the full design, including Phase 2
(battles, not started).

## How trading works

The app owns all game logic (species, stats, evolution, ownership); this
server only pairs two clients and relays whatever they hand it. It's a
**broker, not a system of record**: no accounts, no database, no ownership
ledger. Everything it knows about a trade lives in memory for as long as
the trade takes, then it forgets.

1. **Create.** Client A picks a Pokémon it owns to offer and
   `POST /trades` with it, plus a locally-generated UUID and display name
   (not an account, just enough to tell two participants apart). The server
   opens an in-memory session and hands back a session id.
2. **Share.** That becomes `https://<server>/t/<sessionId>`, a landing
   page with a button that opens the app via
   `poketokenbar://trade?server=<server>&session=<sessionId>`. Share it any
   way you'd share a link; the app can also join from the session id/link
   pasted in directly if the OS can't route the deep link (e.g. no locally
   registered handler).
3. **Join.** Client B opens the link (or pastes it in) and offers one of
   its own Pokémon back via `POST /trades/:id/join`.
4. **Preview.** Once both sides have offered, `GET /trades/:id?uuid=<mine>`
   reveals the counterpart's Pokémon to both, so each side sees what it's
   getting before committing.
5. **Confirm.** Each client `POST`s `/trades/:id/confirm`. Once *both* have
   confirmed, status flips to `"completed"` and stays that way on every
   later poll; the server doesn't track "already delivered," so applying
   the result exactly once (remove mine, add theirs) is the client's job,
   done idempotently in case a stray poll lands after the fact.
6. **Expiry.** An unconfirmed session drops out of memory after ~10
   minutes (checked lazily on access, no background timer); ask your
   friend for a new link if it went stale.

**Trust model.** Whoever holds the right `uuid` for a session can act as
that side of it; that's the entire authentication story, deliberately, to
avoid needing accounts for something this low-stakes. The server never
interprets the Pokémon payload (opaque JSON in, opaque JSON out), so the
client's save format can change without a server release.

## API

| Method | Path                 | Purpose                                              |
|--------|----------------------|-------------------------------------------------------|
| GET    | `/health`            | Liveness check (what Settings → Online pings).        |
| POST   | `/trades`            | Create a session, offering a Pokémon. Returns `sessionId`. |
| POST   | `/trades/:id/join`   | Join an open session, offering a Pokémon back.        |
| GET    | `/trades/:id?uuid=`  | Poll status (`open`/`offered`/`completed`) + the counterpart's offer once both sides are in. |
| POST   | `/trades/:id/confirm`| Confirm your side. Requires `uuid` in the body.       |
| GET    | `/t/:id`             | Human-facing landing page for a shared invite link.   |
| GET    | `/docs`              | Rendered API reference with handshake sequence diagrams. |

## Stack

Node.js + TypeScript + Fastify. Stateless, no database. Ships as a single
Docker container.

## Running

Self-hosted (Docker):

```
docker build -t poketokenbaronline .
docker run -p 3000:3000 poketokenbaronline
```

Vercel: connect the repo (or `vercel deploy`). `api/index.ts` wraps the same
Fastify app as a serverless function, and `vercel.json` rewrites all paths to
it so routes match the self-hosted server. `public/` is an empty placeholder
directory; Vercel's zero-config build expects a static output dir to exist
even for a functions-only project, but nothing is actually served from it.

**Known limitation on Vercel**: trade sessions live in one process's
memory. If your deployment scales to multiple concurrent instances, a
`create` and a later `join` aren't guaranteed to land on the same warm
instance, and the trade would silently never pair up. Fine for casual use
and for the homepage/health check regardless; if you want trading to be
reliable under real load, self-host as a single long-lived process (Docker,
a small VPS) instead.

**Battles need either self-hosting or Redis.** Same in-memory-session
limitation as trading, but a battle session lives for dozens of
polls/choices over several minutes instead of trading's ~4-request
handshake — far more chances to land on the wrong instance, and losing
mid-battle is worse than losing mid-handshake (a real fight several turns
deep just vanishes). Two ways to make it work:

- **Self-host** (Docker, a small VPS) — the original in-memory approach is
  fine as long as it's one process.
- **On Vercel, add the [Upstash Redis](https://vercel.com/marketplace/upstash)
  Marketplace integration** and connect it to this project. Battle session
  state (roster, PRNG seed, each side's turn choices) then lives in Redis
  instead of process memory, reachable from every instance. The `Battle`
  engine object itself is never stored — it's cheaply rebuilt on every
  request by replaying the stored choices against a fresh instance seeded
  identically (`@pkmn/sim` is deterministic given the same seed + inputs),
  so there's nothing large or hard-to-serialize going over the wire.
  Upstash's free tier (500K commands/month, no card required) comfortably
  covers casual use — see `src/sessionStore.ts`.

Without either, `POST /battles` refuses with `501` on Vercel rather than
let a battle silently vanish mid-fight.
