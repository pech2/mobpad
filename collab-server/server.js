import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync.js'
import * as awarenessProtocol from 'y-protocols/awareness.js'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { WebSocketServer } from 'ws'
import http from 'http'
import crypto from 'crypto'
import { mintSession, verifySession, parseCookie, SESSION_COOKIE } from './session.js'

const PORT = Number(process.env.PORT) || 42420
const HOST = process.env.HOST || '0.0.0.0'
const PING_TIMEOUT = 30000

// ---------- auth config (all via `disco env:set` in production) ----------
const RC_CLIENT_ID = process.env.RC_CLIENT_ID
const RC_CLIENT_SECRET = process.env.RC_CLIENT_SECRET
const RC_REDIRECT_URI = process.env.RC_REDIRECT_URI       // must match the RC app exactly
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN       // open-redirect allowlist
// AUTH_DEV=1 skips the Recurse Center round-trip: /auth/login mints a session
// directly and the ws gate lets connections through. For local dev only — never
// set it in production (the gate fails closed when it is unset).
const AUTH_DEV = process.env.AUTH_DEV === '1'
const COOKIE_MAX_AGE = 12 * 3600

const RC_AUTHORIZE = 'https://www.recurse.com/oauth/authorize'
const RC_TOKEN = 'https://www.recurse.com/oauth/token'
const RC_PROFILE = 'https://www.recurse.com/api/v1/profiles/me'

const messageSync = 0
const messageAwareness = 1

const wsConnecting = 0
const wsOpen = 1

/** room name -> shared doc */
const docs = new Map()

class WSSharedDoc extends Y.Doc {
  constructor (name) {
    super({ gc: true })
    this.name = name
    this.conns = new Map() // conn -> Set<clientID>
    this.awareness = new awarenessProtocol.Awareness(this)
    this.awareness.setLocalState(null)

    this.awareness.on('update', ({ added, updated, removed }, conn) => {
      const changed = added.concat(updated, removed)
      if (conn !== null) {
        const ids = this.conns.get(conn)
        if (ids !== undefined) {
          added.forEach(id => ids.add(id))
          removed.forEach(id => ids.delete(id))
        }
      }
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, messageAwareness)
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed))
      const buf = encoding.toUint8Array(enc)
      this.conns.forEach((_, c) => send(this, c, buf))
    })

    this.on('update', (update, _origin, doc) => {
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, messageSync)
      syncProtocol.writeUpdate(enc, update)
      const buf = encoding.toUint8Array(enc)
      doc.conns.forEach((_, c) => send(doc, c, buf))
    })
  }
}

const getYDoc = (name) => {
  let doc = docs.get(name)
  if (doc === undefined) {
    doc = new WSSharedDoc(name)
    docs.set(name, doc)
  }
  return doc
}

const send = (doc, conn, m) => {
  if (conn.readyState !== wsConnecting && conn.readyState !== wsOpen) {
    closeConn(doc, conn)
    return
  }
  try {
    conn.send(m, (err) => { if (err != null) closeConn(doc, conn) })
  } catch (e) {
    closeConn(doc, conn)
  }
}

const closeConn = (doc, conn) => {
  if (doc.conns.has(conn)) {
    const ids = doc.conns.get(conn)
    doc.conns.delete(conn)
    awarenessProtocol.removeAwarenessStates(doc.awareness, Array.from(ids), null)
    if (doc.conns.size === 0) {
      // last client left: drop the in-memory doc so memory doesn't grow unbounded.
      // (Add persistence here if you want docs to survive an empty room.)
      doc.destroy()
      docs.delete(doc.name)
    }
  }
  try { conn.close() } catch (e) {}
}

