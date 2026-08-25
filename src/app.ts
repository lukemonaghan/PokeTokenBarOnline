import Fastify from "fastify";
import { registerTradeRoutes, getSession } from "./trades.js";
import { registerBattleRoutes } from "./battles.js";

const GIT_SHA = process.env.GIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "unknown";

// A Poké Ball, inline: served as SVG rather than shipping a binary .ico. Browsers pick the icon
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
  ol, ul { padding-left: 1.3rem; }
  li { margin: 0.3em 0; }
</style>
</head>
<body>
<h1>PokeTokenBarOnline</h1>
<p>
  Optional, self-hostable backend for
  <a href="https://github.com/lukemonaghan/PokeTokenBar">PokeTokenBar</a>,
  a macOS menu bar app that turns AI-coding token usage into a Pokémon
  companion. PokeTokenBar works entirely offline by default. This
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
<h2>How trading works</h2>
<p>
  This server is a broker, not a system of record: no accounts, no
  database, no ownership ledger. It only pairs two clients for a few
  minutes and relays whatever they hand it.
</p>
<ol>
  <li><strong>Create.</strong> One person picks a Pokémon to offer; the app opens a session here and gets back a shareable link.</li>
  <li><strong>Share.</strong> Send the link any way you like; it opens the app directly, or can be pasted into the app's trade screen by hand.</li>
  <li><strong>Join.</strong> The other person opens (or pastes) the link and offers a Pokémon back.</li>
  <li><strong>Preview &amp; confirm.</strong> Both sides see what they're getting before committing. Once both confirm, the swap happens on both apps.</li>
  <li><strong>Expiry.</strong> An unconfirmed trade is forgotten after about 10 minutes.</li>
</ol>
<p>
  Nobody needs an account here; each app generates a random,
  non-secret id locally the first time you use Online mode, just enough to
  tell two participants apart for the session. Full protocol and API
  reference: <a href="/docs">API docs</a>.
