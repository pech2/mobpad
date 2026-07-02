# Plan: Recurse Center OAuth for mobpad — single origin on RC Disco

Goal: make mobpad safe on the public internet by requiring a **Recurse Center
login** before anyone can sync into a room. Today `collab-server` accepts any
WebSocket connection to any room — fine on `localhost`, unacceptable publicly.

**Architecture decision (this plan):** deploy as **one Disco project on one
domain** (`mobpad.rcdis.co`). An nginx `web` container serves the static frontend
*and* reverse-proxies the OAuth routes and the Yjs WebSocket to a second `collab`
container on the project's internal network. Because everything is one origin,
auth is a normal **`HttpOnly` cookie** — no tokens in URLs.

```
                              https://mobpad.rcdis.co
   browser ──► Caddy (RC edge, TLS) ──► web container (nginx)
                                          ├─ /            → static mob/ files
                                          ├─ /auth/*      → proxy → collab:42420
                                          └─ /collab/*    → proxy (ws) → collab:42420
                                                                   │
                                            collab container (node) ◄┘  (internal only,
                                            OAuth + Yjs sync + ws auth      no public port)
```

---

## 1. Why single origin

- **Cookie, not token.** `/auth/callback` sets `Set-Cookie: … HttpOnly; Secure;
  SameSite=Lax`. The same-origin WebSocket upgrade to `wss://mobpad.rcdis.co/collab/…`
  carries that cookie automatically, so the ws gate reads it from headers. No
  token in the URL/fragment, no `localStorage`, no cross-origin dance.
- **Matches Disco's multi-service model** (§2) and your monorepo — one project,
  one `disco projects:add`, one atomic PR for a change that spans both pieces.
- **One TLS domain** to register as the OAuth redirect URI.

Trade-off vs. two domains: we run our own reverse proxy (nginx) as the `web`
service, because Disco routes a domain only to `web` — it does not path-route
across services (§2).

> **Alternative B (simpler, one container):** fold static serving into the node
> server so `collab-server` *is* the single `web` service (serves the 3 static
> files + `/auth/*` + ws). Removes nginx and the internal-DNS dependency; cookie
> is trivially same-process. Costs: node serves static and the two pieces merge
> into one image. Reasonable if we want minimal moving parts — noted, but the
> primary plan keeps nginx so `collab-server` stays focused on sync+auth.

---

## 2. How Disco makes this work (verified against docs)

From <https://disco.cloud/docs/concepts/> and <https://disco.cloud/docs/disco-json/>:

- **Project → many services.** `disco.json` `"services"` can declare multiple
  containers. The name **`web` is reserved** and is the only service that
  automatically receives public HTTP/HTTPS from the project's domain (via Caddy,
  which also does TLS). **Path-based routing to other services is not a
  documented feature** → we split paths ourselves in nginx.
- **Monorepo builds** via the top-level `"images"` block: each image sets
  `"dockerfile"` and `"context"` (a subdirectory). Services reference an image by
  name with `"image"`.
- **Service-to-service networking** is Docker Swarm: a service reaches another in
  the same project using the **service name as the hostname** (e.g.
  `http://collab:42420`). The `collab` service needs **no public port** — only
  `web` is exposed. (`exposedInternally` is for *cross-project* reach; not needed
  here.) *Verify the exact same-project hostname Disco assigns when implementing.*
- **Secrets** never go in `disco.json`: `disco env:set KEY=VALUE` (§9).

---

## 3. Recurse Center OAuth specifics

RC is a standard OAuth2 provider (Doorkeeper). Register the app once at
**<https://www.recurse.com/settings/apps>** for a `client_id`/`client_secret`,
and set the redirect URI to the deployed callback.

| Thing | Value |
|-------|-------|
| Authorize URL | `https://www.recurse.com/oauth/authorize` |
| Token URL | `https://www.recurse.com/oauth/token` |
| Current-user API | `GET https://www.recurse.com/api/v1/profiles/me` (Bearer) |
| Grant type | `authorization_code` |
| Redirect URI | `https://mobpad.rcdis.co/auth/callback` (must match exactly) |

Only RC members can complete the flow, so "is a Recurser" is enforced implicitly;
we also read the profile for a trusted display name. *Confirm exact endpoints
against current RC API docs when implementing.*

---

## 4. Request flow

1. Browser loads `https://mobpad.rcdis.co` → nginx serves static files.
2. Frontend calls `GET /auth/me` (cookie auto-sent). 401 → show **“Log in with
   Recurse”**; 200 `{name}` → proceed and seed the display name.
3. Login button → `GET /auth/login?redirect=<current url>` (top-level nav).
4. node validates `redirect` against `FRONTEND_ORIGIN`, stores a random `state`,
   302s to RC `/oauth/authorize`.
5. RC → `GET /auth/callback?code=&state=`. node checks `state`, POSTs to RC token
   URL, GETs `/profiles/me`, mints a session JWT (§8), sets it as an `HttpOnly`
   cookie, 302s back to the stored `redirect`.
