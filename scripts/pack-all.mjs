// Packs one .flexplugin per OS and CPU into dist/, each holding only its own native binaries
// (@napi-rs/canvas, @napi-rs/keyring). Run `bun run build` first. Restores this machine's binaries at the end.
import { spawnSync } from "node:child_process"
import fs from "node:fs"

const TARGETS = [["darwin", "arm64"], ["darwin", "x64"], ["win32", "x64"], ["win32", "arm64"], ["linux", "x64"], ["linux", "arm64"]]
const PLUGIN = "com.nop64.flexticker.plugin"
const BACKEND = `${PLUGIN}/backend`

function run(args, cwd = ".") {
  const r = spawnSync("bun", args, { cwd, stdio: "inherit" })
  if (r.status !== 0) throw new Error(`bun ${args.join(" ")} failed`)
}

function install(args) {
  fs.rmSync(`${BACKEND}/node_modules`, { recursive: true, force: true })
  run(["install", ...args], BACKEND)
}

fs.mkdirSync("dist", { recursive: true })
try {
  for (const [os, cpu] of TARGETS) {
    install([`--os=${os}`, `--cpu=${cpu}`])
    run(["--bun", "run", "flexcli", "plugin", "pack", "--path", PLUGIN])
    fs.renameSync("com.nop64.flexticker.flexplugin", `dist/com.nop64.flexticker.${os}.${cpu}.flexplugin`)
  }
} finally {
  install([])
}
for (const f of fs.readdirSync("dist")) console.log(`dist/${f}  ${(fs.statSync(`dist/${f}`).size / 1e6).toFixed(1)} MB`)