const onMessage = (conn, doc, message) => {
  try {
    const enc = encoding.createEncoder()
    const dec = decoding.createDecoder(message)
    const type = decoding.readVarUint(dec)
    switch (type) {
      case messageSync:
        encoding.writeVarUint(enc, messageSync)
        syncProtocol.readSyncMessage(dec, enc, doc, conn)
        if (encoding.length(enc) > 1) send(doc, conn, encoding.toUint8Array(enc))
        break
      case messageAwareness:
        awarenessProtocol.applyAwarenessUpdate(doc.awareness, decoding.readVarUint8Array(dec), conn)
        break
    }
  } catch (err) {
    console.error('message error:', err)
  }
}

const setupConn = (conn, req) => {
  conn.binaryType = 'arraybuffer'
  const room = (req.url || '').slice(1).split('?')[0] || 'default'
  const doc = getYDoc(room)
  doc.conns.set(conn, new Set())

  conn.on('message', (data) => onMessage(conn, doc, new Uint8Array(data)))

  let pongReceived = true
  const pingTimer = setInterval(() => {
    if (!pongReceived) {
      if (doc.conns.has(conn)) closeConn(doc, conn)
      clearInterval(pingTimer)
    } else if (doc.conns.has(conn)) {
      pongReceived = false
      try { conn.ping() } catch (e) { closeConn(doc, conn) }
    }
  }, PING_TIMEOUT)
  conn.on('pong', () => { pongReceived = true })
  conn.on('close', () => { closeConn(doc, conn); clearInterval(pingTimer) })

  // initial sync: ask the new client for its state (SyncStep1)
  {
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, messageSync)
    syncProtocol.writeSyncStep1(enc, doc)
    send(doc, conn, encoding.toUint8Array(enc))
  }
  // push current awareness to the new client
  const states = doc.awareness.getStates()
  if (states.size > 0) {
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, messageAwareness)
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(doc.awareness, Array.from(states.keys())))
    send(doc, conn, encoding.toUint8Array(enc))
  }
}

// ---------- HTTP helpers ----------
const sendText = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'text/plain' })
  res.end(body)
}
const sendJson = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(obj))
}

// The external scheme, as seen by the browser. nginx/Caddy set X-Forwarded-Proto;
// node itself only ever sees plain http from the reverse proxy. We use this to
// build https redirect/callback URLs and to decide whether to mark cookies Secure.
const externalProto = (req) =>
  (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() ||
  (req.socket.encrypted ? 'https' : 'http')

const setSessionCookie = (req, res, token) => {
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${COOKIE_MAX_AGE}`]
  if (externalProto(req) === 'https') attrs.push('Secure')
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; ${attrs.join('; ')}`)
}
const clearSessionCookie = (res) => {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
}

// Open-redirect guard: only bounce back to FRONTEND_ORIGIN (or a path under it).
// In dev (no FRONTEND_ORIGIN) we allow whatever was passed.
const safeRedirect = (redirect) => {
  if (!FRONTEND_ORIGIN) return redirect || '/'
  if (!redirect) return FRONTEND_ORIGIN
  try {
    const u = new URL(redirect, FRONTEND_ORIGIN)
    return u.origin === new URL(FRONTEND_ORIGIN).origin ? u.toString() : FRONTEND_ORIGIN
  } catch {
    return FRONTEND_ORIGIN
  }
}

// Pending OAuth `state` values (CSRF). In-memory is fine for a single instance.
const oauthStates = new Map() // state -> { redirect, ts }
const STATE_TTL = 10 * 60 * 1000
const pruneStates = () => {
  const now = Date.now()
  for (const [k, v] of oauthStates) if (now - v.ts > STATE_TTL) oauthStates.delete(k)
}

// ---------- auth routes ----------
const authMe = (req, res) => {
  const claims = verifySession(parseCookie(req.headers.cookie)[SESSION_COOKIE])
  if (!claims) return sendJson(res, 401, { error: 'unauthorized' })
  return sendJson(res, 200, { id: claims.sub, name: claims.name })
}