6. Frontend opens `wss://mobpad.rcdis.co/collab/mob:<room>`; browser sends the
   cookie; node verifies it on the ws `upgrade` and accepts (or closes **4401**).

---

## 5. Repo changes: the `web` (nginx) service

### 5.1 Root `disco.json` (new file at repo root)

```json
{
  "version": "1.0",
  "services": {
    "web":    { "image": "web", "port": 80 },
    "collab": { "image": "collab", "port": 42420 }
  },
  "images": {
    "web":    { "dockerfile": "mob/Dockerfile.nginx", "context": "." },
    "collab": { "dockerfile": "collab-server/Dockerfile", "context": "collab-server" }
  }
}
```

- Only `web` gets the domain; `collab` is internal, reachable at `collab:42420`.
- `web`'s build context is the repo root so its Dockerfile can copy `mob/`.
- The existing per-subdir `disco.json` files become unused (delete or leave).

### 5.2 `mob/Dockerfile.nginx` (new — replaces the `generator`)

```dockerfile
FROM nginx:alpine
COPY mob/ /usr/share/nginx/html/
COPY mob/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

### 5.3 `mob/nginx.conf` (new — the path split + ws proxy)

```nginx
server {
  listen 80;
  server_name _;
  root /usr/share/nginx/html;
  index index.html;

  # static frontend
  location / { try_files $uri $uri/ /index.html; }

  # OAuth endpoints on the node server
  location /auth/ {
    proxy_pass http://collab:42420/auth/;
    proxy_set_header Host $host;
    # preserve Caddy's external scheme so node builds https redirect URIs
    proxy_set_header X-Forwarded-Proto $http_x_forwarded_proto;
  }

  # Yjs WebSocket sync ( /collab/mob:room  →  node sees /mob:room )
  location /collab/ {
    proxy_pass http://collab:42420/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;   # keep long-lived sockets open
  }
}
```

- Trailing-slash `proxy_pass` strips the `/collab/` prefix, so the room parser at
  `server.js:114` is unchanged.
- Cookies are forwarded to the upstream by default (incl. on the upgrade request).
- *Verify Caddy forwards WebSocket upgrades to the `web` service transparently
  (it normally does) and that `X-Forwarded-Proto: https` reaches nginx.*

---

## 6. Server changes (`collab-server/server.js`)

### 6.1 New HTTP routes (extend the `http.createServer` handler at `server.js:150`)

- `GET /healthz` → `200` (move the current root health check here).
- `GET /auth/login?redirect=` → validate `redirect` vs `FRONTEND_ORIGIN`
  (open-redirect guard), store random `state` (in-memory Map, single instance is
  fine), 302 to RC authorize.
- `GET /auth/callback?code=&state=` → check+delete `state` (CSRF), POST to RC
  token URL (global `fetch`), GET `/profiles/me`, mint session JWT (§8),
  `Set-Cookie` it, 302 to the stored `redirect`. Build absolute URLs from
  `X-Forwarded-Proto` + `Host`.
- `GET /auth/me` → verify cookie → `200 {id,name}` or `401`. (Lets the
  cookie-blind frontend gate its UI.)
- `POST /auth/logout` → clear the cookie (optional).
- else → `404`.

### 6.2 Gate the WebSocket upgrade (cookie, not query token)

```js
const wss = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => {
  const claims = verifySession(parseCookie(req.headers.cookie)['mobpad_session'])
  if (!claims) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.user = { id: claims.sub, name: claims.name }   // trusted identity
    wss.emit('connection', ws, req)
  })
})
```

- Reject with WebSocket close code **4401** so the client can distinguish auth
  failure from a normal drop.
- `ws.user` lets us later trust the server identity over the free-text name (§7.4).

### 6.3 Dependencies

**Zero new runtime deps required:** `node:crypto` for the HMAC-signed cookie,
global `fetch` (node 22) for RC calls, a ~5-line cookie parser. `jose` is the
smallest add if a JWT lib is preferred.

---

## 7. Frontend changes (`mob/`)

Single origin makes this *smaller* than the token version — no `AUTH_BASE`, no
token storage.

1. **`SERVER`** (`script.js:10`): derive from the current origin —
   `const SERVER = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/collab``.
2. **Gate on load** (near boot, `script.js:287`): `await fetch('/auth/me')`; on
   401 show a **“Log in with Recurse”** button (`index.html` lobby, ~line 20) that
   does `location.href = '/auth/login?redirect=' + encodeURIComponent(location.href)`.
3. **Provider** (`script.js:87`): unchanged —
   `new WebsocketProvider(SERVER, APP_PREFIX + room, ydoc)`. No token param; the
   cookie authenticates.
4. **(Optional) trust identity:** seed `nameInput` from `/auth/me` and stop
   trusting the free-text name for presence to prevent impersonation.
5. **Auth failure:** on ws close code 4401 / repeated failures, re-show login.

> **Local dev:** to mirror prod (relative `/collab`), run the same nginx `web`
> image under Podman in front of the node server, and update the README Podman
> section. Or keep a `location.hostname` check that falls back to
> `ws://localhost:42420` for the current direct-port local flow.

