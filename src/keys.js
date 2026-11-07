// API keys. Lookup order:
// 1. The OS secure store, service "flex-ticker", account = the key name (set with `bun run key:set:finnhub`).
//    macOS: login Keychain through /usr/bin/security, which the item's access list trusts, so no prompt.
//    Windows: Credential Manager. Linux: Secret Service (GNOME Keyring, KWallet). Both via @napi-rs/keyring.
// 2. The same name in .env in the plugin folder or its parent (repo root in dev).
// Keys are never logged; callers log only the source.
const fs = require("node:fs")
const path = require("node:path")
const { execFileSync } = require("node:child_process")

function fromStore(name) {
  if (process.platform === "darwin") {
    return execFileSync("/usr/bin/security",
      ["find-generic-password", "-s", "flex-ticker", "-a", name, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim()
  }
  const { Entry } = require("@napi-rs/keyring")
  return new Entry("flex-ticker", name).getPassword() || ""
}

const STORE = { darwin: "Keychain", win32: "Credential Manager" }[process.platform] || "Secret Service"

function loadKey(name) {
  try {
    const key = fromStore(name)
    if (key) return { key, source: STORE }
  } catch {
    // Not stored, or no store available; fall through to .env.
  }
  const pluginDir = path.resolve(__dirname, "..")
  for (const dir of [pluginDir, path.dirname(pluginDir)]) {
    const file = path.join(dir, ".env")
    if (fs.existsSync(file)) {
      process.loadEnvFile(file)
      break
    }
  }
  const key = process.env[name] || ""
  return { key, source: key ? ".env" : "none" }
}

// Writing keys from the settings page. The value goes to the OS store only; it is never logged or echoed.
// macOS: `security -i` reads the command from stdin, so the key never appears in the process list.
const NAMES = ["FINNHUB_API_KEY", "MASSIVE_API_KEY"]
const VALUE_RE = /^[A-Za-z0-9_.-]{8,200}$/

function toStore(name, value) {
  if (process.platform === "darwin") {
    execFileSync("/usr/bin/security", ["-i"],
      { input: `add-generic-password -U -s flex-ticker -a ${name} -w ${value}\n`, stdio: ["pipe", "ignore", "ignore"], timeout: 5000 })
    if (fromStore(name) !== value) throw new Error("the key was not stored")
    return
  }
  new (require("@napi-rs/keyring").Entry)("flex-ticker", name).setPassword(value)
}

function saveKey(name, value) {
  if (!NAMES.includes(name)) throw new Error("unknown key")
  if (!VALUE_RE.test(value)) throw new Error("that does not look like an API key (letters, digits, - _ . only)")
  toStore(name, value)
}

function deleteKey(name) {
  if (!NAMES.includes(name)) throw new Error("unknown key")
  try {
    if (process.platform === "darwin") {
      execFileSync("/usr/bin/security", ["delete-generic-password", "-s", "flex-ticker", "-a", name], { stdio: "ignore", timeout: 5000 })
    } else {
      new (require("@napi-rs/keyring").Entry)("flex-ticker", name).deletePassword()
    }
  } catch {
    // Already absent.
  }
}

module.exports = { loadKey, saveKey, deleteKey, STORE, toStore }
