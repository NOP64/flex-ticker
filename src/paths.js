// Data folders for the host OS, so nothing needs configuring:
// 1. macOS: ~/Library/Application Support/flex-ticker for settings and history.
// 2. Windows: %APPDATA%\flex-ticker for settings, %LOCALAPPDATA%\flex-ticker for history (large, kept out of
//    the roaming profile).
// 3. Linux: $XDG_CONFIG_HOME/flex-ticker (default ~/.config) for settings, $XDG_DATA_HOME/flex-ticker
//    (default ~/.local/share) for history.
// platform, env and home are parameters only so tests can check other systems.
const os = require("node:os")
const path = require("node:path")

const APP = "flex-ticker"

function dataDirs(platform = process.platform, env = process.env, home = os.homedir()) {
  const p = platform === "win32" ? path.win32 : path.posix
  if (platform === "darwin") {
    const dir = p.join(home, "Library", "Application Support", APP)
    return { config: dir, data: dir }
  }
  if (platform === "win32") {
    return {
      config: p.join(env.APPDATA || p.join(home, "AppData", "Roaming"), APP),
      data: p.join(env.LOCALAPPDATA || p.join(home, "AppData", "Local"), APP),
    }
  }
  return {
    config: p.join(env.XDG_CONFIG_HOME || p.join(home, ".config"), APP),
    data: p.join(env.XDG_DATA_HOME || p.join(home, ".local", "share"), APP),
  }
}

module.exports = { dataDirs }