</p>
<p>Health check: <a href="/health"><code>/health</code></a></p>
<footer>Build <code>${GIT_SHA.slice(0, 7)}</code></footer>
</body>
</html>`;

const DOCS = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PokeTokenBarOnline: API docs</title>
<link rel="icon" href="/favicon.ico" type="image/svg+xml">
<style>
  body { font: 16px/1.5 -apple-system, system-ui, sans-serif; max-width: 48rem; margin: 3rem auto; padding: 0 1rem; color: #1a1a1a; }
  code { background: #f0f0f0; padding: 0.15em 0.4em; border-radius: 4px; }
  pre { background: #f0f0f0; padding: 1rem; border-radius: 4px; overflow-x: auto; font-size: 0.85em; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  th, td { text-align: left; padding: 0.4em 0.6em; border-bottom: 1px solid #ddd; vertical-align: top; }
  a { color: #d63333; }
  h2 { margin-top: 2.5rem; }
</style>
</head>
<body>
<h1>PokeTokenBarOnline API</h1>
<p>
  This server is a trade broker, not a system of record: no accounts, no
  database, no ownership ledger. It pairs two clients for up to 10 minutes
  and relays whatever they hand it; the client owns all game logic.
  Trust model: holding the right <code>uuid</code> for a session is the
  entire authentication story &mdash; deliberately, since the stakes are low.
</p>

<h2>Endpoints</h2>
<table>
<tr><th>Method</th><th>Path</th><th>Body / query</th><th>Response</th></tr>
<tr><td>GET</td><td><code>/health</code></td><td>&mdash;</td><td><code>{ status: "ok" }</code></td></tr>
<tr><td>POST</td><td><code>/trades</code></td><td><code>{ uuid, displayName, pokemon }</code></td><td><code>{ sessionId }</code></td></tr>
<tr><td>POST</td><td><code>/trades/:id/join</code></td><td><code>{ uuid, displayName, pokemon }</code></td><td><code>{ status }</code></td></tr>
<tr><td>GET</td><td><code>/trades/:id?uuid=</code></td><td>query <code>uuid</code></td><td><code>{ status, counterpart }</code></td></tr>
<tr><td>POST</td><td><code>/trades/:id/confirm</code></td><td><code>{ uuid }</code></td><td><code>{ status }</code></td></tr>
<tr><td>GET</td><td><code>/t/:id</code></td><td>&mdash;</td><td>HTML landing page with the <code>poketokenbar://</code> deep link.</td></tr>
<tr><td>POST</td><td><code>/battles</code></td><td><code>{ uuid, displayName, party }</code></td><td><code>{ sessionId }</code></td></tr>
<tr><td>POST</td><td><code>/battles/:id/join</code></td><td><code>{ uuid, displayName, party }</code></td><td><code>{ status }</code></td></tr>
<tr><td>GET</td><td><code>/battles/:id?uuid=</code></td><td>query <code>uuid</code></td><td><code>{ status, turn, pendingChoice, you, opponent, log, result }</code></td></tr>
<tr><td>POST</td><td><code>/battles/:id/choose</code></td><td><code>{ uuid, choice }</code></td><td>same shape as the GET above</td></tr>
</table>
<p>
  <code>uuid</code> is a random id each app generates locally on first use of
  Online mode &mdash; not a login, just enough to tell two participants
  apart. <code>pokemon</code> is opaque JSON: the server never reads it, so
  the client's save format can change without a server release.
</p>

<h2>Battles</h2>
<p>
  Unlike trading, this server doesn't just relay a battle &mdash; it
  arbitrates it. <code>party</code> is 1&ndash;6 mons as verifiable
  primitives (species id, level, nature, ability, IVs, EVs, up to 4 moves),
  never a precomputed stat block; the server derives real stats and runs the
  fight itself via <a href="https://github.com/pkmn/ps"><code>@pkmn/sim</code></a>
  (Pok&eacute;mon Showdown's own battle engine), the same way it never trusts
  a client-reported result for anything that decides an outcome. Turn flow:
  each side <code>POST</code>s a <code>choice</code> (<code>"move N"</code> or
  <code>"switch N"</code>, 1-indexed into that side's own roster) once per
  turn; the server resolves the turn once both are in and both clients pick
  up the result on their next poll (or from the response to their own
  <code>choose</code> call). <code>pendingChoice</code> flips to
  <code>"switch"</code> when a fainted mon forces one. Only the opponent's
  active mon is visible in <code>opponent</code> &mdash; their bench stays
  hidden. Sessions expire after 5 minutes of no <code>choose</code> call
  (sliding, not fixed from creation, since a full team battle runs longer
  than a trade). <strong>Self-host, or add Redis</strong>: on Vercel,
  <code>POST /battles</code> refuses with <code>501</code> unless the
  Upstash Redis Marketplace integration is connected &mdash; see the main
  README's "Battles need either self-hosting or Redis" section.
</p>
<p>
  Errors are a JSON body <code>{ error: string }</code> with a matching HTTP
  status: <code>400</code> malformed offer, <code>403</code> wrong/missing
  <code>uuid</code> for the session, <code>404</code> unknown or expired
  session, <code>409</code> action doesn't fit the session's current state
  (e.g. joining a full session, confirming before both sides have offered).
</p>

<h2>Session states</h2>
<pre><code>  POST /trades
       |
       v
     open  --join--&gt;  offered  --both confirm--&gt;  completed
       |                  |
       |                  | (10 min idle, either state)
       v                  v
    (forgotten)       (forgotten)
</code></pre>

<h2>Trade handshake</h2>
<p>Full flow for two clients, A (creator) and B (joiner):</p>
<pre><code>Client A                      Server                      Client B
   |                             |                             |
   |--- POST /trades ----------->|                             |
   |    {uuid:A, pokemon}        |                             |
   |&lt;-- {sessionId} -------------|                             |
   |                             |                             |
   |--- share https://server/t/:sessionId (or deep link) ----->|
   |                             |                             |
   |                             |&lt;-- POST /trades/:id/join ---|
   |                             |    {uuid:B, pokemon}        |
   |                             |--- {status:"offered"} ----->|
   |                             |                             |
   |--- GET /trades/:id?uuid=A ->|                             |
   |&lt;-- {status, counterpart:B}--|                             |
   |                             |&lt;-- GET /trades/:id?uuid=B --|
   |                             |--- {status, counterpart:A}->|
   |          (both sides render a preview of what they'd get) |
   |                             |                             |
   |--- POST /trades/:id/confirm>|                             |
   |    {uuid:A}                 |                             |
   |&lt;-- {status:"offered"} ------|                             |
   |                             |&lt;-- POST /trades/:id/confirm-|
   |                             |    {uuid:B}                 |
   |                             |--- {status:"completed"} --->|
   |                             |                             |
   |   both apps see "completed" on their next poll and apply  |
   |   the swap locally (remove mine, add theirs), idempotently|
</code></pre>
<p>
  Confirm is a two-phase commit: it only flips to <code>completed</code> once
  <em>both</em> uuids have called <code>/confirm</code>, and stays
  <code>completed</code> on every later poll so a client that was offline
  when it happened still catches up. Applying the result is the client's
  job, done idempotently since a stray poll can land after the swap already
  happened locally.
</p>

<h2>Invite link handshake</h2>
<p>How <code>GET /t/:id</code> hands off from browser to app:</p>
<pre><code>Client A                Server                  OS / Client B's device
   |                       |                              |
   |-- POST /trades ------>|                              |
   |&lt;- {sessionId} --------|                              |
   |                       |                              |
   |  A sends link "https://server/t/:sessionId" to B (any channel)
   |                       |                              |
   |                       |&lt;-- GET /t/:sessionId --------|
   |                       |                              |
   |                       |  session exists? ----yes---->| render button:
   |                       |                              |  poketokenbar://trade
   |                       |                              |  ?server=...&session=...
   |                       |                              |
   |                       |                              | tap button --> OS opens
   |                       |                              | PokeTokenBar via custom
   |                       |                              | scheme, app calls
   |                       |                              | POST /trades/:id/join
   |                       |                              |
   |                       |  session missing/expired --->| 404 page: "ask for a
   |                       |                              |  new link"
</code></pre>
<p>
  If the OS has no handler registered for <code>poketokenbar://</code> (app
  not installed, or an unsupported platform), the button silently does
  nothing or shows a contextless OS dialog. The landing page's fallback text
  covers that case: open the app manually and paste the link or session id.
</p>

<p><a href="/">&larr; Back</a></p>
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
<title>PokeTokenBarOnline: Trade</title>
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
  // trustProxy: Vercel and most self-hosted reverse-proxy setups terminate TLS in front of this
  // process, so the raw connection looks like plain HTTP. Without this, req.protocol always reports
  // "http" even in production, and the trade landing page would embed the wrong scheme in the
  // server origin it hands back to the client.
  const app = Fastify({ logger: true, trustProxy: true });

  app.get("/", async (_req, reply) => reply.type("text/html").send(HOMEPAGE));
  app.get("/docs", async (_req, reply) => reply.type("text/html").send(DOCS));
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/favicon.ico", async (_req, reply) =>
    reply.type("image/svg+xml").header("cache-control", "public, max-age=86400").send(FAVICON));

  registerTradeRoutes(app);
  registerBattleRoutes(app);

  // Human-facing landing page for a shared trade link; opens the app via the poketokenbar:// scheme.
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
