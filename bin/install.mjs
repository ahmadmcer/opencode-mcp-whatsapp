#!/usr/bin/env node
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readdirSync, statSync } from "node:fs";

import { createPrompter, promptText, promptYesNo } from "../src/prompts.mjs";
import { shellExec } from "../src/shellExec.mjs";
import { defaultTargetDir, resolveTargetDir } from "../src/paths.mjs";
import { copyFile } from "../src/copyStatic.mjs";
import { registerWhatsappMcp, buildEnvironment } from "../src/mergeConfig.mjs";
import { runNpmInstall, verifyConfig, listMcpStatus } from "../src/verify.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const TEMPLATE_MCP = path.join(REPO_ROOT, "templates", "mcp-whatsapp");

function positiveIntValidator(v) {
  const n = Number(v);
  if (Number.isInteger(n) && n > 0) return { ok: true };
  return { ok: false, message: "Enter a positive whole number." };
}

async function main() {
  const rl = createInterface({ input: stdin, output: stdout });
  const prompter = createPrompter(rl);

  console.log("opencode-mcp-whatsapp");
  console.log("Installs a local WhatsApp MCP server for OpenCode: send/receive messages,");
  console.log("send files, list chats -- driven by your agent, via Baileys.\n");
  console.log("Existing files at any target path are renamed to a timestamped .bak before");
  console.log("anything is written -- nothing is ever silently overwritten.\n");

  // --- preflight: npm is required to install Baileys; opencode is optional here ---
  try {
    shellExec("npm", ["--version"]);
  } catch {
    console.log("Could not find `npm` on PATH. Install Node.js (which ships npm) and retry.");
    rl.close();
    process.exit(1);
  }
  let hasOpencode = true;
  try {
    shellExec("opencode", ["--version"]);
  } catch {
    hasOpencode = false;
  }
  if (!hasOpencode) {
    console.log("Note: the `opencode` CLI wasn't found on PATH. Files will still be installed and");
    console.log("opencode.jsonc updated, but the post-install verification step will be skipped.");
    console.log("Install it later with: npm install -g opencode-ai\n");
  }

  const answers = {};

  // --- target directory ---
  const defaultDir = defaultTargetDir();
  const useDefault = await promptYesNo(prompter, `Install to ${defaultDir}?`, true);
  const targetDir = useDefault
    ? defaultDir
    : resolveTargetDir(await promptText(prompter, "Target OpenCode config directory"));

  // --- recipient allowlist (optional) ---
  console.log("\nRecipient allowlist restricts who the agent can message. Comma-separated");
  console.log("phone numbers (+country...) or JIDs. Leave blank to allow ALL recipients.");
  answers.allowlist = (await promptText(prompter, "Allowed recipients")) || null;

  // --- rate limit ---
  console.log("\nOutbound rate limit protects the account from spam loops / bans.");
  answers.sendMax = Number(
    await promptText(prompter, "Max sends per window", { default: "10", validate: positiveIntValidator })
  );
  const windowSec = Number(
    await promptText(prompter, "Rate-limit window (seconds)", { default: "60", validate: positiveIntValidator })
  );
  answers.windowMs = windowSec * 1000;

  // --- send roots (optional) ---
  const sep = process.platform === "win32" ? ";" : ":";
  console.log("\n`send_file` may only read from these directories (sandbox against exfiltration).");
  console.log(`Default: ~/Downloads and ~/.config/opencode/whatsapp-outbox. To override, give an`);
  console.log(`OS-path-separated list (separator on this OS is "${sep}"). Leave blank for the default.`);
  answers.sendRoot = (await promptText(prompter, "Send roots")) || null;

  // --- recap + confirm ---
  const env = buildEnvironment(answers);
  console.log("\n--- Recap ---");
  console.log(`Target directory   : ${targetDir}`);
  console.log(`MCP folder         : ${path.join(targetDir, "mcp-whatsapp")}`);
  console.log(`Allowed recipients : ${answers.allowlist ?? "all (unrestricted)"}`);
  console.log(`Rate limit         : ${answers.sendMax} per ${windowSec}s`);
  console.log(`Send roots         : ${answers.sendRoot ?? "default (~/Downloads, ~/.config/opencode/whatsapp-outbox)"}`);
  console.log(`opencode.jsonc     : will add/replace the "whatsapp" MCP server entry (backed up first)`);
  console.log(`Env vars to write  : ${Object.keys(env).length ? Object.keys(env).join(", ") : "(none -- all defaults)"}`);

  const proceed = await promptYesNo(prompter, "\nProceed and write these files?", true);
  rl.close();
  if (!proceed) {
    console.log("Aborted -- nothing was written.");
    return;
  }

  // --- copy the MCP source into <target>/mcp-whatsapp ---
  const mcpDir = path.join(targetDir, "mcp-whatsapp");
  const backedUp = [];
  const written = [];
  for (const name of readdirSync(TEMPLATE_MCP)) {
    const src = path.join(TEMPLATE_MCP, name);
    if (!statSync(src).isFile()) continue;
    const dest = path.join(mcpDir, name);
    const backup = copyFile(src, dest);
    if (backup) backedUp.push(backup);
    written.push(dest);
  }

  // --- register the server in opencode.jsonc ---
  const reg = registerWhatsappMcp(targetDir, env);
  written.push(reg.configPath);
  if (reg.backup) backedUp.push(reg.backup);

  // --- npm install (Baileys etc.) ---
  runNpmInstall(mcpDir);

  // --- verification (only if the opencode CLI is available) ---
  if (hasOpencode) {
    verifyConfig(targetDir);
    listMcpStatus(targetDir);
  }

  // --- summary ---
  console.log("\n--- Done ---");
  console.log(`Files written (${written.length}):`);
  for (const f of written) console.log(`  ${f}`);
  if (backedUp.length) {
    console.log(`\nExisting files backed up (${backedUp.length}):`);
    for (const b of backedUp) console.log(`  ${b}`);
  }
  if (reg.created) {
    console.log(`\nCreated a new opencode.jsonc (none existed) with just the whatsapp server.`);
  } else if (reg.replaced) {
    console.log(`\nReplaced the existing "whatsapp" MCP entry in opencode.jsonc.`);
  } else {
    console.log(`\nAdded the "whatsapp" MCP entry to your existing opencode.jsonc.`);
  }
  if (reg.hadComments) {
    console.log("Your opencode.jsonc had comments -- they were preserved in the .bak, but the");
    console.log("rewritten file is plain JSON (still valid JSONC). Re-add comments if you want them.");
  }

  // --- linking instructions ---
  console.log("\n--- Link your phone (one time) ---");
  console.log("1. Start (or restart) opencode so the whatsapp server connects.");
  console.log(`2. It writes a QR image to: ${path.join(targetDir, "whatsapp", "qr.png")}`);
  console.log("3. Open that PNG and scan it in WhatsApp > Settings > Linked Devices > Link a device.");
  console.log("4. Ask the agent to run the `status` tool -- it should report Connected: yes.");
  console.log("\nTools available to the agent: send, send_file, status, recent_messages, list_chats.");
  console.log("Heads up: this uses an unofficial WhatsApp library; keep send volume low to avoid bans.");
}

main().catch((err) => {
  console.error(`\nInstall failed: ${err.message}`);
  process.exit(1);
});
