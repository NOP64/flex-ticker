// Market status: US session state and countdown, drawn in a fixed block at the left of the tape.
// Session times are New York time:
// 1. Pre-market 4:00 to 9:30, regular 9:30 to 16:00, after hours 16:00 to 20:00.
// 2. Early close days (day before July 4, day after Thanksgiving, Christmas Eve): regular ends 13:00, after hours 17:00.
// The NYSE holiday calendar is computed from its rules, so it needs no yearly update and no API call.
// Unscheduled closures (national mourning, emergencies) are not known to it.

const CLOCK_W = 270
const UP = "#22e07a"
const AMBER = "#ffb74d"
const GRAY = "#888"

const pad = (n) => String(n).padStart(2, "0")
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`
const dow = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay() // 0 Sunday
const shift = (y, m, d, days) => {
  const t = new Date(Date.UTC(y, m - 1, d + days))
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()]
}

// n-th weekday (n = 1..4) of a month, or the last one with n = -1.
function nthWeekday(y, m, wd, n) {
  if (n > 0) return 1 + ((wd - dow(y, m, 1) + 7) % 7) + (n - 1) * 7
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return last - ((dow(y, m, last) - wd + 7) % 7)
}

// Gregorian Easter (anonymous algorithm), as [month, day].
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451)
  return [Math.floor((h + l - 7 * m + 114) / 31), ((h + l - 7 * m + 114) % 31) + 1]
}

// Saturday holidays move to Friday, Sunday holidays to Monday.
function observed(y, m, d) {
  const w = dow(y, m, d)
  return w === 6 ? shift(y, m, d, -1) : w === 0 ? shift(y, m, d, 1) : [y, m, d]
}

const calendars = new Map()

// { holidays: Map(date -> name), early: Set(date) } for one year.
function calendar(y) {
  if (calendars.has(y)) return calendars.get(y)
  const holidays = new Map()
  const add = (name, [yy, mm, dd]) => { if (yy === y) holidays.set(ymd(yy, mm, dd), name) }
  // New Year on a Saturday is not moved to Friday Dec 31 (NYSE rule 7.2).
  if (dow(y, 1, 1) !== 6) add("New Year", observed(y, 1, 1))
  add("MLK Day", [y, 1, nthWeekday(y, 1, 1, 3)])
  add("Presidents Day", [y, 2, nthWeekday(y, 2, 1, 3)])
  const [em, ed] = easter(y)
  add("Good Friday", shift(y, em, ed, -2))
  add("Memorial Day", [y, 5, nthWeekday(y, 5, 1, -1)])
  if (y >= 2022) add("Juneteenth", observed(y, 6, 19))
  add("July 4", observed(y, 7, 4))
  add("Labor Day", [y, 9, nthWeekday(y, 9, 1, 1)])
  const thanks = nthWeekday(y, 11, 4, 4)
  add("Thanksgiving", [y, 11, thanks])
  add("Christmas", observed(y, 12, 25))

  const early = new Set()
  const maybe = (m, d) => {
    const w = dow(y, m, d)
    if (w >= 1 && w <= 5 && !holidays.has(ymd(y, m, d))) early.add(ymd(y, m, d))
  }
  maybe(7, 3)
  maybe(11, thanks + 1)
  maybe(12, 24)
  const cal = { holidays, early }
  calendars.set(y, cal)
  return cal
}

const nyFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric",
  hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23",
})

function nyParts(t) {
  const p = {}
  for (const x of nyFmt.formatToParts(new Date(t))) p[x.type] = Number(x.value)
  return p
}

// UTC ms for a New York wall time. Two passes settle the offset across DST changes.
function nyTime(y, m, d, h, mi) {
  let t = Date.UTC(y, m - 1, d, h, mi)
  for (let i = 0; i < 2; i++) {
    const p = nyParts(t)
    t -= Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Date.UTC(y, m - 1, d, h, mi)
  }
  return t
}

// Session times of a New York date, or null when the market is shut all day.
function sessionDay(y, m, d) {
  const w = dow(y, m, d)
  const key = ymd(y, m, d)
  const cal = calendar(y)
  if (w === 0 || w === 6) return { closed: "Weekend" }
  if (cal.holidays.has(key)) return { closed: cal.holidays.get(key) }
  const early = cal.early.has(key)
  return {
    pre: nyTime(y, m, d, 4, 0),
    open: nyTime(y, m, d, 9, 30),
    close: nyTime(y, m, d, early ? 13 : 16, 0),
    end: nyTime(y, m, d, early ? 17 : 20, 0),
    early,
  }
}

// Next regular open strictly after now.
function nextOpen(now) {
  const p = nyParts(now)
  for (let i = 0; i < 15; i++) {
    const [y, m, d] = shift(p.year, p.month, p.day, i)
    const s = sessionDay(y, m, d)
    if (s.open && s.open > now) return s.open
  }
  return null
}

// { state, label, color, verb, at, early }. verb/at: the next event ("opens" or "closes" at time at).
function marketState(now = Date.now()) {
  const p = nyParts(now)
  const s = sessionDay(p.year, p.month, p.day)
  if (s.closed) return { state: "closed", label: s.closed === "Weekend" ? "CLOSED" : s.closed, color: GRAY, verb: "opens", at: nextOpen(now) }
  if (now >= s.open && now < s.close) return { state: "regular", label: "OPEN", color: UP, verb: "closes", at: s.close, early: s.early }
  if (now >= s.pre && now < s.open) return { state: "pre", label: "PRE-MARKET", color: AMBER, verb: "opens", at: s.open }
  if (now >= s.close && now < s.end) return { state: "post", label: "AFTER HOURS", color: AMBER, verb: "opens", at: nextOpen(now) }
  return { state: "closed", label: "CLOSED", color: GRAY, verb: "opens", at: nextOpen(now) }
}

const fmtWhen = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" })

// "opens 2h 05m", "closes 42m 10s", or "opens Mon 9:30 AM" when a day or more away.
function countdown(m, now) {
  if (!m.at) return ""
  const s = Math.max(0, Math.floor((m.at - now) / 1000))
  let left
  if (s >= 86400) left = fmtWhen.format(new Date(m.at))
  else if (s >= 3600) left = `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`
  else left = `${Math.floor(s / 60)}m ${pad(s % 60)}s`
  return `${m.verb} ${left}${m.early ? " · early" : ""}`
}

// One line: "OPEN: closes 4h 13m", label in the session color. The font shrinks to fit long holiday names.
// only: the group the tape is filtered to ({ name, color }), shown once below the status line.
function drawClock(ctx, font, now = Date.now(), only = null) {
  const m = marketState(now)
  const head = `${m.label}:`
  const rest = ` ${countdown(m, now)}`
  let size = 17
  for (; size > 11; size--) {
    ctx.font = `bold ${size}px "${font}"`
    if (12 + ctx.measureText(head + rest).width <= CLOCK_W - 10) break
  }
  const y = only ? 25 : 36
  ctx.fillStyle = m.color
  ctx.fillText(head, 12, y)
  const hw = ctx.measureText(head).width
  ctx.fillStyle = "#bbb"
  ctx.fillText(rest, 12 + hw, y)
  if (only) {
    ctx.fillStyle = only.color
    ctx.fillRect(12, 34, 4, 20)
    ctx.font = `bold 17px "${font}"`
    ctx.fillText(only.name, 24, 50)
  }
  ctx.fillStyle = "#222"
  ctx.fillRect(CLOCK_W - 1, 6, 1, 48)
}

module.exports = { CLOCK_W, drawClock, marketState, countdown, calendar }
