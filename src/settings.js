// Settings file: the single source of truth for Flex Ticker settings.
// settings.json in the config folder for the host OS (src/paths.js); on macOS
// ~/Library/Application Support/flex-ticker/settings.json
// 1. Created with defaults on first run (copying settings from the old plugin config.json if present).
// 2. Watched: edits apply live, no plugin reload.
// 3. The on-bar menu writes back to it.
// Invalid JSON keeps the last good settings and reports the error.
const fs = require("node:fs")
const path = require("node:path")
const { dataDirs } = require("./paths.js")
const { DEFAULT_GROUPS, parseSymbols } = require("./groups.js")

const DIR = dataDirs().config
const FILE = path.join(DIR, "settings.json")

// Font menu per OS. The first is the default. A missing font falls back to the canvas default.
const FONTS = {
  darwin: ["Helvetica Neue", "Avenir Next", "Verdana", "Arial", "Futura", "DIN Alternate",
    "DIN Condensed", "Avenir Next Condensed", "Arial Black", "Impact", "Menlo", "Monaco"],
  win32: ["Segoe UI", "Arial", "Verdana", "Tahoma", "Bahnschrift", "Arial Black", "Impact", "Consolas"],
}[process.platform] || ["DejaVu Sans", "Liberation Sans", "Noto Sans", "Ubuntu", "DejaVu Sans Mono"]

const DEFAULTS = {
  mode: "scroll", // scroll | page
  rows: 1, // 1 | 2
  speed: 40, // scroll px/s, multiples of 20 give whole-pixel steps at 20 fps
  dwell: 5, // page mode seconds per page
  font: FONTS[0],
  weight: "bold", // normal | bold | 900
  size: 24, // px, capped at 26 with 2 rows
  label: "ticker", // ticker | name | logo (ticker with company logo)
  orientation: "auto", // auto | normal | rotated
  groups: DEFAULT_GROUPS,
}

const pick = (v, allowed, d) => (allowed.includes(v) ? v : d)
const num = (v, lo, hi, d) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d)

// Fill missing or invalid values with defaults so the renderer never sees bad input.
function normalize(raw) {
  const r = raw && typeof raw === "object" ? raw : {}
  const d = DEFAULTS
  return {
    mode: pick(r.mode, ["scroll", "page"], d.mode),
    rows: pick(r.rows, [1, 2], d.rows),
    speed: num(r.speed, 0, 300, d.speed),
    dwell: num(r.dwell, 2, 60, d.dwell),
    font: typeof r.font === "string" && r.font ? r.font : d.font,
    weight: pick(String(r.weight), ["normal", "bold", "900"], d.weight),
    size: num(r.size, 14, 48, d.size),
    label: pick(r.label, ["ticker", "name", "logo"], d.label),
    orientation: pick(r.orientation, ["auto", "normal", "rotated"], d.orientation),
    groups: Array.isArray(r.groups)
      ? r.groups.filter((g) => g && typeof g === "object").map((g, i) => ({
        name: String(g.name || `Group ${i + 1}`),
        symbols: parseSymbols(g.symbols),
      }))
      : d.groups,
  }
}

let lastWritten = ""

function write(settings) {
  // Symbol lists on one line each, so the file stays short and easy to edit.
  const text = JSON.stringify(settings, null, 2)
    .replace(/"symbols": \[([^\]]*)\]/g, (_, list) => `"symbols": [${list.split(",").map((x) => x.trim()).join(", ")}]`) + "\n"
  if (text === lastWritten) return
  fs.mkdirSync(DIR, { recursive: true })
  const tmp = `${FILE}.tmp`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, FILE) // atomic, so the watcher never reads a half-written file
  lastWritten = text
}

// legacy: settings object from the old plugin config.json, used only when the file does not exist yet.
function loadSettings(legacy) {
  if (!fs.existsSync(FILE)) {
    const s = normalize({ ...DEFAULTS, ...legacy })
    write(s)
    return { settings: s, created: true }
  }
  const text = fs.readFileSync(FILE, "utf8")
  lastWritten = text
  return { settings: normalize(JSON.parse(text)), created: false }
}

// Watches the folder, not the file: editors often save by replacing the file.
function watchSettings(onChange, onError) {
  fs.mkdirSync(DIR, { recursive: true })
  let timer = null
  fs.watch(DIR, (_, name) => {
    if (name && name !== "settings.json") return
    clearTimeout(timer)
    timer = setTimeout(() => {
      try {
        const text = fs.readFileSync(FILE, "utf8")
        if (text === lastWritten) return // our own write
        lastWritten = text
        onChange(normalize(JSON.parse(text)))
      } catch (e) {
        onError(e)
      }
    }, 200)
  })
}

module.exports = { SETTINGS_FILE: FILE, FONTS, loadSettings, saveSettings: write, watchSettings, normalize }
