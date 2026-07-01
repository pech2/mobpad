# mobpad

A real-time **collaborative code pad for mob programming**. Several people join a room, edit one shared sketch together across HTML / CSS / JS panes, and watch it run live. p5.js is auto-injected so it works well for creative-coding sessions (e.g. *The Nature of Code*), but nothing is p5-specific — it's a generic collaborative HTML/CSS/JS pad.

Concurrent edits merge with CRDTs (no last-write-wins overwrites when two people type at once), every change re-runs the sketch in a sandboxed preview, and presence shows who's in the room.

---

## Architecture

The project is **two independently deployed pieces**, kept in two repos:

| Piece | Repo | Role |
|-------|------|------|
| Frontend | `mob/` | Static site: editor UI, preview iframe, room lobby. No backend of its own. |
| Sync server | `collab-server/` | Small Node WebSocket server relaying Yjs updates between clients. |

Each browser holds the authoritative document as a [Yjs](https://docs.yjs.dev) CRDT and syncs through the server. The server keeps an in-memory copy per room so late joiners receive full history. The preview is a sandboxed `<iframe>` rebuilt on each change, with p5.js auto-injected.

```
browser A ─┐                                  ┌─ browser B
           ├─ wss ─►  collab-server  ◄─ wss ─┤
browser C ─┘        (Yjs sync + awareness)    └─ ...
```

There is no database. Each room lives only as long as someone is connected (see [Persistence](#persistence)).

---

## Repo layout

### `mob/` — frontend (static)

| File | Responsibility |
|------|----------------|
| `index.html` | Lobby (create/join room), top bar (room code, copy-invite, editable name, presence, cursor toggle, run controls), editor column with HTML/CSS/JS tabs, and the preview iframe. |
| `script.js` | All logic (ES module): rooms, Yjs wiring, the textarea↔CRDT bridge, the iframe sketch runner, presence, editable display name, and collaborator cursors. |
| `style.css` | Dark theme. |
| `Dockerfile` | Copies the three site files into `public/` for Disco's static build. |
| `disco.json` | Declares a `generator` service serving `public/`. |

Dependencies (yjs, y-websocket, p5) load from CDNs at runtime — there is **no `node_modules` and no build step**.

### `collab-server/` — sync server (Node)

| File | Responsibility |
|------|----------------|
| `server.js` | Self-contained y-websocket server: implements the Yjs sync + awareness protocol directly on `ws` + `y-protocols` + `lib0`. |
| `package.json` / `package-lock.json` | Pinned deps: `yjs`, `y-protocols`, `lib0`, `ws`. |
| `Dockerfile` | `node:22-slim`, installs prod deps, runs `node server.js` on port 42420. |
| `disco.json` | Declares the `web` service on port 42420. |
| `test.mjs` | End-to-end test: spins the server, connects two clients, asserts text sync, concurrent-edit merge, awareness, and late-joiner history. |

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
node server.js          # listens on 0.0.0.0:42420
# optional: node test.mjs   # should print all PASS
```

**2. Frontend** — in `mob/`, point the client at the local server, then serve over http:

```bash
python3 -m http.server 42421     # or: npx http-server -p 42421
```

Open <http://localhost:42421>.

Set `SERVER` near the top of `script.js`. Locally it must be `ws://` (not `wss://`) because the page is plain http:

```js
const SERVER = 'ws://localhost:42420'
```

To avoid editing this line per environment, auto-detect instead:

```js
const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname)
const SERVER = isLocal ? `ws://${location.hostname}:42420`
                       : 'wss://collab.yourdomain.com'
```

**Test multiuser:** open the page in two windows, create a room in one, copy the invite link into the other. Typing in one updates the sketch and code in the other; you'll see two presence chips. In DevTools → Network → WS, the connection to `:42420` should sit at status **101**.

**Test on another device (same LAN):** replace `localhost` with your laptop's LAN IP in both the URL and `SERVER`. `ws://` still works because the page stays on http, and both servers already bind all interfaces.

---

## Running with Podman (rootless, no sudo)

Runs the whole thing in containers as an unprivileged user — no `sudo`, no daemon, no root. It works because both published ports (`42420`, `42421`) are **above 1024**, so rootless Podman can bind them without extra privileges. The two containers don't talk to each other; the *browser* connects to each via its published host port, so no shared network or pod is needed.

Everything below uses plain `podman`. If you have `docker` aliased to `podman`, those commands work too.

> The `mob/Dockerfile` is a Disco "generator" (it only *copies* the static files — no web server, no `CMD`), so it can't be run directly. Under Podman we serve `mob/` with a stock static-server image and a bind mount instead.

**1. Point the client at the local server.** Set `SERVER` near the top of `mob/script.js` to the local `ws://` URL (see the auto-detect snippet above), otherwise the page tries to reach production:

```js
const SERVER = 'ws://localhost:42420'
```

**2. Sync server** — build and run from the repo root:

```bash
podman build -t mobpad-collab ./collab-server
podman run -d --name mobpad-collab -p 42420:42420 mobpad-collab
```

**3. Frontend** — serve `mob/` with nginx over a read-only bind mount (no build; host edits to `script.js` show on refresh):

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

Two Disco projects on one server. Order matters — the frontend needs the server's address.

1. **Deploy `collab-server` first.** Push to a repo, add it as a Disco project, give it a domain (e.g. `collab.yourdomain.com`). Disco builds the Dockerfile and Caddy fronts it with automatic TLS, so it comes up as `wss://collab.yourdomain.com`.
2. **Set `SERVER`** in `mob/script.js` to that `wss://` URL (or use the auto-detect snippet above).
3. **Deploy `mob` second.** Push to a second repo, add it as a Disco project with its own domain (e.g. `mob.yourdomain.com`). The `generator` service serves the static files over https.

Then open `https://mob.yourdomain.com`, create a room, and share the invite link. Both sides are now real `https`/`wss` origins, which the browser requires for a secure page.

> Local works on `http`/`ws`; the moment the page is served over `https`, the browser forces `wss`, which is why production needs the TLS that Disco/Caddy provides.

---

## Configuration

| Setting | Where | Notes |
|---------|-------|-------|
| `SERVER` | `script.js` | The sync server URL. `ws://` locally, `wss://` in production. |
| `APP_PREFIX` | `script.js` | Server-side room namespace (`mob:`). Prevents room-name collisions if other apps share the same server. |
| `PORT` / `HOST` | `server.js` env | Default `42420` / `0.0.0.0`. |
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
