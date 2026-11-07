// One full-width directDraw ticker key.
// 1. Scroll or page mode, one or two rows, quotes grouped into user-defined watchlist groups.
// 2. Settings live in settings.json in the config folder for the host OS (src/settings.js, src/paths.js),
//    watched for live edits. The on-bar menu (right-edge button) writes back to it.
// 3. FlexDesigner refuses draws until the bar is touched once (plugin.alive). Until then the plugin
//    keeps retrying and asks for a tap with a snackbar message.
const { plugin, logger } = require("@eniac/flexdesigner")
const { createCanvas, loadImage } = require("@napi-rs/canvas")
const finnhub = require("./finnhub.js")
const fs = require("node:fs")
const path = require("node:path")
const { ETF_NAMES, GROUP_COLORS, isIndex, parseSymbols, shortName } = require("./groups.js")
const history = require("./history.js")
const clock = require("./clock.js")
const massive = require("./massive.js")
const chart = require("./chart.js")
const { loadKey, saveKey, deleteKey } = require("./keys.js")
const { SETTINGS_FILE, FONTS, loadSettings, saveSettings, watchSettings, normalize } = require("./settings.js")

const TAPE_CID = "com.nop64.flexticker.tape"
const HEIGHT = 60
const SCROLL_FPS = 20 // full-frame PNG ceiling measured on device (~19.6 fps)
const IDLE_MS = 1000 // page mode redraw interval while nothing moves
const RETRY_MS = 2000 // retry interval while the key is not alive
const DRAW_TIMEOUT_MS = 5000 // a draw that takes longer is treated as failed (seen stuck after a USB unplug?)
const WAIT_LOG_MS = 30000 // while waiting for the key, log progress this often
const PAGE_TRANSITION_MS = 400
const MENU_BTN_W = 60
const WEIGHTS = [["normal", "Regular"], ["bold", "Bold"], ["900", "Heavy"]]
const ORIENTATIONS = [["auto", "Auto"], ["normal", "Normal"], ["rotated", "Rotated"]]
const LABELS = [["ticker", "Ticker"], ["name", "Name"], ["logo", "Ticker+Logo"]]
const FLASH_MS = 1200 // price highlight after a change
const TAP_SLOP = 40 // px either side of a tap that still counts as touching a quote
const DRAG_STALE_MS = 3000 // no touch event for this long during a drag: treat the drag as ended
const latest = new Map() // symbol -> Finnhub quote
const flashes = new Map() // symbol -> { at, up }: last price change, for the highlight
let feedStatus = "starting"

let tape = null // single tape key per plugin in this spike
let config = {} // plugin config.json (runtime state, not settings): { tape: { lastAlive }, names: { SYMBOL: "Name" } }
const deviceFlip = {} // serialNumber -> true when FlexDesigner screenFlip is on

logger.info(`Runtime: node ${process.version}, electron ${process.versions.electron || "none"}`)

// ---------- settings ----------

async function loadConfig() {
  try {
    const loaded = (await plugin.getConfig()) || {}
    // Keep names fetched before the first load.
    config = { ...loaded, names: { ...loaded.names, ...config.names } }
  } catch (e) {
    logger.error("getConfig failed:", e.message)
  }
}

function saveConfig() {
  plugin.setConfig(config).catch((e) => logger.error("setConfig failed:", e.message))
}

// Settings file. On first run it copies settings saved by earlier versions in plugin config.json.
function legacySettings() {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "config.json"), "utf8")).tape?.settings
  } catch {
    return undefined
  }
}

let settings
try {
  const r = loadSettings(legacySettings())
  settings = r.settings
  logger.info(`settings ${r.created ? "created" : "loaded"}: ${SETTINGS_FILE}`)
} catch (e) {
  // Bad JSON: run on defaults but leave the file alone so the user can fix it.
  settings = normalize({})
  logger.error(`settings file invalid, using defaults until fixed: ${e.message}`)
}

watchSettings((s) => {
  settings = s
  if (tape) {
    tape.s = s
    wake(tape)
  }
  logger.info("settings reloaded")
}, (e) => logger.error(`settings file invalid, keeping previous settings: ${e.message}`))

function isRotated(t) {
  const o = t.s.orientation
  return o === "rotated" || (o === "auto" && deviceFlip[t.serialNumber] === true)
}

function cycle(list, current) {
  const i = list.findIndex((v) => (Array.isArray(v) ? v[0] : v) === current)
  const next = list[(i + 1) % list.length]
  return Array.isArray(next) ? next[0] : next
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v))
}

// ---------- watchlist ----------

function currentGroups() {
  return settings.groups
}

function allSymbols() {
  return [...new Set(currentGroups().flatMap((g) => parseSymbols(g.symbols)))]
}

function displayName(sym) {
  return ETF_NAMES[sym] || config.names?.[sym] || sym
}

// The group the tape is filtered to (tap a group tag), or null for all groups.
// Clears itself if that group is no longer in the settings.
function filterGroup(t) {
  if (!t?.filter) return null
  const g = currentGroups().find((x) => x.name.toUpperCase() === t.filter)
  if (!g) t.filter = null
  return g || null
}

// Symbols to poll: only the filtered group while a filter is on, so it refreshes faster.
// Indices have no Finnhub quote; indexQuotes() fills them from history.
function pollSymbols() {
  const g = filterGroup(tape)
  return (g ? parseSymbols(g.symbols) : allSymbols()).filter((sym) => !isIndex(sym))
}