const authLogin = (req, res, url) => {
  const redirect = safeRedirect(url.searchParams.get('redirect'))
  if (AUTH_DEV) {
    // local/dev: skip Recurse, mint a session immediately
    const name = url.searchParams.get('name') || 'dev'
    setSessionCookie(req, res, mintSession({ id: 'dev-' + name, name }))
    res.writeHead(302, { Location: redirect })
    return res.end()
  }
  if (!RC_CLIENT_ID || !RC_REDIRECT_URI) return sendText(res, 500, 'OAuth is not configured')
  pruneStates()
  const state = crypto.randomBytes(16).toString('hex')
  oauthStates.set(state, { redirect, ts: Date.now() })
  const auth = new URL(RC_AUTHORIZE)
  auth.searchParams.set('client_id', RC_CLIENT_ID)
  auth.searchParams.set('redirect_uri', RC_REDIRECT_URI)
  auth.searchParams.set('response_type', 'code')
  auth.searchParams.set('state', state)
  res.writeHead(302, { Location: auth.toString() })
  return res.end()
}

const authCallback = async (req, res, url) => {
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const entry = state ? oauthStates.get(state) : undefined
  if (!code || !entry) return sendText(res, 400, 'invalid or expired OAuth state')
  oauthStates.delete(state) // single use (CSRF)

  // exchange the code for an access token
  const tokenRes = await fetch(RC_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: RC_REDIRECT_URI,
      client_id: RC_CLIENT_ID,
      client_secret: RC_CLIENT_SECRET
    })
  })
  if (!tokenRes.ok) {
    console.error('RC token exchange failed:', tokenRes.status)
    return sendText(res, 502, 'OAuth token exchange failed')
  }
  const access = (await tokenRes.json()).access_token
  if (!access) return sendText(res, 502, 'OAuth token exchange returned no access token')

  // read the trusted profile (only RC members can reach this point)
  const meRes = await fetch(RC_PROFILE, { headers: { Authorization: `Bearer ${access}` } })
  if (!meRes.ok) {
    console.error('RC profile fetch failed:', meRes.status)
    return sendText(res, 502, 'Failed to fetch Recurse profile')
  }
  const profile = await meRes.json()
  const id = profile.id != null ? String(profile.id) : 'unknown'
  const name = profile.name || 'Recurser'

  setSessionCookie(req, res, mintSession({ id, name }))
  res.writeHead(302, { Location: entry.redirect })
  return res.end()
}

const authLogout = (req, res) => {
  clearSessionCookie(res)
  return sendJson(res, 200, { ok: true })
}

const server = http.createServer(async (req, res) => {
  const method = req.method || 'GET'
  const url = new URL(req.url || '/', 'http://localhost')
  const path = url.pathname
  try {
    // health check for Disco / load balancers (was the root handler)
    if (path === '/healthz' || path === '/') return sendText(res, 200, 'ok')
    if (path === '/auth/me' && method === 'GET') return authMe(req, res)
    if (path === '/auth/login' && method === 'GET') return authLogin(req, res, url)
    if (path === '/auth/callback' && method === 'GET') return await authCallback(req, res, url)
    if (path === '/auth/logout' && method === 'POST') return authLogout(req, res)
    return sendText(res, 404, 'not found')
  } catch (err) {
    console.error('http handler error:', err)
    return sendText(res, 500, 'internal error')
  }
})

// ---------- WebSocket sync, gated on a valid session cookie ----------
const wss = new WebSocketServer({ noServer: true })
wss.on('connection', setupConn)
server.on('upgrade', (req, socket, head) => {
  const claims = AUTH_DEV
    ? { sub: 'dev', name: 'dev' }
    : verifySession(parseCookie(req.headers.cookie)[SESSION_COOKIE])
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (!claims) {
      // Accept the upgrade, then close with 4401 so the client can tell an auth
      // failure apart from a normal drop (a rejected handshake surfaces only as 1006).
      ws.close(4401, 'unauthorized')
      return
    }
    ws.user = { id: claims.sub, name: claims.name } // trusted identity for phase-2 use
    wss.emit('connection', ws, req)
  })
})

server.listen(PORT, HOST, () => console.log(`y-websocket server listening on ${HOST}:${PORT}`))
