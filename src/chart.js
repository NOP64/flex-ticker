// Drill-down chart: one symbol across the whole bar.
// Layout: label and price at the left, chart in the middle, range chips and close at the right.
// Data (src/history.js):
// 1. Intraday ranges (1D, 5D, 1M) use Massive minute bars (through yesterday) plus Finnhub ticks (today).
//    1D is the most recent day with data, so it still shows a full session at night or on weekends.
// 2. Longer ranges use Massive daily bars, plus the latest quote as the last point.
// Points are spaced evenly by index, so nights and weekends do not leave flat gaps.
const history = require("./history.js")

const DAY = 86400000
const RANGES = ["1D", "5D", "1M", "6M", "1Y", "2Y"]
const DAILY_DAYS = { "6M": 183, "1Y": 365, "2Y": 730 }
const LEFT_W = 330
const CHIP_W = 58
const PAD_Y = 6
const CACHE_MS = 5000
const MIN_DAY_POINTS = 10
const UP = "#22e07a"
const DOWN = "#ff4d5e"

const nyDay = (t) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(t))
const fmtTime = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" })
const fmtDay = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" })
const fmtDate = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" })

function intraday(sym, since) {
  const pts = history.bars(sym, "1m", since).map((b) => ({ t: b.t, p: b.c }))
  const lastBar = pts.length ? pts[pts.length - 1].t : 0
  for (const k of history.ticks(sym, Math.max(since, lastBar + 1))) pts.push({ t: k.t, p: k.price })
  return pts
}

function lastIntradayT(sym) {
  const bar = history.barRange(sym, "1m").last || 0
  const tick = history.ticks(sym, bar + 1)
  return tick.length ? tick[tick.length - 1].t : bar
}

// Points for a range, oldest first, and the base the change is measured from.
function series(sym, range, quote) {
  const now = Date.now()
  if (range === "1D" || range === "5D") {
    const last = lastIntradayT(sym)
    if (!last) return { points: [], base: null, daily: false }
    const want = range === "1D" ? 1 : 5
    const pts = intraday(sym, last - (want + 5) * DAY)
    // Days with at least MIN_DAY_POINTS points, so a few early ticks do not hide the last full session.
    const count = new Map()
    for (const x of pts) count.set(nyDay(x.t), (count.get(nyDay(x.t)) || 0) + 1)
    const days = [...count].filter(([, n]) => n >= MIN_DAY_POINTS).map(([d]) => d).slice(-want)
    const keep = pts.filter((x) => days.includes(nyDay(x.t)))
    // 1D compares with the previous close: the last daily bar before that day, else Finnhub's.
    let base = keep.length ? keep[0].p : null
    if (range === "1D" && keep.length) {
      const prev = history.bars(sym, "1d", keep[0].t - 10 * DAY, keep[0].t - 6 * 3600000)
      if (prev.length) base = prev[prev.length - 1].c
      else if (quote && nyDay(quote.time * 1000) === days[0] && quote.prevClose) base = quote.prevClose
    }
    return { points: keep, base, daily: false, day: days[0] }
  }
  if (range === "1M") {
    const pts = intraday(sym, now - 31 * DAY)
    if (pts.length > 500) return { points: pts, base: pts[0].p, daily: false }
  }
  const days = DAILY_DAYS[range] || 31
  const pts = history.bars(sym, "1d", now - days * DAY).map((b) => ({ t: b.t, p: b.c }))
  if (quote && pts.length && quote.time * 1000 > pts[pts.length - 1].t + DAY) pts.push({ t: quote.time * 1000, p: quote.price })
  return { points: pts, base: pts.length ? pts[0].p : null, daily: true }
}

function cached(c, quote) {
  const now = Date.now()
  if (!c.cache || c.cache.range !== c.range || now - c.cache.at > CACHE_MS) {
    c.cache = { range: c.range, at: now, ...series(c.sym, c.range, quote) }
  }
  return c.cache
}

function chartArea(w, menuW) {
  const x1 = w - menuW - RANGES.length * CHIP_W - 100 // room for the high/low labels ("76300.00" bold 17px)
  return { x0: LEFT_W, x1 }
}

const textW = (ctx, s) => Math.ceil(ctx.measureText(s).width)
const pctText = (p, base) => {
  const pct = base ? ((p - base) / base) * 100 : 0
  return `${pct >= 0 ? "▲" : "▼"}${Math.abs(pct).toFixed(2)}%`
}

