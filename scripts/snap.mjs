// bun run snap: asks the running plugin to save what the Flexbar shows, then prints the PNG path.
// The plugin checks for the request file twice a second (src/plugin.js, "Screenshot of the bar").
import fs from "node:fs"
import path from "node:path"
import paths from "../src/paths.js"

const dir = paths.dataDirs().config
const snaps = path.join(dir, "snaps")
const before = new Set(fs.existsSync(snaps) ? fs.readdirSync(snaps) : [])
fs.writeFileSync(path.join(dir, "snap.request"), "")

for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 250))
  const added = fs.existsSync(snaps) ? fs.readdirSync(snaps).filter((f) => !before.has(f)) : []
  if (added.length) {
    console.log(path.join(snaps, added.sort().at(-1)))
    process.exit(0)
  }
}
fs.rmSync(path.join(dir, "snap.request"), { force: true })
console.error("No snapshot after 5 s. Is FlexDesigner running with the plugin and the tape key on the bar?")
process.exit(1)
