// Finnhub quote adapter. Polls /quote one symbol at a time, round robin.
// Poll rate follows the US market session (from /stock/market-status):
//   regular hours: one call every 1.2 s (50/min, free tier limit is 60)
//   pre/post market: one call every 15 s
//   closed (nights, weekends, holidays): one call every 5 min
// Crypto (exchange symbols like BINANCE:BTCUSDT) trades around the clock, so outside regular hours
// each crypto symbol is also quoted every 60 s by a separate loop. In regular hours the rotation covers it.
// The first pass over the watchlist always runs at the fast rate so the tape fills quickly.
// The API key is sent in a header so it never appears in URLs or logs.
const { loadKey } = require("./keys.js")

const BASE = "https://finnhub.io/api/v1"
const INTERVAL_MS = { regular: 1200, "pre-market": 15000, "post-market": 15000, closed: 300000 }
const STATUS_EVERY_MS = 10 * 60 * 1000
const BACKOFF_MS = 60000
const CRYPTO_MS = 60000
const isCrypto = (s) => /^[A-Z]+:/.test(s)

function loadApiKey() {
  return loadKey("FINNHUB_API_KEY")
}

async function get(apiKey, endpoint) {
  const res = await fetch(`${BASE}${endpoint}`, {
    headers: { "X-Finnhub-Token": apiKey },
    signal: AbortSignal.timeout(10000),
  })
  if (res.status === 429) {
    const err = new Error("rate limited")
    err.rateLimited = true
    throw err
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function fetchQuote(apiKey, symbol) {
  const q = await get(apiKey, `/quote?symbol=${encodeURIComponent(symbol)}`)
  // Unknown symbols come back as all zeros.
  if (!q.c) return null
  return { symbol, price: q.c, change: q.d, pct: q.dp, prevClose: q.pc, time: q.t }
}

// Fallback when /stock/market-status fails: New York clock, weekdays only, no holidays.
function sessionFromClock(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23",
  }).formatToParts(now).map((p) => [p.type, p.value]))
  if (parts.weekday === "Sat" || parts.weekday === "Sun") return "closed"
  const m = Number(parts.hour) * 60 + Number(parts.minute)
  if (m >= 570 && m < 960) return "regular" // 9:30 to 16:00
  if (m >= 240 && m < 570) return "pre-market" // 4:00 to 9:30
  if (m >= 960 && m < 1200) return "post-market" // 16:00 to 20:00
  return "closed"
}

async function fetchSession(apiKey) {
  try {
    const s = await get(apiKey, "/stock/market-status?exchange=US")
    return { session: s.session || "closed", source: "finnhub" }
  } catch (e) {
    return { session: sessionFromClock(), source: `clock (${e.message})` }
  }
}

async function fetchName(apiKey, symbol) {
  const p = await get(apiKey, `/stock/profile2?symbol=${encodeURIComponent(symbol)}`)
  return p.name || "" // ETFs return {}
}

// getSymbols(): current watchlist, re-read every call so settings changes apply right away.
// nextNameNeeded(): a symbol whose display name is unknown, or null.
// Calls onQuote(quote), onName(symbol, name) and onStatus(text). Returns a stop function.
// Alternates quote and name calls while names are missing, so names cost no extra rate.
function startQuotes({ apiKey, getSymbols, nextNameNeeded, onQuote, onName, onStatus }) {
  let i = 0
  let tickCount = 0
  let timer = null
  let stopped = false
  let lastStatus = ""
  let session = "regular"
  let sessionAt = 0
  const quoted = new Set()
  const status = (s) => {
    if (s !== lastStatus) onStatus(s)
    lastStatus = s
  }

  async function tick() {
    // Closed ticks are 5 min apart, so checking every closed tick catches the open within 5 min.
    if (session === "closed" || Date.now() - sessionAt >= STATUS_EVERY_MS) {
      const s = await fetchSession(apiKey)
      if (s.session !== session || !sessionAt) onStatus(`market session ${s.session} (${s.source})`)
      session = s.session
      sessionAt = Date.now()
    }
    const symbols = getSymbols()
    const nameSym = tickCount++ % 2 ? nextNameNeeded() : null
    const symbol = nameSym || symbols[i++ % Math.max(1, symbols.length)]
    // Symbols never quoted yet (startup, newly added) and name lookups use the fast rate.
    const fast = nameSym || !quoted.has(symbol)
    let delay = fast ? INTERVAL_MS.regular : INTERVAL_MS[session] || INTERVAL_MS.closed
    try {
      if (!symbol) {
        status("watchlist is empty")
      } else if (nameSym) {
        onName(nameSym, await fetchName(apiKey, nameSym))
      } else {
        const q = await fetchQuote(apiKey, symbol)
        quoted.add(symbol)
        if (q) {
          onQuote(q)
          status("ok")
        } else {
          status(`unknown symbol ${symbol}`)
        }
      }
    } catch (e) {
      if (e.rateLimited) {
        status("rate limited, pausing 60 s")
        delay = BACKOFF_MS
      } else {
        status(`${nameSym ? "name" : "quote"} error: ${e.message}`)
      }
    }
    if (!stopped) timer = setTimeout(tick, delay)
  }

  let cryptoTimer = null
  async function cryptoTick() {
    if (session !== "regular") {
      for (const symbol of getSymbols().filter(isCrypto)) {
        try {
          const q = await fetchQuote(apiKey, symbol)
          if (q) onQuote(q)
        } catch (e) {
          if (e.rateLimited) break // the main loop reports and backs off
        }
      }
    }
    if (!stopped) cryptoTimer = setTimeout(cryptoTick, CRYPTO_MS)
  }

  tick()
  cryptoTimer = setTimeout(cryptoTick, CRYPTO_MS)
  return () => {
    stopped = true
    clearTimeout(timer)
    clearTimeout(cryptoTimer)
  }
}

module.exports = { loadApiKey, startQuotes, sessionFromClock }
