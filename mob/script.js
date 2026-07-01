import * as Y from 'https://esm.sh/yjs@13'
import { WebsocketProvider } from 'https://esm.sh/y-websocket@3?deps=yjs@13'
// Fallback (no server, open 2 tabs): uncomment this and the provider line inside start().
// import { WebrtcProvider } from 'https://esm.sh/y-webrtc@10?deps=yjs@13'

// Where the Yjs sync server lives. Auto-detected from how the page is served:
//   • http  page (localhost / LAN IP / Tailscale) → ws://<same-host>:42420  (local dev)
//   • https page (Disco+Caddy, Cloudflare Tunnel, …) → the wss:// domain below
// Only PROD_SERVER needs editing once collab-server is deployed.
const PROD_SERVER = 'wss://collab.yourdomain.com'   // <-- your deployed collab-server domain
const SERVER = location.protocol === 'https:'
  ? PROD_SERVER
  : `ws://${location.hostname}:42420`
const APP_PREFIX = 'mob:'                        // server-side namespace

const FILES = ['html', 'css', 'js']
const STARTERS = {
  html: `<!-- HTML — p5 adds its canvas automatically.
     Put DOM elements, buttons, or sliders your sketch needs here. -->`,
  css: `/* CSS — style the page or the canvas here.
   (The canvas fills the preview by default.) */`,
  js: `// mobpad — code together; the sketch re-runs as you type.
// Move your mouse over the canvas. ⌘/Ctrl+Enter to force-run.
let trail = [];

function setup() {
  createCanvas(windowWidth, windowHeight);
  colorMode(HSB, 360, 100, 100, 1);
  noStroke();
}

function draw() {
  background(240, 30, 8, 0.15);
  trail.push({ x: mouseX, y: mouseY });
  if (trail.length > 40) trail.shift();
  trail.forEach((p, i) => {
    fill((frameCount + i * 6) % 360, 70, 100);
    circle(p.x, p.y, i * 0.9);
  });
}

function windowResized() { resizeCanvas(windowWidth, windowHeight); }`
}

const $ = (id) => document.getElementById(id)
const lobby = $('lobby'), roomInput = $('roomInput')