---

## 8. Session cookie design

- **Cookie:** `mobpad_session=<jwt>; Path=/; HttpOnly; Secure; SameSite=Lax`.
- **Token:** compact JWT (`HS256`) or `base64url(payload).hmac`, signed with
  `SESSION_SECRET`. Claims `{ sub, name, iat, exp }`, ~12h lifetime.
- `verifySession()` checks signature + `exp`; used by both `/auth/me` and the ws
  upgrade gate.
- **Refresh (phase 2):** on expiry the client silently re-hits `/auth/login`
  (RC session likely still valid → no prompt).

---

## 9. Configuration (all on the `collab` service, via `disco env:set`)

| Var | Purpose |
|-----|---------|
| `RC_CLIENT_ID` | RC OAuth app id |
| `RC_CLIENT_SECRET` | RC OAuth app secret (never in the repo) |
| `RC_REDIRECT_URI` | `https://mobpad.rcdis.co/auth/callback` (must match RC app) |
| `SESSION_SECRET` | HMAC key for the session cookie |
| `FRONTEND_ORIGIN` | `https://mobpad.rcdis.co` (open-redirect allowlist) |

**Glass-walls note:** the community server has "glass walls" — your managed-repo
list is visible to all Recursers and you shouldn't host anything private. Code
being public is fine; secrets live only in `disco env:set`. *Confirm env-var
isolation between users before trusting it with `RC_CLIENT_SECRET`; if isolation
is weak the exposure is bounded (impersonating this app's consent screen, forging
sessions for throwaway sketch rooms) but real.*

---

## 10. Deploy

```bash
# one project, one domain (pick an unused *.rcdis.co)
disco projects:add --github pech2/mobpad --name mobpad --domain mobpad.rcdis.co

disco env:set --project mobpad \
  RC_CLIENT_ID=…  RC_CLIENT_SECRET=…  SESSION_SECRET=… \
  RC_REDIRECT_URI=https://mobpad.rcdis.co/auth/callback \
  FRONTEND_ORIGIN=https://mobpad.rcdis.co
```

Then register `https://mobpad.rcdis.co/auth/callback` as the redirect URI on the
RC OAuth app. Prerequisite: the code is on GitHub as `pech2/mobpad` ✅; add the
root `disco.json` (§5.1) so Disco has services to build.

---

## 11. Testing

Extend `collab-server/test.mjs`:

- **Reject unauthenticated:** ws upgrade with no cookie → closes 4401.
- **Reject tampered/expired:** bad signature / past `exp` → rejected.
- **Accept valid:** mint a cookie with `SESSION_SECRET` → sync/awareness pass
  (existing assertions run unchanged behind the gate).
- **`verifySession` unit:** round-trips a minted token; rejects payload edits.
- `/auth/callback` RC exchange: stub `fetch` (endpoints from §3) or verify
  manually against a real RC app.
- **nginx proxy:** locally `curl` `/`, `/auth/me`, and a ws upgrade through the
  nginx container to confirm the path split + upgrade headers.

---

## 12. Security checklist

- [ ] `client_secret` only on the `collab` service; never in the repo.
- [ ] Secrets via `disco env:set` (glass-walls shared server, §9).
- [ ] `state` verified on callback (CSRF).
- [ ] `redirect` validated against `FRONTEND_ORIGIN` (open-redirect).
- [ ] Cookie is `HttpOnly; Secure; SameSite=Lax`; JWT signed + expiring.
- [ ] Auth failure uses ws close code 4401 the client reacts to.
- [ ] node trusts `X-Forwarded-Proto`/`Host` from nginx/Caddy for URL + Secure
      cookie building.
- [ ] `collab` has no public port (internal-only; `web` is the only exposed one).
- [ ] Health check moved to `/healthz`.

---

## 13. Rollout phases

1. **Server auth core** — `verifySession`/mint + cookie parse + ws upgrade gate +
   `/auth/me` + tests (dev-mint a cookie so local sync still works).
2. **OAuth endpoints** — `/auth/login` + `/auth/callback` + RC app registration.
3. **Single-origin plumbing** — root `disco.json`, `mob/Dockerfile.nginx`,
   `mob/nginx.conf`; point `SERVER` at `/collab`; login gate in the frontend.
4. **Deploy** — `disco projects:add` + `disco env:set` + register redirect URI.
5. **Phase 2** — silent refresh, RC-identity-locked names, per-room authorization.

---

## 14. Open questions

1. **Two containers (nginx + node) or one (node serves everything, Alt. B §1)?**
   Plan assumes two; Alt. B is fewer moving parts.
2. **Any Recurser vs. a subset / per-room authorization?** (Phase 2.)
3. **Session lifetime & refresh** — 12h + re-login, or silent refresh from day 1?
4. **JWT lib vs. hand-rolled** (`node:crypto`, zero-dep)?
5. **Verify on Disco:** exact same-project service hostname, that Caddy forwards
   ws upgrades to `web`, and env-var isolation on the shared server.
