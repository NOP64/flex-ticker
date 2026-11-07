// Local price history: history.sqlite in the data folder for the host OS (src/paths.js; on macOS
// ~/Library/Application Support/flex-ticker), using node:sqlite, built into FlexDesigner's Node 22.22.
// It logs an ExperimentalWarning once at startup.
// 1. ticks: every Finnhub quote, keyed by the quote's own timestamp, so repeats while the market is
//    closed are stored once. Builds the day chart.
// 2. bars: OHLCV bars from Massive, by resolution ("1d", "1m"). Builds longer charts.
// 3. done: keys of collector requests that need no repeat.
// 4. logos: company icons from Massive, 64 px PNG. No row: not looked up yet. url NULL: no logo.
//    url set, png NULL: image not fetched yet.
const fs = require("node:fs")
const path = require("node:path")
const { dataDirs } = require("./paths.js")

const FILE = path.join(dataDirs().data, "history.sqlite")

let db = null
let q = {}

function open() {
  const { DatabaseSync } = require("node:sqlite") // here, so a missing module only disables history
  fs.mkdirSync(path.dirname(FILE), { recursive: true })
  db = new DatabaseSync(FILE)
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS ticks (symbol TEXT NOT NULL, t INTEGER NOT NULL, price REAL NOT NULL,
      PRIMARY KEY (symbol, t)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS bars (symbol TEXT NOT NULL, res TEXT NOT NULL, t INTEGER NOT NULL,
      o REAL, h REAL, l REAL, c REAL NOT NULL, v REAL, PRIMARY KEY (symbol, res, t)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS done (key TEXT PRIMARY KEY) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS logos (symbol TEXT PRIMARY KEY, url TEXT, png BLOB, t INTEGER NOT NULL);
  `)
  q = {
    tick: db.prepare("INSERT OR IGNORE INTO ticks VALUES (?, ?, ?)"),
    ticks: db.prepare("SELECT t, price FROM ticks WHERE symbol = ? AND t >= ? ORDER BY t"),
    // Only ticks that minute bars already cover, so nothing is lost without a Massive key.
    prune: db.prepare(`DELETE FROM ticks WHERE t < ? AND t <= (SELECT max(t) FROM bars
      WHERE bars.symbol = ticks.symbol AND bars.res = '1m')`),
    bar: db.prepare("INSERT OR REPLACE INTO bars VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
    bars: db.prepare("SELECT t, o, h, l, c, v FROM bars WHERE symbol = ? AND res = ? AND t >= ? AND t < ? ORDER BY t"),
    isDone: db.prepare("SELECT 1 FROM done WHERE key = ?"),
    markDone: db.prepare("INSERT OR IGNORE INTO done VALUES (?)"),
    logo: db.prepare("SELECT url, png FROM logos WHERE symbol = ?"),
    setLogo: db.prepare("INSERT OR REPLACE INTO logos VALUES (?, ?, ?, ?)"),
    // Two index lookups. min, max and count in one query scanned every row of the symbol (193 ms at 1M bars).
    first: db.prepare("SELECT t FROM bars WHERE symbol = ? AND res = ? ORDER BY t LIMIT 1"),
    last: db.prepare("SELECT t FROM bars WHERE symbol = ? AND res = ? ORDER BY t DESC LIMIT 1"),
  }
  return FILE
}

// t in ms. Finnhub quote time is in seconds.
function addTick(symbol, t, price) {
  if (db) q.tick.run(symbol, t, price)
}

function ticks(symbol, since) {
  return db ? q.ticks.all(symbol, since) : []
}

// Deletes ticks older than before (ms) where Massive minute bars cover them. Returns the count.
function pruneTicks(before) {
  return db ? Number(q.prune.run(before).changes) : 0
}

function addBars(symbol, res, rows) {
  if (!db || !rows.length) return
  db.exec("BEGIN")
  try {
    for (const b of rows) q.bar.run(symbol, res, b.t, b.o, b.h, b.l, b.c, b.v)
    db.exec("COMMIT")
  } catch (e) {
    db.exec("ROLLBACK")
    throw e
  }
}

function bars(symbol, res, from, to = Number.MAX_SAFE_INTEGER) {
  return db ? q.bars.all(symbol, res, from, to) : []
}

// { first, last } times of stored bars, both null when none.
function barRange(symbol, res) {
  if (!db) return { first: null, last: null }
  return { first: q.first.get(symbol, res)?.t ?? null, last: q.last.get(symbol, res)?.t ?? null }
}

// Markers for collector requests that are finished (holidays, history floor reached), so they are not repeated.
function isDone(key) {
  return db ? !!q.isDone.get(key) : true
}

function markDone(key) {
  if (db) q.markDone.run(key)
}

// { url, png } or undefined when not looked up yet.
function logo(symbol) {
  return db ? q.logo.get(symbol) : undefined
}

function setLogo(symbol, url, png) {
  if (db) q.setLogo.run(symbol, url, png, Date.now())
}

function isOpen() {
  return !!db
}

module.exports = { HISTORY_FILE: FILE, open, isOpen, addTick, ticks, pruneTicks, addBars, bars, barRange, isDone, markDone, logo, setLogo }
