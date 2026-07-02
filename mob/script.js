import * as Y from 'https://esm.sh/yjs@13.6.31'
import { WebsocketProvider } from 'https://esm.sh/y-websocket@3'
// Fallback (no server, open 2 tabs): uncomment this and the provider line inside start().
// import { WebrtcProvider } from 'https://esm.sh/y-webrtc@10'

// CodeMirror 6 + its official Yjs binding (y-codemirror.next), loaded from a CDN
// so we keep the "no node_modules, no build step" deploy.
//
// @codemirror/state, @codemirror/view and yjs MUST each resolve to ONE module
// instance across every package, or CodeMirror throws "multiple instances of
// @codemirror/state" and yCollab silently fails to observe our Y.Text. We rely
// on esm.sh deduping by canonical URL: leaving the versions to resolve naturally
// makes every package share the same deep module. (Do NOT add ?deps= here — that
// forces variant builds on hashed paths that no longer match those canonical
// URLs, which reintroduces the duplicate-instance bug.)
import { EditorView, keymap } from 'https://esm.sh/@codemirror/view@6.43.4'
import { EditorState, Prec } from 'https://esm.sh/@codemirror/state@6.7.0'
import { basicSetup } from 'https://esm.sh/codemirror@6.0.2'
import { indentUnit } from 'https://esm.sh/@codemirror/language@6'
import { indentWithTab } from 'https://esm.sh/@codemirror/commands@6'
import { javascript } from 'https://esm.sh/@codemirror/lang-javascript@6'
import { html as htmlLang } from 'https://esm.sh/@codemirror/lang-html@6'
import { css as cssLang } from 'https://esm.sh/@codemirror/lang-css@6'
import { oneDark } from 'https://esm.sh/@codemirror/theme-one-dark@6'
import { yCollab } from 'https://esm.sh/y-codemirror.next@0.3'

