// Massive (formerly Polygon) history collector. Free tier: 5 calls/min, data through yesterday:
// 2 years of daily bars, minute bars (4 am to 8 pm ET), all US stocks for one day in one call, crypto.
// Today's prices come from Finnhub ticks instead.
//
// Uses the whole budget, one call every 13 s, picking the most useful job each time:
// 1. Daily backfill: 2 years of daily bars for a symbol with none.
// 2. Daily update: stocks via one "all US stocks" call per missing day; crypto and indices per symbol.
// 3. Minute update: minute bars from the last stored day through yesterday.
// 4. Logos: ticker overview (branding.icon_url), then the icon itself, one call each, stocks and ETFs only.
// 5. Minute backfill: walks back 40 days per call until Massive has no more, breadth first.
// Full minute history is about 72 bytes per bar: 2 years x 55 symbols is roughly 2 GB.
// When nothing is left it checks again every 10 min. Bars are stored under the watchlist symbol.
const history = require("./history.js")

const BASE = "https://api.massive.com"
const CALL_MS = 13000 // 4.6 calls/min, under the 5/min limit
const IDLE_MS = 10 * 60 * 1000
const BACKOFF_MS = 60000

// Watchlist symbol -> Massive ticker. Finnhub crypto BINANCE:BTCUSDT -> X:BTCUSD. Indices (I:NDX) as is.
// Other exchange symbols: null.
function massiveSymbol(sym) {
  const crypto = /^BINANCE:([A-Z0-9]+)USDT?$/.exec(sym)
  if (crypto) return `X:${crypto[1]}USD`
  if (sym.startsWith("I:")) return sym
  return sym.includes(":") ? null : sym
}

const ymd = (date) => date.toISOString().slice(0, 10)
const addDays = (day, n) => ymd(new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400000))
const nyDay = (t = Date.now()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(t))
// Day a bar belongs to. Daily bars start at midnight ET (stocks) or 00:00 UTC (crypto); +12 h lands
// inside the right New York day for both.
const barDay = (t, res) => nyDay(res === "1d" ? t + 12 * 3600000 : t)
const weekend = (day) => [0, 6].includes(new Date(`${day}T12:00:00Z`).getUTCDay())

function nextJob(symbols) {
  const yday = addDays(nyDay(), -1)
  const list = symbols.map((s) => ({ s, m: massiveSymbol(s) })).filter((x) => x.m)

  for (const { s, m } of list) {
    if (history.barRange(s, "1d").first == null && !history.isDone(`d0:${s}`))
      return { what: `daily backfill ${s}`, s, m, res: "1d", from: addDays(yday, -800), to: yday, mark: `d0:${s}` }
  }

  let oldest = null
  for (const { s, m } of list) {
    const { last } = history.barRange(s, "1d")
    if (last == null) continue
    const next = addDays(barDay(last, "1d"), 1)
    // Crypto and indices are not in the "all US stocks" call, so they update per symbol.
    if (m.startsWith("X:") || m.startsWith("I:")) {
      if (next <= yday && !history.isDone(`df:${s}:${yday}`))
        return { what: `daily update ${s}`, s, m, res: "1d", from: next, to: yday, mark: `df:${s}:${yday}` }
    } else if (!oldest || next < oldest) {
      oldest = next
    }
  }
  for (let d = oldest; d && d <= yday; d = addDays(d, 1)) {
    if (!weekend(d) && !history.isDone(`g:${d}`)) return { what: `daily all stocks ${d}`, grouped: d, mark: `g:${d}` }
  }

  for (const { s, m } of list) {
    const r = history.barRange(s, "1m")
    if (r.first == null) continue
    const from = barDay(r.last, "1m")
    const to = [yday, addDays(from, 40)].sort()[0]
    if (from < yday && !history.isDone(`mf:${s}:${to}`))
      return { what: `minute update ${s} ${from}..${to}`, s, m, res: "1m", from, to, mark: `mf:${s}:${to}` }
  }

  for (const { s, m } of list) {
    if (m.startsWith("X:") || m.startsWith("I:")) continue
    const row = history.logo(s)
    if (!row) return { what: `logo lookup ${s}`, s, m, logo: "lookup" }
    if (row.url && !row.png) return { what: `logo image ${s}`, s, logo: "image", url: row.url }
  }

  // Breadth first: extend the symbol with the least minute history, so every symbol gets recent
  // weeks before any symbol gets old months.
  let pick = null
  for (const { s, m } of list) {
    if (history.isDone(`mfloor:${s}`)) continue
    const r = history.barRange(s, "1m")
    const first = r.first ?? Infinity
    if (!pick || first > pick.first) pick = { s, m, r, first }
  }
  if (pick) {
    const { s, m, r } = pick
    const to = r.first != null ? addDays(barDay(r.first, "1m"), -1) : yday
    // Crypto trades 1440 min/day, so shorter windows keep each call under the 50000 bar limit.
    const from = addDays(to, m.startsWith("X:") ? -30 : -40)
    return { what: `minute backfill ${s} ${from}..${to}`, s, m, res: "1m", from, to, floor: `mfloor:${s}` }
  }
  return null
}

