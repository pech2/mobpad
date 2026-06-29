import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync.js'
import * as awarenessProtocol from 'y-protocols/awareness.js'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { WebSocketServer } from 'ws'
import http from 'http'

const PORT = Number(process.env.PORT) || 1234
const HOST = process.env.HOST || '0.0.0.0'
const PING_TIMEOUT = 30000

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

const server = http.createServer((req, res) => {
  // plain health check so Disco / load balancers see a 200 on the root
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end('y-websocket server ok')
})
const wss = new WebSocketServer({ server })
wss.on('connection', setupConn)
server.listen(PORT, HOST, () => console.log(`y-websocket server listening on ${HOST}:${PORT}`))
