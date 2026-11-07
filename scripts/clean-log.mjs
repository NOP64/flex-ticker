// Pipe filter for `flexcli plugin debug`: drops the outer flexcli prefix
// ("> LOG yy-mm-dd hh:mm:ss info-> Debugging at: ") so each line keeps one
// timestamp, the plugin logger's own (with milliseconds).
import readline from "node:readline"

const ansi = /\x1b\[[0-9;]*m/g
const prefix = /^(> LOG \S+ )?\d\d:\d\d(:\d\d)? \w+-> (Debugging at: )?/
const splitHead = /^> LOG \S+ \d\d$/ // flexcli sometimes breaks the line after the hour

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const plain = line.replace(ansi, "")
  if (plain.trim() === "" || splitHead.test(plain)) return
  process.stdout.write(plain.replace(prefix, "") + "\n")
})
