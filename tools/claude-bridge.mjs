// Scholar Reader's bridge to Claude Code: `npm run bridge`.
//
// Runs Claude (Opus, Sonnet or Haiku) on the reader's own Claude Code
// subscription login, for the extension's Claude providers. Listens on loopback
// only. See SPEC.md, "tools/claude-bridge.mjs".
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { authStatus } from "./bridge/cli.mjs";
import { createBridge } from "./bridge/server.mjs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.SCHOLAR_BRIDGE_PORT || 8765);
const TOKEN_DIR = join(homedir(), ".config", "scholar-reader");
const TOKEN_FILE = join(TOKEN_DIR, "bridge-token");

// "srb_" + hex: nothing check:secrets looks for, and nothing that looks like a
// provider key if it is ever pasted somewhere it should not be.
function loadToken() {
  if (existsSync(TOKEN_FILE)) return { token: readFileSync(TOKEN_FILE, "utf8").trim(), fresh: false };
  mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
  const token = `srb_${randomBytes(24).toString("hex")}`;
  writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
  chmodSync(TOKEN_FILE, 0o600);
  return { token, fresh: true };
}

const auth = await authStatus();
if (auth.error || !auth.loggedIn) {
  console.error(`Claude Code is not logged in (${auth.error ?? "loggedIn: false"}). Run \`claude\` and log in first.`);
  process.exit(1);
}
if (auth.authMethod !== "claude.ai") {
  console.error(
    `Claude Code is logged in by "${auth.authMethod}", not a claude.ai subscription, so runs would be billed ` +
      "to an API account. Log in with your subscription (`claude auth login`) and start the bridge again.",
  );
  process.exit(1);
}

const { token, fresh } = loadToken();
const server = createBridge({ token });
server.on("error", (err) => {
  console.error(err.code === "EADDRINUSE" ? `Port ${PORT} is in use — is the bridge already running?` : err.message);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  console.log(`Scholar Reader bridge on http://${HOST}:${PORT} — Claude Code subscription login.`);
  if (fresh) {
    console.log(`\nNew bridge token (paste it into Scholar Reader → Settings → Claude bridge token):\n\n  ${token}\n`);
  } else {
    console.log(`Token: ${TOKEN_FILE}`);
  }
});
