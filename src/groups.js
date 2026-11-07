// Watchlist groups and display names.

// Free Finnhub quotes cover US stocks and ETFs, not index values (^GSPC needs a paid plan),
// so indices are shown through ETFs that track them. Prices are ETF prices; % change tracks the index.
const DEFAULT_GROUPS = [
  { name: "Indices", symbols: ["SPY", "QQQ", "DIA", "IWM"] },
  { name: "Tech", symbols: ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AMD", "NFLX"] },
  { name: "Finance", symbols: ["JPM", "BAC", "WFC", "GS", "MS", "V", "MA", "BRK.B"] },
  { name: "Sectors", symbols: ["XLK", "XLF", "XLV", "XLE", "XLY", "XLP", "XLI", "XLU", "XLB", "XLRE", "XLC"] },
]

// Finnhub profile2 has no names for ETFs or crypto, so common ones are named here.
// Crypto uses Finnhub exchange symbols (BINANCE:BTCUSDT); ticker labels drop the "BINANCE:" prefix.
const ETF_NAMES = {
  SPY: "S&P 500", QQQ: "Nasdaq 100", DIA: "Dow 30", IWM: "Russell 2000", VTI: "Total Market",
  EFA: "Developed ex-US", EEM: "Emerging Mkts", GLD: "Gold", SLV: "Silver", TLT: "20Y Treasury",
  XLK: "Technology", XLF: "Financials", XLV: "Health Care", XLE: "Energy", XLY: "Discretionary",
  XLP: "Staples", XLI: "Industrials", XLU: "Utilities", XLB: "Materials", XLRE: "Real Estate",
  XLC: "Communication", VIXY: "VIX Futures", USO: "Crude Oil", IBIT: "Bitcoin ETF",
  "BINANCE:BTCUSDT": "Bitcoin",
  "I:NDX": "Nasdaq 100 Index", "I:COMP": "Nasdaq Composite",
}

// Massive index symbols (I:NDX). Free Massive covers some indices end of day only, and Finnhub has
// no index quotes, so these show the last daily close from history instead of a live price.
const isIndex = (sym) => sym.startsWith("I:")

const GROUP_COLORS = ["#4fc3f7", "#ffb74d", "#ba68c8", "#81c784", "#f06292", "#fff176", "#90a4ae"]

// Accepts an array or a space/comma separated string. Uppercased, deduplicated.
function parseSymbols(list) {
  const seen = new Set()
  const text = Array.isArray(list) ? list.join(" ") : String(list || "")
  for (const s of text.toUpperCase().split(/[\s,]+/)) if (s) seen.add(s)
  return [...seen]
}

// "Apple Inc." -> "Apple", "JPMorgan Chase & Co" -> "JPMorgan Chase".
function shortName(name) {
  let n = String(name || "").trim()
  const suffix = /[,\s]+(inc\.?|incorporated|corp\.?|corporation|co\.?|company|holdings?|ltd\.?|plc|n\.?v\.?|s\.?a\.?|group|class [a-c]|& co\.?)$/i
  for (let i = 0; i < 4 && suffix.test(n); i++) n = n.replace(suffix, "")
  return n.length > 22 ? n.slice(0, 21) + "…" : n
}

module.exports = { DEFAULT_GROUPS, ETF_NAMES, GROUP_COLORS, isIndex, parseSymbols, shortName }
