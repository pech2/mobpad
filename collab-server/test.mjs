import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { WebSocket } from 'ws'
import { spawn } from 'child_process'
import { mintSession, verifySession } from './session.js'

const SECRET = 'test-secret'
const wait = (ms) => new Promise(r => setTimeout(r, ms))
const URL = 'ws://localhost:42420'
const ROOM = 'testroom'

// Start the server with the gate ON (AUTH_DEV unset) and a known SESSION_SECRET
// so we can mint cookies that match.
const srv = spawn('node', ['server.js'], {
  stdio: 'inherit',
  env: { ...process.env, SESSION_SECRET: SECRET, AUTH_DEV: '' }
})
await wait(600)

let failed = false
const check = (cond, label) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failed = true }

// ---------- unit: session mint/verify ----------
{
  const tok = mintSession({ id: 'u1', name: 'Alice' }, SECRET)
  const claims = verifySession(tok, SECRET)
  check(!!claims && claims.sub === 'u1' && claims.name === 'Alice', 'verifySession round-trips a minted token')
  check(verifySession(tok, 'wrong-secret') === null, 'verifySession rejects a wrong secret')
  const tampered = tok.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))
  check(verifySession(tampered, SECRET) === null, 'verifySession rejects a tampered token')
  const expired = mintSession({ id: 'u1', name: 'Alice', ttlSeconds: -1 }, SECRET)
  check(verifySession(expired, SECRET) === null, 'verifySession rejects an expired token')
}

// ---------- ws gate: unauthenticated is closed with 4401 ----------
{
  const raw = new WebSocket(`${URL}/${ROOM}`)
  const code = await new Promise((resolve) => {
    raw.on('close', (c) => resolve(c))
    raw.on('error', () => {}) // some environments emit error alongside the close
    setTimeout(() => resolve(null), 2000)
  })
  check(code === 4401, `unauthenticated ws upgrade closed with 4401 (got: ${code})`)
}

// ---------- authenticated clients (cookie injected via a WebSocketPolyfill) ----------
// y-websocket only hands the URL to the polyfill, so we subclass ws to always
// attach a valid session cookie on the upgrade request.
const cookie = `mobpad_session=${mintSession({ id: 'alice', name: 'Alice' }, SECRET)}`
class AuthWS extends WebSocket {
  constructor (url) { super(url, [], { headers: { Cookie: cookie } }) }
}
const opts = { WebSocketPolyfill: AuthWS }

// client A
const docA = new Y.Doc()
const provA = new WebsocketProvider(URL, ROOM, docA, opts)
const textA = docA.getText('doc')

// client B
const docB = new Y.Doc()
const provB = new WebsocketProvider(URL, ROOM, docB, opts)
const textB = docB.getText('doc')

await wait(800)
check(provA.wsconnected && provB.wsconnected, 'both authenticated clients connected')

// A types -> B sees it
textA.insert(0, 'hello from A')
await wait(500)
check(textB.toString() === 'hello from A', `B received A's text (got: "${textB.toString()}")`)

// B edits concurrently in the middle -> merges, no overwrite
textB.insert(5, ' THERE')   // "hello THERE from A"
textA.insert(textA.length, '!')  // append on A side
await wait(600)
check(textA.toString() === textB.toString(), `concurrent edits converged (A:"${textA.toString()}" B:"${textB.toString()}")`)
check(textA.toString().includes('THERE') && textA.toString().includes('!'), 'both concurrent edits survived')

// awareness (cursor presence) propagates
provA.awareness.setLocalStateField('user', { name: 'Alice' })
await wait(400)
const namesSeenByB = Array.from(provB.awareness.getStates().values()).map(s => s.user && s.user.name).filter(Boolean)
check(namesSeenByB.includes('Alice'), `B sees A's awareness state (saw: ${JSON.stringify(namesSeenByB)})`)

// late joiner gets full history
const docC = new Y.Doc()
const provC = new WebsocketProvider(URL, ROOM, docC, opts)
await wait(800)
check(docC.getText('doc').toString() === textA.toString(), `late joiner C synced full doc (got: "${docC.getText('doc').toString()}")`)

provA.destroy(); provB.destroy(); provC.destroy()
await wait(300)
srv.kill()
await wait(200)
console.log(failed ? '\n=== SOME TESTS FAILED ===' : '\n=== ALL TESTS PASSED ===')
process.exit(failed ? 1 : 0)