// c: { sym, label, range, scrubX }. Pushes tap targets into hits. menuW: width of the close button.
function drawChart(ctx, c, quote, w, menuW, font, hits) {
  const H = 60
  const { points, base, daily, day } = cached(c, quote)
  const { x0, x1 } = chartArea(w, menuW)
  const plotW = x1 - x0

  // Index of the point under the finger, if scrubbing.
  let scrub = null
  if (c.scrubX != null && points.length) {
    const f = Math.max(0, Math.min(1, (c.scrubX - x0) / plotW))
    scrub = points[Math.round(f * (points.length - 1))]
  }

  const lastP = points.length ? points[points.length - 1].p : quote?.price
  const shownP = scrub ? scrub.p : lastP
  const up = base == null || shownP >= base
  const color = up ? UP : DOWN

  // Left panel.
  ctx.font = `bold 24px "${font}"`
  ctx.fillStyle = "#fff"
  ctx.fillText(c.label, 14, 27)
  ctx.font = `20px "${font}"`
  if (shownP != null) {
    const priceText = shownP.toFixed(2)
    ctx.fillStyle = color
    ctx.fillText(`${priceText}  ${pctText(shownP, base)}`, 14, 52)
  }
  ctx.font = `bold 18px "${font}"`
  ctx.fillStyle = "#bbb"
  // 1D names its day, since at night or on weekends it is the last session, not today.
  const when = scrub ? (daily ? fmtDate : fmtTime).format(new Date(scrub.t))
    : c.range === "1D" && day ? fmtDay.format(new Date(`${day}T12:00:00Z`)) : c.range
  ctx.fillText(when, LEFT_W - 20 - textW(ctx, when), 27)

  // Chart.
  if (points.length < 2) {
    ctx.font = `18px "${font}"`
    ctx.fillStyle = "#666"
    ctx.fillText(`No ${c.range} history yet. The collector is still filling it in.`, x0 + 20, 37)
  } else {
    let lo = Infinity
    let hi = -Infinity
    for (const x of points) { lo = Math.min(lo, x.p); hi = Math.max(hi, x.p) }
    if (base != null && c.range === "1D") { lo = Math.min(lo, base); hi = Math.max(hi, base) }
    if (hi === lo) { hi += 1; lo -= 1 }
    const y = (p) => Math.round(PAD_Y + (hi - p) / (hi - lo) * (H - 2 * PAD_Y)) + 0.5
    const xOf = (i) => x0 + (i / (points.length - 1)) * plotW

    // Previous close, dashed, for 1D.
    if (base != null && c.range === "1D") {
      ctx.strokeStyle = "#555"
      ctx.lineWidth = 1
      ctx.setLineDash([4, 6])
      ctx.beginPath()
      ctx.moveTo(x0, y(base))
      ctx.lineTo(x1, y(base))
      ctx.stroke()
      ctx.setLineDash([])
    }

    // Line, one column per pixel: through each column's low and high so spikes stay visible.
    const path = []
    for (let i = 0; i < points.length; i++) {
      const px = Math.floor(xOf(i))
      const col = path[path.length - 1]
      if (col && col.x === px) {
        col.lo = Math.min(col.lo, points[i].p)
        col.hi = Math.max(col.hi, points[i].p)
        col.last = points[i].p
      } else {
        path.push({ x: px, first: points[i].p, lo: points[i].p, hi: points[i].p, last: points[i].p })
      }
    }
    ctx.beginPath()
    ctx.moveTo(path[0].x, y(path[0].first))
    for (const col of path) {
      ctx.lineTo(col.x, y(col.first))
      ctx.lineTo(col.x, y(col.lo))
      ctx.lineTo(col.x, y(col.hi))
      ctx.lineTo(col.x, y(col.last))
    }
    ctx.strokeStyle = color
    ctx.lineWidth = 2
    ctx.stroke()
    // Faint fill under the line.
    ctx.lineTo(path[path.length - 1].x, H)
    ctx.lineTo(path[0].x, H)
    ctx.closePath()
    ctx.globalAlpha = 0.12
    ctx.fillStyle = color
    ctx.fill()
    ctx.globalAlpha = 1

    // High and low labels at the right edge of the plot.
    ctx.font = `bold 17px "${font}"`
    ctx.fillStyle = "#bbb"
    const hiT = hi.toFixed(2)
    const loT = lo.toFixed(2)
    ctx.fillText(hiT, x1 + 8, 20)
    ctx.fillText(loT, x1 + 8, H - 6)

    if (scrub) {
      const sx = Math.round(xOf(points.indexOf(scrub))) + 0.5
      ctx.strokeStyle = "#ccc"
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(sx, 0)
      ctx.lineTo(sx, H)
      ctx.stroke()
      ctx.fillStyle = "#fff"
      ctx.beginPath()
      ctx.arc(sx, y(scrub.p), 4, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  // Range chips.
  const chipX0 = w - menuW - RANGES.length * CHIP_W
  ctx.font = `bold 17px "${font}"`
  RANGES.forEach((r, i) => {
    const x = chipX0 + i * CHIP_W
    if (r === c.range) {
      ctx.fillStyle = "#2a2a2a"
      ctx.fillRect(x + 3, 12, CHIP_W - 6, H - 24)
    }
    ctx.fillStyle = r === c.range ? "#fff" : "#888"
    ctx.fillText(r, x + Math.floor((CHIP_W - textW(ctx, r)) / 2), 36)
    hits.push({ x0: x, x1: x + CHIP_W, range: r })
  })

  // Close button, in the menu button's place.
  const bx = w - menuW
  ctx.fillStyle = "#111"
  ctx.fillRect(bx, 0, menuW, H)
  ctx.strokeStyle = "#aaa"
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.moveTo(bx + 20, 20)
  ctx.lineTo(bx + menuW - 20, H - 20)
  ctx.moveTo(bx + menuW - 20, 20)
  ctx.lineTo(bx + 20, H - 20)
  ctx.stroke()
}

// True when x is on the plot, where a drag scrubs.
function inPlot(x, w, menuW) {
  const { x0, x1 } = chartArea(w, menuW)
  return x >= x0 && x <= x1
}

module.exports = { RANGES, drawChart, inPlot, series }