// ---------- room helpers ----------
const sanitize = (s) => (s || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-')
                          .replace(/^-+|-+$/g, '').slice(0, 48)
const readRoom = () => {
  const h = decodeURIComponent((location.hash || '').replace(/^#/, '')).trim()
  return sanitize(h.startsWith('room=') ? h.slice(5) : h)
}
const ADJ = ['coral','amber','mossy','lunar','brisk','vivid','quiet','sunny','teal','rusty','swift','calm']
const NOUN = ['otter','comet','maple','raven','pixel','delta','fern','koi','ember','wave','finch','dune']
const pick = (a) => a[Math.floor(Math.random() * a.length)]
const makeCode = () => `${pick(ADJ)}-${pick(NOUN)}-${Math.floor(Math.random() * 900 + 100)}`

// ---------- lobby actions ----------
const enter = (room) => {
  room = sanitize(room)
  if (!room) { roomInput.focus(); return }
  location.hash = 'room=' + room
  lobby.style.display = 'none'
  start(room)
}
$('create').onclick = () => enter(makeCode())
$('join').onclick = () => enter(roomInput.value)
roomInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') enter(roomInput.value) })
$('switch').onclick = () => { location.hash = ''; location.reload() }

// ---------- the collaborative app (runs once, for one room) ----------
let started = false
function start(room) {
  if (started) return
  started = true
  $('room').textContent = room

  const ydoc = new Y.Doc()
  const texts = {}
  FILES.forEach((f) => { texts[f] = ydoc.getText(f) })
  let active = 'js'

  const provider = new WebsocketProvider(SERVER, APP_PREFIX + room, ydoc)
  // Fallback instead of the line above:
  // const provider = new WebrtcProvider(APP_PREFIX + room, ydoc)

  const editor = $('editor'), stage = $('stage')
  const presenceEl = $('presence'), countEl = $('count'), autoChk = $('auto')
  const LOCAL = {}

  $('copy').onclick = async () => {
    const link = location.href.split('#')[0] + '#room=' + room
    try { await navigator.clipboard.writeText(link) } catch { prompt('Invite link:', link) }
  }

  // ---------- compose html + css + js into one sandboxed document ----------
  const buildDoc = () => {
    const css = texts.css.toString().replace(/<\/style>/gi, '<\\/style>')
    const body = texts.html.toString()
    const js = texts.js.toString().replace(/<\/script>/gi, '<\\/script>')
    return `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;overflow:hidden;background:#0f0f19}
${css}</style>
<script src="https://cdn.jsdelivr.net/npm/p5@1/lib/p5.min.js"><\/script>
<script>window.onerror=function(m,s,l){var p=document.getElementById('__e')||document.createElement('pre');p.id='__e';p.textContent='⚠ '+m+(l?' (line '+l+')':'');p.style.cssText='position:fixed;left:0;right:0;bottom:0;margin:0;padding:8px 10px;font:12px/1.4 ui-monospace,monospace;color:#ffb4b4;background:rgba(30,0,0,.9);white-space:pre-wrap;z-index:9';document.body.appendChild(p);return false}<\/script>
</head><body>
${body}
<script>
${js}
<\/script></body></html>`
  }
  const run = () => { stage.srcdoc = buildDoc() }
  let timer
  const scheduleRun = () => { if (!autoChk.checked) return; clearTimeout(timer); timer = setTimeout(run, 600) }

  // ---------- textarea <-> active Yjs text, with concurrent-edit cursor handling ----------
  const diff = (a, b) => {
    let s = 0
    while (s < a.length && s < b.length && a[s] === b[s]) s++
    let ae = a.length, be = b.length
    while (ae > s && be > s && a[ae - 1] === b[be - 1]) { ae--; be-- }
    return { start: s, del: ae - s, ins: b.slice(s, be) }
  }
  const transform = (idx, delta) => {
    let oldPos = 0
    for (const op of delta) {
      if (op.retain != null) oldPos += op.retain
      else if (op.insert != null) { if (oldPos <= idx) idx += op.insert.length }
      else if (op.delete != null) { if (oldPos < idx) idx -= Math.min(op.delete, idx - oldPos); oldPos += op.delete }
    }
    return idx
  }

  editor.addEventListener('input', () => {
    const t = texts[active]
    const { start, del, ins } = diff(t.toString(), editor.value)
    ydoc.transact(() => { if (del) t.delete(start, del); if (ins) t.insert(start, ins) }, LOCAL)
    scheduleRun()
  })

  // one observer per file: the active file drives the textarea; all files drive the preview
  FILES.forEach((f) => {
    texts[f].observe((e) => {
      if (f === active && e.transaction.origin !== LOCAL) {
        const a = editor.selectionStart, b = editor.selectionEnd
        editor.value = texts[f].toString()
        editor.setSelectionRange(transform(a, e.delta), transform(b, e.delta))
      }
      scheduleRun()
    })
  })

  editor.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run() }
    else if (e.key === 'Tab') {
      e.preventDefault()
      editor.setRangeText('  ', editor.selectionStart, editor.selectionEnd, 'end')
      editor.dispatchEvent(new Event('input'))
    }
  })
  $('run').onclick = run

  // ---------- tab switching ----------
  const tabEls = [...document.querySelectorAll('.tab')]
  const setActive = (f) => {
    active = f
    tabEls.forEach((b) => b.classList.toggle('active', b.dataset.file === f))
    editor.value = texts[f].toString()
    editor.setSelectionRange(0, 0)
    editor.focus()
  }
  tabEls.forEach((b) => b.addEventListener('click', () => setActive(b.dataset.file)))

  // ---------- presence ----------
  const palette = ['#ff8fa3', '#8fd3ff', '#b5f08f', '#ffd28f', '#c8a3ff', '#7df0d0']
  provider.awareness.setLocalStateField('user', {
    name: 'coder-' + Math.floor(Math.random() * 900 + 100),
    color: pick(palette)
  })
  const renderPresence = () => {
    const users = [...provider.awareness.getStates().values()].map(s => s.user).filter(Boolean)
    presenceEl.innerHTML = users.map(u => `<span class="chip" style="--c:${u.color}">${u.name}</span>`).join('')
    countEl.textContent = users.length + (users.length === 1 ? ' coder' : ' coders')
  }
  provider.awareness.on('change', renderPresence)

  // ---------- seed all three panes once per room ----------
  let seeded = false
  const seedIfEmpty = () => {
    if (seeded) return
    if (texts.html.length || texts.css.length || texts.js.length) return
    seeded = true
    ydoc.transact(() => {
      texts.html.insert(0, STARTERS.html)
      texts.css.insert(0, STARTERS.css)
      texts.js.insert(0, STARTERS.js)
    }, LOCAL)
    editor.value = texts[active].toString()
    run()
  }
  provider.on('synced', seedIfEmpty)
  setTimeout(seedIfEmpty, 1200)

  editor.value = texts[active].toString()
  renderPresence()
  run()
}

// ---------- boot ----------
const initial = readRoom()
if (initial) { lobby.style.display = 'none'; start(initial) }