// Index quotes from the last two Massive daily bars: last close and its change. close: true marks
// them on the tape, since they do not move during the day.
function indexQuotes() {
  for (const sym of allSymbols().filter(isIndex)) {
    const b = history.bars(sym, "1d", Date.now() - 14 * 86400000)
    if (b.length < 2) continue
    const [p, c] = b.slice(-2)
    latest.set(sym, { symbol: sym, price: c.c, change: c.c - p.c, pct: (c.c - p.c) / p.c * 100, prevClose: p.c, time: c.t / 1000, close: true })
  }
}

// Groups with the quotes received so far. Empty groups are left out.
function groupView(t) {
  const only = filterGroup(t)
  return currentGroups().map((g, gi) => ({
    name: String(g.name || `Group ${gi + 1}`).toUpperCase(),
    color: GROUP_COLORS[gi % GROUP_COLORS.length],
    quotes: parseSymbols(g.symbols).filter((sym) => latest.has(sym)).map((sym) => {
      const q = latest.get(sym)
      return { sym, label: t.s.label === "name" ? displayName(sym) : sym.replace(/^[A-Z]+:/, ""), logo: t.s.label === "logo" && t.s.rows === 1 ? logos.get(sym) || null : null, price: q.price, pct: q.pct, close: q.close, flash: flashLevel(sym) }
    }).sort((a, b) => a.label.localeCompare(b.label)), // alphabetical by the shown label (ticker or name)
  })).filter((g) => g.quotes.length && (!only || g.name === t.filter))
}

// 1 right after a price change, fading to 0 over FLASH_MS. null when no flash.
function flashLevel(sym, now = Date.now()) {
  const f = flashes.get(sym)
  if (!f) return null
  const a = 1 - (now - f.at) / FLASH_MS
  if (a <= 0) {
    flashes.delete(sym)
    return null
  }
  return { a, up: f.up }
}

// ---------- logos ----------
// Decoded icons from the history database, for the "logo" label. Symbols without one stay out and are
// checked again every 60 s, so logos appear as the collector fetches them.
const logos = new Map() // symbol -> Image

async function loadLogos() {
  for (const sym of allSymbols()) {
    if (logos.has(sym)) continue
    try {
      const png = history.logo(sym)?.png
      if (png) logos.set(sym, await loadImage(Buffer.from(png)))
    } catch (e) {
      logger.error(`logo ${sym}: ${e.message}`)
    }
  }
}

// ---------- rendering ----------

const GAP = 60 // space between quotes
const COL_PAD = 12 // space between label, price and change in page columns
const PAGE_GAP = 40 // minimum space between page columns
const UP = "#22e07a"
const DOWN = "#ff4d5e"

function rowLayout(t) {
  const rows = t.s.rows
  const size = rows === 2 ? Math.min(t.s.size, 26) : t.s.size
  const rowH = HEIGHT / rows
  const baselines = Array.from({ length: rows }, (_, r) => Math.round(r * rowH + rowH / 2 + size * 0.35))
  return { rows, size, rowH, baselines }
}

function parts(q) {
  const up = q.pct >= 0
  const chg = `${up ? "▲" : "▼"}${Math.abs(q.pct).toFixed(1)}%${q.close ? " close" : ""}`
  return { price: q.price.toFixed(2), chg, color: up ? UP : DOWN }
}

// Price text, with a fading box behind it for FLASH_MS after a change. Box color is the tick
// direction (this update vs the last), which can differ from the day change color.
function drawPrice(ctx, L, q, text, x, y, r, color) {
  const w = textW(ctx, text)
  if (q.flash) {
    ctx.globalAlpha = 0.55 * q.flash.a
    ctx.fillStyle = q.flash.up ? UP : DOWN
    ctx.fillRect(x - 4, r * L.rowH + 4, w + 8, L.rowH - 8)
    ctx.globalAlpha = 1
  }
  ctx.fillStyle = q.flash ? "#fff" : color
  ctx.fillText(text, x, y)
  return w
}

// Logo tile, one row only (too small to read on two rows): as tall as the text, capped by the row height. Width it adds before the label, 0 without a logo.
const logoSize = (L) => Math.min(L.rowH - 8, L.size)
const logoW = (L, q) => (q.logo ? logoSize(L) + 8 : 0)

// Rounded white tile (Massive icons are opaque white squares), icon scaled up a little to trim its margin.
function drawLogo(ctx, L, q, x, r) {
  const s = logoSize(L)
  const y = Math.round(r * L.rowH + (L.rowH - s) / 2)
  ctx.save()
  ctx.beginPath()
  ctx.roundRect(x, y, s, s, Math.round(s * 0.22))
  ctx.clip()
  ctx.fillStyle = "#fff"
  ctx.fillRect(x, y, s, s)
  ctx.drawImage(q.logo, x - s * 0.1, y - s * 0.1, s * 1.2, s * 1.2)
  ctx.restore()
}

function textW(ctx, text) {
  return Math.ceil(ctx.measureText(text).width)
}

// Group tag: colored bar plus group name in a smaller font, centered in the band top..top+h.
function tagSize(L) {
  return Math.round(Math.min(L.size, 24) * 0.7)
}

function drawTag(ctx, t, L, g, x, top, h) {
  ctx.fillStyle = g.color
  ctx.fillRect(x, top + 5, 4, h - 10)
  const font = ctx.font
  ctx.font = `bold ${tagSize(L)}px "${t.s.font}"`
  if (t.filter) {
    // Filtered: tint behind the name, so it is clear other groups are hidden.
    ctx.globalAlpha = 0.25
    ctx.fillRect(x + 4, top + 5, 16 + textW(ctx, g.name), h - 10)
    ctx.globalAlpha = 1
  }
  ctx.fillText(g.name, x + 12, Math.round(top + h / 2 + tagSize(L) * 0.35))
  const w = 12 + textW(ctx, g.name)
  ctx.font = font
  // Tap target, padded because tags are small. Read by handleTap.
  t.hits.push({ x0: x - 15, x1: x + w + 15, name: g.name })
}