// Single-origin deployment: the sync server lives behind the SAME host as this
// page, reverse-proxied at /collab (see mob/nginx.conf). The session cookie is
// carried automatically on the same-origin ws upgrade — no token in the URL.
//   • https page (Disco+Caddy)  → wss://<same-host>/collab
//   • http page (local / LAN)   → ws://<host>:42420 direct to the node server
//                                 (run it with AUTH_DEV=1; see README)
// Keyed on protocol, not hostname: deployment is always https behind Caddy, so
// any plain-http page (localhost, 127.0.0.1, or a LAN IP on another device) is
// dev and talks straight to the node server on 42420 with no manual editing.
const isDev = location.protocol !== 'https:'
const SERVER = isDev
  ? `ws://${location.hostname}:42420`
  : `wss://${location.host}/collab`
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

  // The ws gate closes unauthenticated sockets with code 4401. You can still edit
  // the room solo (the Yjs doc is local); syncing with others needs a Recurse login.
  // Stop retrying and surface a "Log in to sync" button in the header.
  provider.on('connection-close', (event) => {
    if (event && event.code === 4401) {
      provider.disconnect()
      const btn = $('syncLogin')
      btn.style.display = ''
      btn.onclick = goLogin
    }
  })

  const host = $('editorHost'), stage = $('stage')
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

  // ---------- CodeMirror editors: one view per file, each bound to its Y.Text ----------
  // yCollab drives CRDT sync AND remote-cursor rendering, replacing the old
  // hand-rolled diff/observe bridge and the caret "mirror". Because a remote
  // caret is a Y.RelativePosition scoped to one Y.Text, a peer viewing HTML
  // never renders a caret from the JS text — so cursors stay per-file, as before.
  const LANG = { html: htmlLang(), css: cssLang(), js: javascript() }
  // App chrome over oneDark's token colors: keep the room's #12121b palette.
  const appTheme = EditorView.theme({
    '&': { height: '100%', backgroundColor: '#12121b', color: '#d7e7ff' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace', fontSize: '13px', lineHeight: '1.55' },
    '.cm-content': { caretColor: '#d7e7ff', padding: '8px 0' },
    '.cm-gutters': { backgroundColor: '#12121b', color: '#454560', border: '0' },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,.03)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#8a8aa0' },
  }, { dark: true })

  // Each view lives in its own pane wrapper: CodeMirror forces
  // `.cm-editor { display: flex !important }`, so toggling display on the view
  // element itself can't hide it — we toggle the plain wrapper instead.
  const views = {}, panes = {}
  FILES.forEach((f) => {
    panes[f] = host.appendChild(Object.assign(document.createElement('div'), { className: 'pane' }))
    views[f] = new EditorView({
      parent: panes[f],
      state: EditorState.create({
        doc: texts[f].toString(),
        extensions: [
          basicSetup,
          LANG[f],
          indentUnit.of('  '),
          EditorState.tabSize.of(2),
          keymap.of([indentWithTab]),
          // ⌘/Ctrl+Enter forces a run; beat CM's default newline handling.
          Prec.highest(keymap.of([
            { key: 'Mod-Enter', preventDefault: true, run: () => { run(); return true } },
          ])),
          oneDark,
          appTheme,
          yCollab(texts[f], provider.awareness),
          // Local edits and applied remote updates both flip docChanged.
          EditorView.updateListener.of((u) => { if (u.docChanged) scheduleRun() }),
        ],
      }),
    })
  })
  $('run').onclick = run

  // ---------- tab switching ----------
  const tabEls = [...document.querySelectorAll('.tab')]
  const setActive = (f) => {
    active = f
    tabEls.forEach((b) => b.classList.toggle('active', b.dataset.file === f))
    FILES.forEach((x) => { panes[x].style.display = x === f ? '' : 'none' })
    views[f].focus()
  }
  tabEls.forEach((b) => b.addEventListener('click', () => setActive(b.dataset.file)))

  // ---------- presence + editable display name ----------
  const palette = ['#ff8fa3', '#8fd3ff', '#b5f08f', '#ffd28f', '#c8a3ff', '#7df0d0']
  const myColor = pick(palette)
  const nameInput = $('nameInput')
  const NAME_KEY = 'mobpad:name'
  const fallbackName = 'coder-' + Math.floor(Math.random() * 900 + 100)
  // Seed from the trusted Recurse profile name when we have one; otherwise the
  // remembered local name, then a random fallback.
  nameInput.value = (me && me.name) || localStorage.getItem(NAME_KEY) || fallbackName
  const publishName = () => {
    const name = nameInput.value.trim().slice(0, 24) || fallbackName
    provider.awareness.setLocalStateField('user', { name, color: myColor, colorLight: myColor + '33' })
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
  // yCollab renders remote carets/selections from awareness on its own; the
  // header toggle just shows or hides them via a class on the editor host.
  const cursorsChk = $('cursors')
  const applyCursorVis = () => host.classList.toggle('hide-remote-cursors', !cursorsChk.checked)
  cursorsChk.addEventListener('change', applyCursorVis)
  applyCursorVis()

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
    run()
  }
  provider.on('synced', seedIfEmpty)
  setTimeout(seedIfEmpty, 1200)

  setActive(active)
  renderPresence()
  run()
}

// ---------- auth (optional) ----------
// The app is usable without logging in: you can create/join a room and edit solo.
// Real-time SYNC needs a Recurse Center session (an HttpOnly cookie set by
// /auth/callback) — the ws gate rejects unauthenticated sockets with code 4401.
// `me` is the signed-in profile, or null when browsing anonymously.
let me = null
async function fetchMe() {
  if (isDev) return { id: 'local', name: null }
  try {
    const r = await fetch('/auth/me', { credentials: 'same-origin' })
    if (r.ok) return await r.json()
  } catch {}
  return null
}

// Kick off the Recurse OAuth flow, returning here (same room) afterwards.
const goLogin = () => {
  location.href = '/auth/login?redirect=' + encodeURIComponent(location.href)
}

// Clear the session cookie, then reload so sync drops back to solo editing.
const goLogout = async () => {
  try { await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }) } catch {}
  location.reload()
}

// Reflect sign-in state on the lobby login button.
function renderAuthStatus() {
  const btn = $('login'), note = $('authnote')
  if (me && me.name) {
    btn.textContent = 'Sign out'
    btn.disabled = false
    btn.onclick = goLogout
    note.textContent = ''
    note.append('Signed in as ', Object.assign(document.createElement('strong'), { textContent: me.name }), ' — rooms sync with your mob.')
  } else {
    btn.textContent = 'Log in with Recurse'
    btn.disabled = false
    btn.onclick = goLogin
  }
}

function boot() {
  renderAuthStatus()
  const initial = readRoom()
  if (initial) { lobby.style.display = 'none'; start(initial) }
}

;(async () => {
  me = await fetchMe()
  boot()
})()
