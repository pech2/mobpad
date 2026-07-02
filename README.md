# mobpad

A real-time **collaborative code pad for mob programming**. Several people join a room, edit one shared sketch together across HTML / CSS / JS panes, and watch it run live. p5.js is auto-injected so it works well for creative-coding sessions (e.g. *The Nature of Code*), but nothing is p5-specific — it's a generic collaborative HTML/CSS/JS pad.

Concurrent edits merge with CRDTs (no last-write-wins overwrites when two people type at once), every change re-runs the sketch in a sandboxed preview, and presence shows who's in the room.

---

## Architecture

The project is **two pieces in one monorepo**, deployed as a single Disco project
on one domain (an nginx `web` service reverse-proxies to an internal node service):

| Piece | Dir | Role |
|-------|-----|------|
| Frontend | `mob/` | Static site: editor UI, preview iframe, room lobby, login gate. Served by nginx, which also proxies `/auth/*` + `/collab`. |
| Sync + auth server | `collab-server/` | Node WebSocket server relaying Yjs updates, plus the Recurse Center OAuth routes and the cookie-gated ws upgrade. |

Each browser holds the authoritative document as a [Yjs](https://docs.yjs.dev) CRDT and syncs through the server, once authenticated. The server keeps an in-memory copy per room so late joiners receive full history. The preview is a sandboxed `<iframe>` rebuilt on each change, with p5.js auto-injected. See [Authentication](#authentication-recurse-center-oauth).

```
                    https://mobpad.example.com
browser A ─┐        ┌─ web (nginx) ─┐  /            → static mob/
           ├─ wss ─►│  same origin  │  /auth/*, /collab → proxy
browser C ─┘        └───────────────┘        │
                       collab (node) ◄───────┘  Yjs sync + OAuth + ws gate
                       (internal, no public port)
```

There is no database. Each room lives only as long as someone is connected (see [Persistence](#persistence)).

---

## Repo layout

### `mob/` — frontend (static)

| File | Responsibility |
|------|----------------|
| `index.html` | Lobby (create/join room), top bar (room code, copy-invite, editable name, presence, cursor toggle, run controls), editor column with HTML/CSS/JS tabs, and the preview iframe. |
| `script.js` | All logic (ES module): rooms, Yjs wiring, the textarea↔CRDT bridge, the iframe sketch runner, presence, editable display name, and collaborator cursors. |
| `style.css` | Dark theme (lobby, auth gate, editor, presence, cursors). |
| `nginx.conf` | The single-origin `web` service: serves the static files and reverse-proxies `/auth/*` + the `/collab` ws to the `collab` service. |
| `Dockerfile.nginx` | Builds the `web` service (nginx + `nginx.conf`); build context is the repo root. |
| `Dockerfile` / `disco.json` | Legacy `generator` service (unused under the single-origin root `disco.json`; kept for reference). |

Dependencies (yjs, y-websocket, p5) load from CDNs at runtime — there is **no `node_modules` and no build step**.

### `collab-server/` — sync + auth server (Node)

| File | Responsibility |
|------|----------------|
| `server.js` | Self-contained y-websocket server (Yjs sync + awareness on `ws` + `y-protocols` + `lib0`), the OAuth HTTP routes, and the cookie-gated ws upgrade. |
| `session.js` | HMAC-signed session tokens + cookie parsing (`node:crypto` only). Shared by the server and the tests. |
| `package.json` / `package-lock.json` | Pinned deps: `yjs`, `y-protocols`, `lib0`, `ws`. |
| `Dockerfile` | `node:22-slim`, installs prod deps, runs `node server.js` on port 42420. |
| `disco.json` | Legacy single-service file (superseded by the root `disco.json`). |
| `test.mjs` | End-to-end test: session round-trip, unauth 4401 rejection, then authenticated text sync, concurrent-edit merge, awareness, and late-joiner history. |

### repo root

| File | Responsibility |
|------|----------------|
| `disco.json` | Single Disco project: the `web` (nginx) and `collab` (node) services built from the monorepo. |
| `OAUTH_PLAN.md` | The design this auth work implements. |

> The server is hand-rolled because `y-websocket` 3.x removed its bundled server and the standalone server package is a deprecated stub.

---

## Requirements

- **Node.js 18+** (for the sync server and tests).
- A modern browser.
- **Internet access even when testing locally** — only the *sync* is local; the JS libraries and p5 still load from CDNs.

---

## Local development

Two terminals. No TLS, no certificates, no sudo — everything runs over plain `http`/`ws` locally.

**1. Sync server** — in `collab-server/`:

```bash
npm install
AUTH_DEV=1 node server.js   # listens on 0.0.0.0:42420
# optional: node test.mjs   # should print all PASS (starts its own server)
```

`AUTH_DEV=1` is important locally: the WebSocket upgrade is [gated on a Recurse
Center session](#authentication-recurse-center-oauth), and `AUTH_DEV=1` bypasses
that gate so plain local sync works without OAuth. Never set it in production —
the gate fails closed when it is unset.

**2. Frontend** — in `mob/`, serve the files over http:

```bash
python3 -m http.server 42421     # or: npx http-server -p 42421
```

Open <http://localhost:42421>.

`SERVER` near the top of `script.js` is auto-detected and needs **no editing**:
on `localhost` / `127.0.0.1` it connects straight to `ws://<host>:42420`; served
from any other host over https it uses the same-origin `wss://<host>/collab`
(the nginx path in [Deployment](#deployment-disco)). The frontend also skips the
login gate on `localhost`, matching the server's `AUTH_DEV` bypass.

**Test multiuser:** open the page in two windows, create a room in one, copy the invite link into the other. Typing in one updates the sketch and code in the other; you'll see two presence chips. In DevTools → Network → WS, the connection to `:42420` should sit at status **101**.

**Test on another device (same LAN):** replace `localhost` with your laptop's LAN IP in both the URL and `SERVER`. `ws://` still works because the page stays on http, and both servers already bind all interfaces.

---

## Running with Podman (rootless, no sudo)

Runs the whole thing in containers as an unprivileged user — no `sudo`, no daemon, no root. It works because both published ports (`42420`, `42421`) are **above 1024**, so rootless Podman can bind them without extra privileges. The two containers don't talk to each other; the *browser* connects to each via its published host port, so no shared network or pod is needed.

Everything below uses plain `podman`. If you have `docker` aliased to `podman`, those commands work too.

> The `mob/Dockerfile` is a Disco "generator" (it only *copies* the static files — no web server, no `CMD`), so it can't be run directly. Under Podman we serve `mob/` with a stock static-server image and a bind mount instead.

No client edits needed — `SERVER` auto-detects `localhost` and the frontend skips the login gate there (see [Local development](#local-development)).

**1. Sync server** — build and run from the repo root. `AUTH_DEV=1` bypasses the auth gate for local use:

```bash
podman build -t mobpad-collab ./collab-server
podman run -d --name mobpad-collab -p 42420:42420 -e AUTH_DEV=1 mobpad-collab
```

**2. Frontend** — serve `mob/` with nginx over a read-only bind mount (no build; host edits to `script.js` show on refresh):

```bash
podman run -d --name mobpad-web \
  -p 42421:80 \
  -v ./mob:/usr/share/nginx/html:ro,Z \
  docker.io/library/nginx:alpine
```

The `Z` suffix relabels the mount for SELinux (Fedora/RHEL); it's harmless where SELinux isn't enforcing. Drop it only if your Podman rejects the `:ro,Z` syntax.

Open <http://localhost:42421>, create a room, and share the invite link the same way as in [Local development](#local-development).

**Logs / teardown:**

```bash
podman logs -f mobpad-collab              # tail the sync server
podman rm -f mobpad-collab mobpad-web     # stop and remove both
```

> **LAN / another device:** `-p` publishes on `0.0.0.0`, so swap `localhost` for your host's LAN IP in the URL and in `SERVER` (per the [LAN note](#local-development)) and it just works.
>
> **macOS:** Podman runs Linux containers inside a VM, so start it first with `podman machine init && podman machine start`. Published ports are still reachable at `localhost` from the host. `no sudo` is automatic there — the machine is per-user.

---

## Deployment (Disco)

**One Disco project, one domain.** The root `disco.json` declares two services from
the monorepo: a `web` service (nginx — serves the static frontend *and*
reverse-proxies `/auth/*` and the `/collab` WebSocket) and a `collab` service (the
node sync + OAuth server, internal-only, no public port). Disco routes the domain
to `web`; `web` reaches `collab` at `http://collab:42420` on the project network.
See [`OAUTH_PLAN.md`](OAUTH_PLAN.md) for the full rationale.

```bash
# one project, one domain (pick an unused *.rcdis.co or your own)
disco projects:add --github <you>/mobpad --name mobpad --domain mobpad.example.com

# OAuth + session secrets live only here, never in the repo
disco env:set --project mobpad \
  RC_CLIENT_ID=…  RC_CLIENT_SECRET=…  SESSION_SECRET=<random> \
  RC_REDIRECT_URI=https://mobpad.example.com/auth/callback \
  FRONTEND_ORIGIN=https://mobpad.example.com
```

Then register `https://mobpad.example.com/auth/callback` as the redirect URI on
the [Recurse Center OAuth app](https://www.recurse.com/settings/apps) — it must
match `RC_REDIRECT_URI` exactly. Open `https://mobpad.example.com`, log in with
Recurse, create a room, and share the invite link.

> Caddy (Disco's edge) terminates TLS and forwards to `web`; the browser sees one
> `https`/`wss` origin, so the session cookie rides the same-origin ws upgrade
> automatically. See [Authentication](#authentication-recurse-center-oauth).

---

## Authentication (Recurse Center OAuth)

Public deployments gate room sync behind a **Recurse Center login** — the sync
server accepts a WebSocket only with a valid session cookie, so only Recursers can
join. Design and trade-offs are in [`OAUTH_PLAN.md`](OAUTH_PLAN.md); the shipped
mechanics:

- **Single origin.** Everything is served from one domain. `/auth/callback` sets
  `mobpad_session` as an `HttpOnly; Secure; SameSite=Lax` cookie, and the
  same-origin ws upgrade to `/collab/…` carries it automatically — no token in the
  URL, no `localStorage`.
- **Flow.** The frontend calls `GET /auth/me`; a `401` shows *“Log in with
  Recurse”* → `GET /auth/login` → RC `/oauth/authorize` → `GET /auth/callback`
  (code exchange + profile read) → session cookie → back to the app.
- **Session token.** A hand-rolled HMAC-signed token (`base64url(payload).sig`,
  HS256 semantics) in `collab-server/session.js` — **zero new runtime deps**
  (`node:crypto` + global `fetch`). Claims `{sub, name, iat, exp}`, ~12h lifetime.
- **ws gate.** `server.on('upgrade')` verifies the cookie; an invalid/absent
  session is closed with WebSocket code **4401** so the client re-shows login.
- **Local dev** skips all of this via `AUTH_DEV=1` (server) + the `localhost`
  frontend bypass — see [Local development](#local-development).

Configure the RC app and secrets at [Deployment](#deployment-disco). Tests in
`collab-server/test.mjs` cover the session round-trip, the 4401 rejection, and
authenticated sync.

---

## Configuration

| Setting | Where | Notes |
|---------|-------|-------|
| `SERVER` | `script.js` | Sync server URL. Auto-detected: direct `ws://<host>:42420` on `localhost`, else same-origin `wss://<host>/collab`. No editing needed. |
| `APP_PREFIX` | `script.js` | Server-side room namespace (`mob:`). Prevents room-name collisions if other apps share the same server. |
| `PORT` / `HOST` | `server.js` env | Default `42420` / `0.0.0.0`. |
| `AUTH_DEV` | `server.js` env | `1` bypasses the auth gate for local dev (`/auth/login` mints a session, ws gate accepts all). **Never set in production.** |
| `RC_CLIENT_ID` / `RC_CLIENT_SECRET` | `server.js` env | Recurse Center OAuth app credentials. Secret only via `disco env:set`. |
| `RC_REDIRECT_URI` | `server.js` env | `https://<domain>/auth/callback`; must match the RC app exactly. |
| `SESSION_SECRET` | `server.js` env | HMAC key for the session cookie. Set a random value in production. |
| `FRONTEND_ORIGIN` | `server.js` env | Open-redirect allowlist for `/auth/login?redirect=`. |
| Room code | URL hash | `#room=coral-otter-318`. Sanitized and used as both the share key and the server room path. |

---

## Working in this codebase

Non-obvious invariants worth preserving:

- **`LOCAL` origin tag.** Every local edit is applied inside `ydoc.transact(..., LOCAL)`. Observers ignore changes whose `transaction.origin === LOCAL` when updating the textarea, which is what prevents an echo loop (apply remote → fire observer → re-apply → ...).
- **Cursor transform.** Remote edits map the local caret through the Yjs delta (`transform()`) so your cursor doesn't jump when a teammate edits text above you.
- **One Y.Text per pane.** `html`, `css`, `js` are separate `Y.Text`s in one `Y.Doc`. The *active* pane drives the textarea; *all three* trigger a preview re-run, so editing CSS updates the canvas even while someone else is in the JS tab.
- **Preview isolation.** The sketch runs in a sandboxed iframe rebuilt via `srcdoc` on each change. User code in each pane is escaped against its own closing tag (`</script>`, `</style>`) so it can't break out of the composed document.
- **p5 is pinned to `p5@1`** (jsDelivr). p5 2.0 has breaking changes; the starter sketch and most tutorials (e.g. Nature of Code) target 1.x.
- **Seeding.** The first client into an empty room seeds the three starter panes once; everyone else syncs to the existing doc. Guard with the emptiness check before adding more seed logic.

---

## Persistence

Rooms are in-memory. When the last client disconnects, `closeConn()` in `server.js` destroys the doc. To make rooms survive an empty room or a restart, add a persistence provider (e.g. `y-leveldb`) at the marked spot in `closeConn()` and load on `getYDoc()`.

---

## Possible next steps

- **Per-pane presence** — add the active pane to awareness state and show it on each presence chip, so the mob can see who's looking at which file.
- **CodeMirror 6** (`y-codemirror.next`) in place of the textarea — syntax highlighting plus live remote cursors/selections.
- **`y-leveldb` persistence** — a returnable gallery of saved sketches.

---

## Tech stack

p5.js · Yjs (CRDT) · y-websocket / y-protocols · `ws` · Disco (Docker Swarm + Caddy) · vanilla JS, no framework, no bundler.
