# PokeTokenBarOnline

Optional, self-hostable backend for [PokeTokenBar](https://github.com/lukemonaghan/PokeTokenBar) —
adds trading companions with friends via an invite link (and later,
battles). PokeTokenBar works entirely offline by default; pointing it at a
server here is opt-in.

There is no official hosted instance. Anyone can run their own — point the
app's Settings → Online at your server's domain, the same way you'd point a
game client at a server IP.

## Status

Pre-implementation. See the project's plan doc (not checked into this repo)
for the design.

## Stack

Node.js + TypeScript + Fastify. Stateless — no database. Ships as a single
Docker container.

## Running

Self-hosted (Docker):

```
docker build -t poketokenbaronline .
docker run -p 3000:3000 poketokenbaronline
```

Vercel: connect the repo (or `vercel deploy`) — `api/index.ts` wraps the same
Fastify app as a serverless function, and `vercel.json` rewrites all paths to
it so routes match the self-hosted server. `public/` is an empty placeholder
directory — Vercel's zero-config build expects a static output dir to exist
even for a functions-only project; nothing is actually served from it.
