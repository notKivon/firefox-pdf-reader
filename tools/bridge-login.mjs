// Starts the Claude bridge at login, as a macOS LaunchAgent:
//
//   npm run bridge:login            install (or rewrite) and start it now
//   npm run bridge:login -- --off   stop it and remove it
//
// The agent runs `node tools/claude-bridge.mjs` from this checkout, with the
// absolute paths of the node and claude that this shell finds, because launchd
// gives a job almost no PATH. Rerun after moving the checkout or changing node
// version (nvm puts the version in node's path).
//
// launchd restarts the bridge whenever it exits with an error: a port in use or
// a Claude Code that is not logged in yet is retried every 30 s, so logging in
// later is enough. A clean exit (`launchctl kill TERM`) is left stopped.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const LABEL = "local.scholar-reader.bridge";
const root = dirname(dirname(new URL(import.meta.url).pathname));
const plist = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const log = join(homedir(), "Library", "Logs", "scholar-reader-bridge.log");
const domain = `gui/${process.getuid()}`;

const launchctl = (...args) => execFileSync("launchctl", args, { stdio: "pipe" });
const loaded = () => {
  try {
    launchctl("print", `${domain}/${LABEL}`);
    return true;
  } catch {
    return false;
  }
};
const unload = () => loaded() && launchctl("bootout", `${domain}/${LABEL}`);

if (process.argv.includes("--off")) {
  unload();
  if (existsSync(plist)) rmSync(plist);
  console.log("bridge:login — removed; the bridge no longer starts at login.");
  process.exit(0);
}

const claude = execFileSync("/bin/sh", ["-c", "command -v claude"], { encoding: "utf8" }).trim();
if (!claude) {
  console.error("bridge:login — no `claude` on this shell's PATH; install Claude Code first.");
  process.exit(1);
}
const PATH = [...new Set([dirname(process.execPath), dirname(claude), "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"])].join(":");

const xml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
writeFileSync(
  plist,
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(join(root, "tools", "claude-bridge.mjs"))}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(PATH)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`,
);

mkdirSync(dirname(log), { recursive: true });
unload();
launchctl("bootstrap", domain, plist);
console.log(`bridge:login — installed ${plist}`);
console.log(`  runs:  ${process.execPath} tools/claude-bridge.mjs (in ${root})`);
console.log(`  log:   ${log}`);
console.log("  starts now and at every login; `npm run bridge:login -- --off` removes it.");