function tagWidth(ctx, t, L, g) {
  const font = ctx.font
  ctx.font = `bold ${tagSize(L)}px "${t.s.font}"`
  const w = 12 + textW(ctx, g.name)
  ctx.font = font
  return w
}

// ----- scroll mode -----
// Each row is its own stream: for every group, a tag then that row's share of the group's quotes.
// Rows have different lengths, which gives the staggered look in two-row mode.

// tags false (filtered tape): no tags, the one group's tag is shown in the left block instead.
function rowStream(groups, rows, r, tags) {
  const items = []
  for (const g of groups) {
    if (tags) items.push({ tag: g })
    g.quotes.forEach((q, i) => { if (i % rows === r) items.push({ q }) })
  }
  return items
}

function itemWidth(ctx, t, L, item) {
  if (item.tag) return tagWidth(ctx, t, L, item.tag)
  const p = parts(item.q)
  return logoW(L, item.q) + textW(ctx, item.q.label) + textW(ctx, ` ${p.price}`) + textW(ctx, ` ${p.chg}`)
}

function drawItem(ctx, t, L, item, x, r) {
  if (item.tag) {
    // Each row has its own tag in its own band, since rows scroll at different offsets.
    drawTag(ctx, t, L, item.tag, x, r * L.rowH, L.rowH)
    return
  }
  const y = L.baselines[r]
  const p = parts(item.q)
  const x0 = x
  if (item.q.logo) drawLogo(ctx, L, item.q, x, r)
  x += logoW(L, item.q)
  ctx.fillStyle = "#fff"
  ctx.fillText(item.q.label, x, y)
  const space = textW(ctx, " ")
  const px = x + textW(ctx, item.q.label) + space
  const pw = drawPrice(ctx, L, item.q, p.price, px, y, r, p.color)
  ctx.fillStyle = p.color
  ctx.fillText(` ${p.chg}`, px + pw, y)
  t.hits.push({ x0: x0 - GAP / 2, x1: px + pw + textW(ctx, ` ${p.chg}`) + GAP / 2, sym: item.q.sym, r })
}

function drawScroll(ctx, t, L, groups, areaW) {
  for (let r = 0; r < L.rows; r++) {
    const items = rowStream(groups, L.rows, r, !t.filter)
    const widths = items.map((it) => itemWidth(ctx, t, L, it))
    const cycleW = widths.reduce((a, b) => a + b + GAP, 0)
    t.scroll[r] = ((t.scroll[r] % cycleW) + cycleW) % cycleW
    let x = -t.scroll[r]
    while (x < areaW) {
      items.forEach((it, i) => {
        if (x + widths[i] > 0 && x < areaW) drawItem(ctx, t, L, it, x, r)
        x += widths[i] + GAP
      })
    }
  }
}

// ----- page mode -----
// A page holds quotes from one group only. Group tag at the left, then a column grid:
// label left aligned, price right aligned, change left aligned.
// Each group gets its own grid, sized to its own widest label, price and tag, so one long name or
// price (BTC) does not widen every page.

function pageLayout(ctx, t, L, groups, areaW) {
  const pages = []
  for (const g of groups) {
    const m = { label: 0, price: 0, chg: 0 }
    for (const q of g.quotes) {
      const p = parts(q)
      m.label = Math.max(m.label, logoW(L, q) + textW(ctx, q.label))
      m.price = Math.max(m.price, textW(ctx, p.price))
      m.chg = Math.max(m.chg, textW(ctx, p.chg))
    }
    const tagArea = t.filter ? 10 : tagWidth(ctx, t, L, g) + 30 // filtered: tag is in the left block
    const content = m.label + COL_PAD + m.price + COL_PAD + m.chg
    const n = Math.max(1, Math.floor((areaW - tagArea) / (content + PAGE_GAP)))
    const cellW = Math.floor((areaW - tagArea) / n)
    const grid = { ...m, n, cellW, tagArea, inset: Math.floor((cellW - content) / 2) }
    const perPage = n * L.rows
    for (let i = 0; i < g.quotes.length; i += perPage) pages.push({ g, grid, quotes: g.quotes.slice(i, i + perPage) })
  }
  return { pages }
}

function drawPage(ctx, t, L, page, dy) {
  const P = page.grid
  ctx.save()
  ctx.translate(0, dy)
  const hits = t.hits.length
  if (!t.filter) drawTag(ctx, t, L, page.g, 10, 0, HEIGHT)
  if (dy !== 0) t.hits.length = hits // no tap target on a page sliding in or out
  page.quotes.forEach((q, k) => {
    const p = parts(q)
    // Column-major, so two-row pages stack quotes in pairs.
    const x = P.tagArea + Math.floor(k / L.rows) * P.cellW + P.inset
    const y = L.baselines[k % L.rows]
    const priceRight = x + P.label + COL_PAD + P.price
    if (q.logo) drawLogo(ctx, L, q, x, k % L.rows)
    ctx.fillStyle = "#fff"
    ctx.fillText(q.label, x + logoW(L, q), y)
    drawPrice(ctx, L, q, p.price, priceRight - textW(ctx, p.price), y, k % L.rows, p.color)
    ctx.fillStyle = p.color
    ctx.fillText(p.chg, priceRight + COL_PAD, y)
    if (dy === 0) t.hits.push({ x0: x - P.inset, x1: x - P.inset + P.cellW, sym: q.sym, r: k % L.rows })
  })
  ctx.restore()
}

