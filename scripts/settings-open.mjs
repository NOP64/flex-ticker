// bun run settings:open: opens settings.json in the default text editor, on any OS.
import { spawn } from "node:child_process"
import path from "node:path"
import paths from "../src/paths.js"

const file = path.join(paths.dataDirs().config, "settings.json")
const [cmd, args] = process.platform === "darwin" ? ["open", ["-t", file]]
  : process.platform === "win32" ? ["cmd", ["/c", "start", "", file]]
  : ["xdg-open", [file]]
spawn(cmd, args, { stdio: "inherit", detached: true }).unref()
