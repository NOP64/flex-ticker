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

module.exports = { loadKey }