async function get(apiKey, endpoint) {
  const res = await fetch(`${BASE}${endpoint}`, {
    headers: { Authorization: `Bearer ${apiKey}` }, // header, so the key never appears in URLs or logs
    signal: AbortSignal.timeout(30000),
  })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

// Index bars have no volume; node:sqlite cannot bind undefined.
const toBar = (b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v ?? null })

// Icon PNG, downscaled to 64 px. The key goes only to Massive's own host.
async function fetchIcon(apiKey, url) {
  if (new URL(url).host !== "api.massive.com") return { status: 0 }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(30000) })
  if (!res.ok) return { status: res.status }
  const { createCanvas, loadImage } = require("@napi-rs/canvas")
  const img = await loadImage(Buffer.from(await res.arrayBuffer()))
  const c = createCanvas(64, 64)
  c.getContext("2d").drawImage(img, 0, 0, 64, 64)
  return { status: 200, png: c.toBuffer("image/png") }
}

async function runLogo(apiKey, job) {
  if (job.logo === "lookup") {
    const { status, body } = await get(apiKey, `/v3/reference/tickers/${encodeURIComponent(job.m)}`)
    if (status === 429) return { rateLimited: true }
    if (status === 401) throw new Error("unauthorized, check the key (bun run key:set:massive)")
    if (status >= 500) throw new Error(`HTTP ${status}`)
    const url = (status === 200 && body.results?.branding?.icon_url) || null
    history.setLogo(job.s, url, null)
    return { text: url ? "has a logo" : `no logo${status === 200 ? "" : ` (HTTP ${status})`}` }
  }
  const r = await fetchIcon(apiKey, job.url)
  if (r.status === 429) return { rateLimited: true }
  if (r.status >= 500) throw new Error(`HTTP ${r.status}`)
  history.setLogo(job.s, r.png ? job.url : null, r.png || null) // other failures: give up on this logo
  return { text: r.png ? `${r.png.length} bytes` : `failed (HTTP ${r.status})` }
}

// Returns a short result for the log. Throws only for transient failures (network, 5xx).
async function run(apiKey, job, symbols) {
  if (job.logo) return runLogo(apiKey, job)
  const endpoint = job.grouped
    ? `/v2/aggs/grouped/locale/us/market/stocks/${job.grouped}?adjusted=true`
    : `/v2/aggs/ticker/${encodeURIComponent(job.m)}/range/1/${job.res === "1d" ? "day" : "minute"}/${job.from}/${job.to}?adjusted=true&sort=asc&limit=50000`
  const { status, body } = await get(apiKey, endpoint)
  if (status === 429) return { rateLimited: true }
  // Bad key or server trouble: retry later, never mark the job done.
  if (status === 401) throw new Error("unauthorized, check the key (bun run key:set:massive)")
  if (status >= 500) throw new Error(`HTTP ${status}`)
  const results = status === 200 ? body.results || [] : []

  if (job.grouped) {
    const wanted = new Set(symbols)
    let n = 0
    for (const b of results) if (wanted.has(b.T)) { history.addBars(b.T, "1d", [toBar(b)]); n++ }
    history.markDone(job.mark) // also marks holidays, which return no results
    return { text: `${n} symbols${results.length ? "" : " (market holiday)"}` }
  }

  history.addBars(job.s, job.res, results.map(toBar))
  if (job.floor) {
    // No data or not on this plan: the start of available minute history.
    if (status !== 200 || !results.length) history.markDone(job.floor)
  } else {
    history.markDone(job.mark)
  }
  if (body.next_url) return { text: `${results.length} bars (truncated, more available)` }
  return { text: status === 200 ? `${results.length} bars` : `HTTP ${status}: ${body.error || body.message || ""}`.slice(0, 120) }
}

// getSymbols(): current watchlist. log(text) for progress. Returns a stop function.
function startCollector({ apiKey, getSymbols, log }) {
  let timer = null
  let stopped = false
  let idleLogged = false

  async function tick() {
    let delay = CALL_MS
    try {
      const symbols = getSymbols()
      const job = history.isOpen() ? nextJob(symbols) : null
      if (!job) {
        if (!idleLogged) log("up to date")
        idleLogged = true
        delay = IDLE_MS
      } else {
        idleLogged = false
        const r = await run(apiKey, job, symbols)
        if (r.rateLimited) {
          log("rate limited, pausing 60 s")
          delay = BACKOFF_MS
        } else {
          log(`${job.what}: ${r.text}`)
        }
      }
    } catch (e) {
      log(`error: ${e.message}`)
    }
    if (!stopped) timer = setTimeout(tick, delay)
  }

  tick()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}

module.exports = { startCollector, massiveSymbol, nextJob, barDay }