function drawPages(ctx, t, L, groups, areaW, now) {
  const P = pageLayout(ctx, t, L, groups, areaW)
  const count = P.pages.length
  const idx = ((t.page % count) + count) % count
  const p = t.transStart ? clamp((now - t.transStart) / PAGE_TRANSITION_MS, 0, 1) : 1
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, areaW, HEIGHT)
  ctx.clip()
  if (p < 1 && count > 1) {
    // Slide: old page moves out, new page moves in, direction set by t.transDir.
    const prev = (((idx - t.transDir) % count) + count) % count
    const shift = Math.round(p * HEIGHT) * t.transDir
    drawPage(ctx, t, L, P.pages[prev], -shift)
    drawPage(ctx, t, L, P.pages[idx], HEIGHT * t.transDir - shift)
  } else {
    drawPage(ctx, t, L, P.pages[idx], 0)
  }
  ctx.restore()
}

// Shown while the tape is paused, left of the menu button. Tap to resume.
function drawResumeButton(ctx, t, w) {
  const x = w - 2 * MENU_BTN_W
  ctx.fillStyle = "#000"
  ctx.fillRect(x, 0, MENU_BTN_W, HEIGHT)
  ctx.fillStyle = "#ffb74d"
  ctx.beginPath()
  ctx.moveTo(x + 22, 18)
  ctx.lineTo(x + 42, 30)
  ctx.lineTo(x + 22, 42)
  ctx.closePath()
  ctx.fill()
  t.hits.push({ x0: x, x1: x + MENU_BTN_W, resume: true })
}

// Picker: the quotes near a tap, as big buttons, when a tap could mean more than one.
function drawPicker(ctx, t, w) {
  const syms = t.pick
  const cellW = Math.min(400, Math.floor((w - MENU_BTN_W) / syms.length))
  ctx.font = `bold 15px "${t.s.font}"`
  ctx.fillStyle = "#888"
  ctx.fillText("Chart which?", 14, 36)
  const x0 = 150
  syms.forEach((sym, i) => {
    const x = x0 + i * cellW
    const q = latest.get(sym)
    ctx.fillStyle = "#1a1a1a"
    ctx.fillRect(x + 6, 6, cellW - 12, HEIGHT - 12)
    ctx.font = `bold 26px "${t.s.font}"`
    ctx.fillStyle = "#fff"
    const label = displayName(sym).replace(/^[A-Z]+:/, "")
    ctx.fillText(label, x + 20, 40)
    const lw = textW(ctx, label)
    if (q) {
      const p = parts(q)
      ctx.font = `22px "${t.s.font}"`
      ctx.fillStyle = p.color
      ctx.fillText(`${p.price} ${p.chg}`, x + 32 + lw, 40)
    }
    t.hits.push({ x0: x, x1: x + cellW, sym })
  })
  drawCancel(ctx, w)
}

// Group picker (tap the status block): one full-height button per group with quotes, in settings
// order. Tap one to show only that group. One row, since the touch y is unreliable at 30 px per row.
function drawGroupPicker(ctx, t, w) {
  const groups = groupView(t)
  ctx.font = `bold 15px "${t.s.font}"`
  ctx.fillStyle = "#888"
  ctx.fillText("Show group", 14, 36)
  const x0 = 150
  const cellW = Math.min(400, Math.floor((w - MENU_BTN_W - x0) / Math.max(1, groups.length)))
  // One size for all names, shrunk until the longest fits its button.
  let size = 22
  const widest = () => {
    ctx.font = `bold ${size}px "${t.s.font}"`
    return Math.max(0, ...groups.map((g) => textW(ctx, g.name)))
  }
  while (size > 12 && widest() > cellW - 40) size--
  groups.forEach((g, i) => {
    const x = x0 + i * cellW
    ctx.fillStyle = "#1a1a1a"
    ctx.fillRect(x + 6, 6, cellW - 12, HEIGHT - 12)
    ctx.fillStyle = g.color
    ctx.fillRect(x + 14, 14, 4, HEIGHT - 28)
    ctx.fillText(g.name, x + 26, Math.round(HEIGHT / 2 + size * 0.35))
    t.hits.push({ x0: x, x1: x + cellW, name: g.name })
  })
  drawCancel(ctx, w)
}

// Cancel, in the menu button's place.
function drawCancel(ctx, w) {
  const bx = w - MENU_BTN_W
  ctx.fillStyle = "#111"
  ctx.fillRect(bx, 0, MENU_BTN_W, HEIGHT)
  ctx.strokeStyle = "#aaa"
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.moveTo(bx + 20, 20)
  ctx.lineTo(bx + MENU_BTN_W - 20, HEIGHT - 20)
  ctx.moveTo(bx + MENU_BTN_W - 20, 20)
  ctx.lineTo(bx + 20, HEIGHT - 20)
  ctx.stroke()
}

function drawMenuButton(ctx, w) {
  const x = w - MENU_BTN_W
  ctx.fillStyle = "#111"
  ctx.fillRect(x, 0, MENU_BTN_W, HEIGHT)
  ctx.fillStyle = "#888"
  for (const dy of [-10, 0, 10]) ctx.fillRect(x + 18, HEIGHT / 2 + dy - 2, 24, 4)
}

