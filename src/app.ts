import Fastify from "fastify";
import { registerTradeRoutes, getSession } from "./trades.js";

const GIT_SHA = process.env.GIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "unknown";

// A Poké Ball, inline — served as SVG rather than shipping a binary .ico. Browsers pick the icon
// format from the response's Content-Type, not the file extension, so an SVG at /favicon.ico works
// the same as one at /favicon.svg.
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<circle cx="32" cy="32" r="30" fill="#fff" stroke="#1a1a1a" stroke-width="3"/>
<path d="M2 32a30 30 0 0 1 60 0z" fill="#d63333" stroke="#1a1a1a" stroke-width="3"/>
<rect x="2" y="29" width="60" height="6" fill="#1a1a1a"/>
<circle cx="32" cy="32" r="9" fill="#fff" stroke="#1a1a1a" stroke-width="3"/>
<circle cx="32" cy="32" r="4" fill="#1a1a1a"/>
</svg>`;

const HOMEPAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PokeTokenBarOnline</title>
<link rel="icon" href="/favicon.ico" type="image/svg+xml">
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

function tradeLandingPage(opts: { found: true; deepLink: string; origin: string } | { found: false }): string {
  const body = opts.found
    ? `<h1>Trade invite</h1>
<p><a href="${opts.deepLink}" style="display:inline-block;padding:0.75rem 1.5rem;background:#d63333;color:#fff;
   border-radius:8px;text-decoration:none;font-weight:600;">Open in PokeTokenBar</a></p>
<p>Don't have the app? Open PokeTokenBar &rarr; Settings &rarr; Online, point it at
   <code>${opts.origin}</code>, then reopen this link.</p>`
    : `<h1>Trade invite expired</h1>
<p>This trade link has expired or doesn't exist. Ask your friend for a new one.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PokeTokenBarOnline — Trade</title>
<link rel="icon" href="/favicon.ico" type="image/svg+xml">
<style>
  body { font: 16px/1.5 -apple-system, system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; color: #1a1a1a; text-align: center; }
  code { background: #f0f0f0; padding: 0.15em 0.4em; border-radius: 4px; }
</style>
</head>
<body>${body}</body>
</html>`;
}

export function buildApp() {
  // trustProxy — Vercel and most self-hosted reverse-proxy setups terminate TLS in front of this
  // process, so the raw connection looks like plain HTTP. Without this, req.protocol always reports
  // "http" even in production, and the trade landing page would embed the wrong scheme in the
  // server origin it hands back to the client.
  const app = Fastify({ logger: true, trustProxy: true });

  app.get("/", async (_req, reply) => reply.type("text/html").send(HOMEPAGE));
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/favicon.ico", async (_req, reply) =>
    reply.type("image/svg+xml").header("cache-control", "public, max-age=86400").send(FAVICON));

  registerTradeRoutes(app);

  // Human-facing landing page for a shared trade link — opens the app via the poketokenbar:// scheme.
  // No forced auto-redirect: it either fails silently or shows a contextless OS dialog when the app
  // isn't installed, and hides the fallback instructions. A plain button works either way.
  app.get("/t/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    reply.type("text/html");
    if (!getSession(id)) return reply.code(404).send(tradeLandingPage({ found: false }));
    const origin = `${req.protocol}://${req.headers.host}`;
    const deepLink = `poketokenbar://trade?server=${encodeURIComponent(origin)}&session=${encodeURIComponent(id)}`;
    return tradeLandingPage({ found: true, deepLink, origin });
  });

  return app;
}
