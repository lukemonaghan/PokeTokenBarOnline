import Fastify from "fastify";

const GIT_SHA = process.env.GIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "unknown";

const HOMEPAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PokeTokenBarOnline</title>
<style>
  body { font: 16px/1.5 -apple-system, system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; color: #1a1a1a; }
  code { background: #f0f0f0; padding: 0.15em 0.4em; border-radius: 4px; }
  footer { margin-top: 3rem; color: #666; font-size: 0.85em; }
  a { color: #d63333; }
</style>
</head>
<body>
<h1>PokeTokenBarOnline</h1>
<p>
  Optional, self-hostable backend for
  <a href="https://github.com/lukemonaghan/PokeTokenBar">PokeTokenBar</a>,
  a macOS menu bar app that turns AI-coding token usage into a Pokémon
  companion. PokeTokenBar works entirely offline by default &mdash; this
  server adds trading companions with friends via an invite link.
</p>
<p>
  There is no official hosted instance. This is one self-hosted deployment;
  anyone can run their own from the
  <a href="https://github.com/lukemonaghan/PokeTokenBarOnline">source</a>.
</p>
<h2>Using this server</h2>
<p>
  In PokeTokenBar, go to <strong>Settings &rarr; Online</strong> and enter
  this server's URL, the same way you'd point a game client at a server IP.
</p>
<p>Health check: <a href="/health"><code>/health</code></a></p>
<footer>Build <code>${GIT_SHA.slice(0, 7)}</code></footer>
</body>
</html>`;

export function buildApp() {
  const app = Fastify({ logger: true });

  app.get("/", async (_req, reply) => reply.type("text/html").send(HOMEPAGE));
  app.get("/health", async () => ({ status: "ok" }));

  return app;
}