// Menu cells: each has a label and a handler receiving the tap side (-1 left half, +1 right half).
function menuCells(t) {
  const s = t.s
  const weightName = (WEIGHTS.find((x) => x[0] === s.weight) || WEIGHTS[1])[1]
  const orientName = (ORIENTATIONS.find((x) => x[0] === s.orientation) || ORIENTATIONS[0])[1]
  const effSize = s.rows === 2 ? Math.min(s.size, 26) : s.size
  const cells = [
    { label: `Mode: ${s.mode === "scroll" ? "Scroll" : "Page"}`, tap: () => { s.mode = s.mode === "scroll" ? "page" : "scroll" } },
    { label: `Rows: ${s.rows}`, tap: () => { s.rows = s.rows === 1 ? 2 : 1 } },
    { label: `−  Size ${effSize}  +`, tap: (d) => { s.size = clamp(s.size + d * 2, 18, 48) } },
    s.mode === "scroll"
      ? { label: `−  Speed ${s.speed}  +`, tap: (d) => { s.speed = clamp(s.speed + d * 20, 0, 300) } }
      : { label: `−  Page ${s.dwell}s  +`, tap: (d) => { s.dwell = clamp(s.dwell + d, 2, 20) } },
    { label: `‹  ${s.font}  ›`, tap: (d) => {
      const i = FONTS.indexOf(s.font)
      s.font = FONTS[(i + d + FONTS.length) % FONTS.length]
    } },
    { label: `Label: ${(LABELS.find((x) => x[0] === s.label) || LABELS[0])[1]}`, tap: () => { s.label = cycle(LABELS, s.label) } },
    { label: `Weight: ${weightName}`, tap: () => { s.weight = cycle(WEIGHTS, s.weight) } },
    { label: `Orient: ${orientName}`, tap: () => { s.orientation = cycle(ORIENTATIONS, s.orientation) } },
    { label: "Done", tap: () => { t.menu = false; saveSettings(t.s) } },
  ]
  return cells
}

function drawMenu(ctx, t, w) {
  const cells = menuCells(t)
  const cw = Math.floor(w / cells.length)
  ctx.font = `bold 20px "${FONTS[0]}"`
  cells.forEach((c, i) => {
    const x = i * cw
    ctx.fillStyle = i % 2 ? "#141414" : "#0a0a0a"
    ctx.fillRect(x, 0, cw, HEIGHT)
    ctx.fillStyle = c.label === "Done" ? "#22e07a" : "#ddd"
    const lw = Math.ceil(ctx.measureText(c.label).width)
    ctx.fillText(c.label, x + Math.floor((cw - lw) / 2), 37)
  })
  ctx.font = "12px Menlo"
  ctx.fillStyle = "#666"
  ctx.fillText(`${t.fps.toFixed(1)} fps`, w - 70, 14)
}

function renderFrame(t, now) {
  const ctx = t.ctx
  const w = t.width
  if (isRotated(t)) ctx.setTransform(-1, 0, 0, -1, w, HEIGHT)
  else ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.fillStyle = "#000"
  ctx.fillRect(0, 0, w, HEIGHT)

  if (t.menu) {
    drawMenu(ctx, t, w)
  } else if (t.pick) {
    t.hits = []
    drawPicker(ctx, t, w)
  } else if (t.groupPick) {
    t.hits = []
    drawGroupPicker(ctx, t, w)
  } else if (t.chart) {
    t.hits = []
    chart.drawChart(ctx, t.chart, latest.get(t.chart.sym), w, MENU_BTN_W, t.s.font, t.hits)
  } else {
    t.hits = []
    const groups = groupView(t)
    const only = t.filter ? groups[0] : null
    clock.drawClock(ctx, t.s.font, now, only)
    // Tape area: right of the clock, left of the menu button. Drawn in its own coordinates, then
    // tap targets are moved to bar coordinates.
    const areaW = w - MENU_BTN_W - clock.CLOCK_W
    ctx.save()
    ctx.translate(clock.CLOCK_W, 0)
    ctx.beginPath()
    ctx.rect(0, 0, areaW, HEIGHT)
    ctx.clip()
    if (!groups.length) {
      ctx.font = `bold 22px "${FONTS[0]}"`
      ctx.fillStyle = "#888"
      ctx.fillText(`Flex Ticker: ${feedStatus}`, 20, 38)
    } else {
      const L = rowLayout(t)
      ctx.font = `${t.s.weight} ${L.size}px "${t.s.font}"`
      if (t.s.mode === "scroll") drawScroll(ctx, t, L, groups, areaW)
      else drawPages(ctx, t, L, groups, areaW, now)
    }
    ctx.restore()
    for (const h of t.hits) { h.x0 += clock.CLOCK_W; h.x1 += clock.CLOCK_W }
    // The filtered group's tag in the left block: tap the block to show all groups again.
    if (only) t.hits.push({ x0: 0, x1: clock.CLOCK_W, name: only.name })
    if (t.paused) drawResumeButton(ctx, t, w)
    drawMenuButton(ctx, w)
  }
  return t.canvas.toDataURL("image/png")
}

// ---------- draw loop ----------

function advance(t, now) {
  // A lost touch 'end' would leave the tape stopped while the loop keeps drawing. Release after a quiet spell.
  if (t.dragging && now - t.touchAt > DRAG_STALE_MS) {
    t.dragging = false
    if (t.chart) t.chart.scrubX = null
    logger.info("touch end missing, releasing drag")
  }
  if (t.menu || t.chart || t.pick || t.groupPick || t.paused || t.dragging) return
  if (t.s.mode === "scroll") {
    // Fixed whole-pixel step per frame. Uneven steps read as blur.
    const step = Math.round(t.s.speed / SCROLL_FPS)
    for (let r = 0; r < 2; r++) t.scroll[r] = (t.scroll[r] || 0) + step
  } else if (now - t.pageShownAt >= t.s.dwell * 1000) {
    turnPage(t, 1, now)
  }
}

function turnPage(t, dir, now) {
  t.page += dir
  t.transDir = dir
  t.transStart = now
  t.pageShownAt = now
}

// True while any flash is fading. Drops finished ones, including symbols no longer shown.
function flashing(now) {
  for (const [sym, f] of flashes) if (now - f.at >= FLASH_MS) flashes.delete(sym)
  return flashes.size > 0
}

