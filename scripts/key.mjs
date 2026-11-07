// API keys in the OS secure store, service "flex-ticker". Never prints a key.
// Usage: node scripts/key.mjs set|delete finnhub|massive|twelvedata, or node scripts/key.mjs check
// macOS uses the security tool, so /usr/bin/security (which the plugin reads with) is on the item's
// access list. Windows (Credential Manager) and Linux (Secret Service) use @napi-rs/keyring.
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import readline from "node:readline"

const NAMES = { finnhub: "FINNHUB_API_KEY", massive: "MASSIVE_API_KEY", twelvedata: "TWELVEDATA_API_KEY" }
const mac = process.platform === "darwin"
const security = (args, stdio = "ignore") => spawnSync("security", args, { stdio }).status === 0
const entry = (name) => new (createRequire(import.meta.url)("@napi-rs/keyring").Entry)("flex-ticker", name)

// Reads a line without echoing it.
function ask(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    process.stdout.write(prompt)
    rl._writeToOutput = () => {}
    rl.question("", (answer) => {
      rl.close()
      process.stdout.write("\n")
      resolve(answer.trim())
    })
  })
}

const [cmd, which = "finnhub"] = process.argv.slice(2)
const name = NAMES[which]
if (cmd === "check") {
  for (const n of [NAMES.finnhub, NAMES.massive]) {
    const found = mac ? security(["find-generic-password", "-s", "flex-ticker", "-a", n]) : !!entry(n).getPassword()
    console.log(`${n} is ${found ? "" : "not "}stored`)
  }
} else if (!name || !["set", "delete"].includes(cmd)) {
  console.error("Usage: node scripts/key.mjs set|delete finnhub|massive|twelvedata, or check")
  process.exit(1)
} else if (cmd === "set") {
  if (mac) process.exit(security(["add-generic-password", "-U", "-s", "flex-ticker", "-a", name, "-w"], "inherit") ? 0 : 1)
  const key = await ask(`${name}: `)
  if (!key) process.exit(1)
  entry(name).setPassword(key)
  console.log(`${name} stored`)
} else {
  const ok = mac ? security(["delete-generic-password", "-s", "flex-ticker", "-a", name]) : entry(name).deletePassword()
  console.log(`${name} ${ok ? "deleted" : "was not stored"}`)
}
