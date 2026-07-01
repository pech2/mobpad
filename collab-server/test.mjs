import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { WebSocket } from 'ws'
import { spawn } from 'child_process'

const wait = (ms) => new Promise(r => setTimeout(r, ms))
const URL = 'ws://localhost:42420'
const ROOM = 'testroom'

const srv = spawn('node', ['server.js'], { stdio: 'inherit' })
await wait(600)

let failed = false
const check = (cond, label) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failed = true }

// client A
const docA = new Y.Doc()
const provA = new WebsocketProvider(URL, ROOM, docA, { WebSocketPolyfill: WebSocket })
const textA = docA.getText('doc')

// client B
const docB = new Y.Doc()
const provB = new WebsocketProvider(URL, ROOM, docB, { WebSocketPolyfill: WebSocket })
const textB = docB.getText('doc')

await wait(800)
check(provA.wsconnected && provB.wsconnected, 'both clients connected')

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
const provC = new WebsocketProvider(URL, ROOM, docC, { WebSocketPolyfill: WebSocket })
await wait(800)
check(docC.getText('doc').toString() === textA.toString(), `late joiner C synced full doc (got: "${docC.getText('doc').toString()}")`)

provA.destroy(); provB.destroy(); provC.destroy()
await wait(300)
srv.kill()
await wait(200)
console.log(failed ? '\n=== SOME TESTS FAILED ===' : '\n=== ALL TESTS PASSED ===')
process.exit(failed ? 1 : 0)