function nextDelay(t, now, elapsed) {
  const moving = t.menu || t.dragging || flashing(now) ||
    (t.s.mode === "scroll" && !t.paused && t.s.speed > 0) ||
    (t.transStart && now - t.transStart < PAGE_TRANSITION_MS)
  if (!moving && t.transStart && now - t.transStart >= PAGE_TRANSITION_MS) t.transStart = 0
  return moving ? Math.max(0, 1000 / SCROLL_FPS - elapsed) : IDLE_MS
}

async function loop() {
  const t = tape
  // One draw chain only. A second chain (e.g. woken by a tap mid-draw) doubled the scroll speed.
  if (!t || t.drawing) return
  t.drawing = true
  const start = Date.now()
  let delay
  try {
    t.lastFrame = renderFrame(t, start)
    let timer
    await Promise.race([
      plugin.directDraw(t.serialNumber, t.key, t.lastFrame),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("draw timed out")), DRAW_TIMEOUT_MS) }),
    ]).finally(() => clearTimeout(timer))
    if (t.waiting) logger.info(`tape key accepted, drawing (after ${t.retries} retries)`)
    t.waiting = false
    const now = Date.now()
    advance(t, now)
    t.frames++
    if (now - t.fpsStart >= 1000) {
      t.fps = (t.frames * 1000) / (now - t.fpsStart)
      t.frames = 0
      t.fpsStart = now
    }
    delay = nextDelay(t, now, now - start)
  } catch (e) {
    if (/not alive/i.test(e.message)) {
      // Key not on screen (page change, sleep, upload). Retry slowly instead of waiting for a tap.
      if (!t.waiting) {
        logger.info("tape key not alive, retrying every 2 s")
        t.retries = 0
        t.waitLogAt = Date.now()
      }
      t.waiting = true
      t.retries++
      if (Date.now() - t.waitLogAt >= WAIT_LOG_MS) {
        logger.info(`still waiting for tape key: ${t.retries} retries, all refused as not alive`)
        t.waitLogAt = Date.now()
      }
      delay = RETRY_MS
    } else {
      logger.error(`directDraw failed: ${e.message.slice(0, 120)}`)
      delay = RETRY_MS
    }
  }
  t.drawing = false
  if (tape === t) t.timer = setTimeout(loop, delay)
}

// Draw the next frame now. If a frame is in flight, it schedules the next one itself.
function wake(t) {
  clearTimeout(t.timer)
  if (!t.drawing) t.timer = setTimeout(loop, 0)
}

function startTape(serialNumber, key) {
  if (tape) {
    clearTimeout(tape.timer)
    tape.key = key
    tape.serialNumber = serialNumber
    tape.s = settings
    wake(tape)
    return
  }
  const width = key.width || 2170
  const canvas = createCanvas(width, HEIGHT)
  tape = {
    serialNumber, key, width, canvas, ctx: canvas.getContext("2d"),
    s: settings, menu: false, paused: false, waiting: false, pick: null, groupPick: false,
    scroll: [0, 0],
    page: 0, pageShownAt: Date.now(), transStart: 0, transDir: 1,
    frames: 0, fps: 0, fpsStart: Date.now(), timer: null,
    dragging: false, touchAt: 0, touchX: 0, touchStartX: 0, touchStartT: 0,
  }
  loop()
}

// ---------- events ----------

function updateDeviceFlip(devices) {
  for (const d of devices || []) {
    const flip = d.deviceData?.config?.screenFlip
    if (flip !== undefined) deviceFlip[d.serialNumber] = flip === 1 || flip === true
  }
}

plugin.on("device.status", (devices) => {
  // Logged to learn what FlexDesigner sends when the bar is plugged back in.
  logger.info(`device.status: ${JSON.stringify((devices || []).map((d) => ({ sn: d.serialNumber, status: d.status, connected: d.connected, keys: Object.keys(d) })))}`.slice(0, 300))
  updateDeviceFlip(devices)
  if (tape) wake(tape)
  for (const d of devices || []) if (d.status === "connected" && tape?.waiting && d.serialNumber === tape.serialNumber) wakeBar(tape)
})

// After a USB replug FlexDesigner refuses draws ("not alive") until the bar is touched, which sends
// plugin.alive. Tested 2026-11-05/06: sys.wake, sys.sleep then sys.wake, and dynamickey.refresh all
// left the key refused. So ask for the touch with a device message.
async function wakeBar(t) {
  await new Promise((r) => setTimeout(r, 3000)) // let the bar finish starting up
  if (tape !== t || !t.waiting) return
  try {
    await plugin.showFlexbarSnackbarMessage(t.serialNumber, "Flex Ticker: tap the bar to resume", "info", "refresh", 10000)
    logger.info("bar reconnected, asked for a tap on the bar")
  } catch (e) {
    logger.error(`reconnect message failed: ${e.message}`)
  }
}

plugin.on("plugin.alive", async (payload) => {
  const key = payload.keys.find((k) => k.cid === TAPE_CID)
  if (!key) return
  logger.info(`plugin.alive for tape key${tape?.waiting ? " while waiting" : ""}`)
  try {
    updateDeviceFlip(await plugin.getDeviceStatus())
  } catch (e) {
    logger.error("getDeviceStatus failed:", e.message)
  }
  await loadConfig()
  config.tape = { ...config.tape, lastAlive: { serialNumber: payload.serialNumber, key } }
  startTape(payload.serialNumber, key)
  saveConfig()
})

plugin.on("plugin.dead", (payload) => {
  if (tape && payload.keys.some((k) => k.uid === tape.key.uid)) {
    clearTimeout(tape.timer)
    tape = null
  }
})

