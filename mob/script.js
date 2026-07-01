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
const esc = (s) => (s || '').replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

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
    postCursor()
    renderCursors()
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
      renderCursors()
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
    postCursor()
    renderCursors()
  }
  tabEls.forEach((b) => b.addEventListener('click', () => setActive(b.dataset.file)))

  // ---------- presence + editable display name ----------
  const palette = ['#ff8fa3', '#8fd3ff', '#b5f08f', '#ffd28f', '#c8a3ff', '#7df0d0']
  const myColor = pick(palette)
  const nameInput = $('nameInput')
  const NAME_KEY = 'mobpad:name'
  const fallbackName = 'coder-' + Math.floor(Math.random() * 900 + 100)
  nameInput.value = localStorage.getItem(NAME_KEY) || fallbackName
  const publishName = () => {
    const name = nameInput.value.trim().slice(0, 24) || fallbackName
    provider.awareness.setLocalStateField('user', { name, color: myColor })
  }
  nameInput.addEventListener('input', () => {
    localStorage.setItem(NAME_KEY, nameInput.value.trim().slice(0, 24))
    publishName()
  })
  publishName()

  const renderPresence = () => {
    const chips = []
    provider.awareness.getStates().forEach((s, id) => {
      if (!s.user) return
      const me = id === provider.awareness.clientID
      chips.push(`<span class="chip" style="--c:${s.user.color}">${esc(s.user.name)}${me ? ' (you)' : ''}</span>`)
    })
    presenceEl.innerHTML = chips.join('')
    countEl.textContent = chips.length + (chips.length === 1 ? ' coder' : ' coders')
  }
  provider.awareness.on('change', renderPresence)

  // ---------- collaborator cursors (toggle in the top bar) ----------
  // Broadcast our caret through awareness; draw everyone else's over the textarea.
  // A hidden "mirror" div reproduces the textarea's wrapping to map a char index → x/y.
  const cursorLayer = $('cursorLayer'), cursorsChk = $('cursors')
  const mirror = document.createElement('div')
  mirror.className = 'caret-mirror'
  cursorLayer.appendChild(mirror)
  const MIRROR_PROPS = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant',
    'letterSpacing', 'wordSpacing', 'lineHeight', 'textTransform', 'textIndent', 'tabSize']
  const caretXY = (pos) => {
    const cs = getComputedStyle(editor)
    MIRROR_PROPS.forEach((p) => { mirror.style[p] = cs[p] })
    mirror.style.width = editor.clientWidth + 'px'
    mirror.textContent = editor.value.slice(0, pos)
    const marker = document.createElement('span')
    marker.textContent = editor.value.slice(pos) || '.'
    mirror.appendChild(marker)
    const x = marker.offsetLeft - editor.scrollLeft
    const y = marker.offsetTop - editor.scrollTop
    mirror.textContent = ''
    return { x, y, h: parseFloat(cs.lineHeight) || 18 }
  }
  const postCursor = () =>
    provider.awareness.setLocalStateField('cursor', { file: active, pos: editor.selectionEnd })
  let cursorRaf = 0
  const renderCursors = () => {
    if (cursorRaf) return
    cursorRaf = requestAnimationFrame(() => {
      cursorRaf = 0
      cursorLayer.querySelectorAll('.cursor').forEach((n) => n.remove())
      if (!cursorsChk.checked) return
      provider.awareness.getStates().forEach((state, id) => {
        if (id === provider.awareness.clientID) return
        const c = state.cursor, u = state.user
        if (!c || !u || c.file !== active) return
        const { x, y, h } = caretXY(Math.min(c.pos, editor.value.length))
        const el = document.createElement('div')
        el.className = 'cursor'
        el.style.cssText = `transform:translate(${x}px,${y}px);height:${h}px;--c:${u.color}`
        el.innerHTML = `<span class="cursor-flag">${esc(u.name)}</span>`
        cursorLayer.appendChild(el)
      })
    })
  }
  document.addEventListener('selectionchange', () => { if (document.activeElement === editor) postCursor() })
  editor.addEventListener('focus', postCursor)
  editor.addEventListener('scroll', renderCursors)
  window.addEventListener('resize', renderCursors)
  cursorsChk.addEventListener('change', renderCursors)
  provider.awareness.on('change', renderCursors)

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
  renderCursors()
  run()
}

// ---------- boot ----------
const initial = readRoom()
if (initial) { lobby.style.display = 'none'; start(initial) }