// row: 0 or 1 from the touch y, or null when unknown.
function handleTap(t, x, row) {
  if (t.menu) {
    const cells = menuCells(t)
    const cw = Math.floor(t.width / cells.length)
    const i = clamp(Math.floor(x / cw), 0, cells.length - 1)
    const side = x - i * cw < cw / 2 ? -1 : 1
    cells[i].tap(side)
    return
  }
  if (t.chart) {
    // Chart: close button (in the menu button's place) or a range chip.
    if (x >= t.width - MENU_BTN_W) t.chart = null
    else {
      const chip = (t.hits || []).find((h) => h.range && x >= h.x0 && x <= h.x1)
      if (chip) t.chart.range = chip.range
    }
    return
  }
  if (t.pick) {
    // Picker: a quote opens its chart, anything else (cancel, gaps) goes back to the tape.
    const hit = (t.hits || []).find((h) => h.sym && x >= h.x0 && x <= h.x1)
    t.pick = null
    if (hit && x < t.width - MENU_BTN_W) openChart(t, hit.sym)
    return
  }
  if (t.groupPick) {
    // Group picker: a group filters the tape to it, anything else (cancel, gaps) goes back.
    const hit = (t.hits || []).find((h) => h.name && x >= h.x0 && x <= h.x1)
    t.groupPick = false
    if (hit && x < t.width - MENU_BTN_W) setFilter(t, hit.name)
    return
  }
  if (x >= t.width - MENU_BTN_W) {
    t.menu = true
    return
  }
  if ((t.hits || []).some((h) => h.resume && x >= h.x0 && x <= h.x1)) {
    t.paused = false
    return
  }
  // Status block, no filter on: pick a group. With a filter on, the block holds the group's tag,
  // and tapping it shows all groups again (below).
  if (!t.filter && x < clock.CLOCK_W) {
    t.groupPick = true
    return
  }
  // In two-row layouts a target in the other row does not match. r null: full height.
  const hits = (t.hits || []).filter((h) => x >= h.x0 && x <= h.x1 && (h.r == null || row == null || t.s.rows === 1 || h.r === row))
  // Tap a group tag: show only that group. Tap it again: all groups.
  const tag = hits.find((h) => h.name)
  if (tag) {
    setFilter(t, t.filter ? null : tag.name)
    return
  }
  // A moving tape is stopped first, since a moving target is hard to hit.
  if (t.s.mode === "scroll" && !t.paused) {
    t.paused = true
    return
  }
  // Still tape (paused scroll, or page mode): quotes near the tap in either row, ignoring the touch y,
  // which is unreliable at 30 px per row. One: open its chart. Several: let the user pick.
  const near = []
  for (const h of t.hits || []) {
    if (h.sym && x >= h.x0 - TAP_SLOP && x <= h.x1 + TAP_SLOP && !near.includes(h.sym)) near.push(h.sym)
  }
  if (near.length === 1) openChart(t, near[0])
  else if (near.length > 1) t.pick = near
  // No quote near: nothing. Resume is the play button, so a missed tap cannot restart or stop the tape.
}

// Show only the group named name (uppercase, as in groupView), or all groups when null.
function setFilter(t, name) {
  t.filter = name
  t.page = 0
  t.transStart = 0
  t.pageShownAt = Date.now()
}

function openChart(t, sym) {
  t.chart = { sym, label: displayName(sym).replace(/^[A-Z]+:/, ""), range: "1D", scrubX: null, cache: null }
}

// Touch payload: { serialNumber, x, y, state }, state 'down' | 'pressing' | 'up' | 'end'.
plugin.on("device.touch", (payload) => {
  const t = tape
  if (!t || t.serialNumber !== payload.serialNumber) return
  const x = isRotated(t) ? payload.x : 2170 - payload.x
  // Assumed: y is mirrored like x (0..60). Unverified on device; null when missing.
  const y = Number.isFinite(payload.y) ? (isRotated(t) ? payload.y : HEIGHT - payload.y) : null
  const row = y == null ? null : clamp(Math.floor(y / (HEIGHT / 2)), 0, 1)
  const now = Date.now()
  t.touchAt = now
  const scrubbing = t.chart && !t.menu && chart.inPlot(x, t.width, MENU_BTN_W)
  if (payload.state === "down") {
    t.dragging = true
    t.touchX = t.touchStartX = x
    t.touchStartT = now
    if (scrubbing) t.chart.scrubX = x
  } else if (payload.state === "pressing" && t.dragging) {
    if (t.chart) {
      if (scrubbing) t.chart.scrubX = x
    } else if (!t.menu && !t.pick && !t.groupPick && t.s.mode === "scroll") {
      for (let r = 0; r < 2; r++) t.scroll[r] -= x - t.touchX
    }
    t.touchX = x
  } else if (payload.state === "up" || payload.state === "end") {
    if (!t.dragging) return
    t.dragging = false
    if (t.chart) t.chart.scrubX = null
    const moved = x - t.touchStartX
    if (Math.abs(moved) < 15 && now - t.touchStartT < 400) handleTap(t, x, row)
    else if (!t.menu && !t.chart && !t.pick && !t.groupPick && t.s.mode === "page" && Math.abs(moved) > 60) turnPage(t, moved < 0 ? 1 : -1, now)
  }
  // Wake the loop right away so touches feel immediate in idle page mode.
  wake(t)
})

// Start without waiting for plugin.alive: reuse the last key FlexDesigner gave us.
// If the key is not on screen yet, the loop retries until it is.
setTimeout(async () => {
  if (tape) return
  await loadConfig()
  const last = config.tape?.lastAlive
  if (last?.key) {
    logger.info("starting tape from saved key, waiting for FlexDesigner to accept it")
    startTape(last.serialNumber, last.key)
  }
}, 1500)

plugin.start()

// ---------- quotes ----------

try {
  logger.info(`history: ${history.open()}`)
} catch (e) {
  logger.error(`history unavailable, charts will be empty: ${e.message}`)
}

// Screenshot of the bar: `bun run snap` creates snap.request in the data folder; the plugin saves
// the last frame it sent to snaps/<time>.png, turned upright if the bar is rotated, and deletes the request.
const SNAP_DIR = path.join(path.dirname(SETTINGS_FILE), "snaps")
const SNAP_REQUEST = path.join(path.dirname(SETTINGS_FILE), "snap.request")
setInterval(async () => {
  if (!fs.existsSync(SNAP_REQUEST)) return
  try {
    fs.rmSync(SNAP_REQUEST, { force: true })
    const t = tape
    if (!t?.lastFrame) return logger.info("snap: no frame drawn yet")
    let png = Buffer.from(t.lastFrame.split(",")[1], "base64")
    if (isRotated(t)) {
      const img = await loadImage(png) // new Image() decodes large PNGs asynchronously, giving a blank draw
      const c = createCanvas(img.width, img.height)
      const ctx = c.getContext("2d")
      ctx.setTransform(-1, 0, 0, -1, img.width, img.height)
      ctx.drawImage(img, 0, 0)
      png = c.toBuffer("image/png")
    }
    fs.mkdirSync(SNAP_DIR, { recursive: true })
    const file = path.join(SNAP_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}.png`)
    fs.writeFileSync(file, png)
    logger.info(`snap: ${file}`)
  } catch (e) {
    logger.error(`snap failed: ${e.message}`)
  }
}, 500)

// Quote snapshots are only needed until Massive minute bars cover them: keep 7 days, check every 6 h.
const TICK_KEEP_MS = 7 * 86400000
function pruneTicks() {
  try {
    const n = history.pruneTicks(Date.now() - TICK_KEEP_MS)
    if (n) logger.info(`history: pruned ${n} old quote snapshots`)
  } catch (e) {
    logger.error(`history: prune failed: ${e.message}`)
  }
}
pruneTicks()
setInterval(pruneTicks, 6 * 3600000)
loadLogos()
setInterval(loadLogos, 60000)
indexQuotes()
setInterval(indexQuotes, 60000) // picks up new daily bars and newly added index symbols
let stopQuotes = null
function startFeed() {
  stopQuotes?.()
  stopQuotes = null
  const { key: apiKey, source: keySource } = finnhub.loadApiKey()
  if (!apiKey) {
    feedStatus = "no Finnhub key (add it in FlexDesigner settings, Flex Ticker)"
    logger.error(feedStatus)
  } else {
    logger.info(`Finnhub key from ${keySource}`)
    feedStatus = "waiting for quotes"
    stopQuotes = finnhub.startQuotes({
      apiKey,
      getSymbols: pollSymbols,
      nextNameNeeded() {
        // Fetch company names once; ETFs use the built-in table. "" marks a lookup with no result.
        return allSymbols().find((sym) => !ETF_NAMES[sym] && !isIndex(sym) && config.names?.[sym] === undefined) || null
      },
      onQuote(q) {
        const prev = latest.get(q.symbol)
        latest.set(q.symbol, q)
        try {
          if (q.time) history.addTick(q.symbol, q.time * 1000, q.price)
        } catch (e) {
          logger.error(`history: ${e.message}`)
        }
        if (prev && prev.price !== q.price) {
          flashes.set(q.symbol, { at: Date.now(), up: q.price > prev.price })
          // When idling at 1 fps (page mode, paused or stopped scroll), start the fade now.
          // A moving tape already runs at 20 fps, and an extra frame would jump it a step.
          if (tape && (tape.s.mode === "page" || tape.paused || !tape.s.speed)) wake(tape)
        }
      },
      onName(sym, name) {
        config.names = { ...config.names, [sym]: name ? shortName(name) : "" }
        saveConfig()
      },
      onStatus(s) {
        if (latest.size === 0) feedStatus = s
        logger.info(`quotes: ${s}`)
      },
    })
  }
}
startFeed()


// ---------- history collector ----------

let stopCollector = null
function startHistory() {
  stopCollector?.()
  stopCollector = null
  const { key: massiveKey, source: massiveSource } = loadKey("MASSIVE_API_KEY")
  if (!massiveKey) {
    logger.info("no Massive key (add it in FlexDesigner settings): charts use only today's quotes")
  } else if (history.isOpen()) {
    logger.info(`Massive key from ${massiveSource}`)
    stopCollector = massive.startCollector({ apiKey: massiveKey, getSymbols: allSymbols, log: (s) => logger.info(`history: ${s}`) })
  }
}
startHistory()

// ---------- key settings page ----------

// Messages from ui/settings.vue. Keys go to the OS store and are never returned or logged; only whether one is stored.
function keyStatus() {
  const one = (name) => loadKey(name).source
  return { finnhub: one("FINNHUB_API_KEY"), massive: one("MASSIVE_API_KEY"), feed: feedStatus }
}

plugin.on("ui.message", async (msg) => {
  try {
    const name = { finnhub: "FINNHUB_API_KEY", massive: "MASSIVE_API_KEY" }[msg?.which]
    if (msg?.type === "saveKey") saveKey(name, String(msg.value || "").trim())
    else if (msg?.type === "deleteKey") deleteKey(name)
    else if (msg?.type !== "keyStatus") return { error: "unknown request" }
    if (msg.type !== "keyStatus") {
      logger.info(`keys: ${msg.type} ${msg.which}`)
      if (msg.which === "finnhub") startFeed()
      else startHistory()
      await new Promise((r) => setTimeout(r, 2500)) // let the first request report
    }
    return keyStatus()
  } catch (e) {
    logger.error(`keys: ${e.message}`)
    return { error: e.message }
  }
})
