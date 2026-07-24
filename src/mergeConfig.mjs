import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { parseJsonc, hasComments } from "./jsonc.mjs";
import { backupIfExists } from "./backup.mjs";
import { toConfigPath } from "./paths.mjs";

// Registers (or replaces) the `whatsapp` local MCP server inside the user's
// opencode.jsonc, preserving every other key. Returns details for reporting.
//
// The existing file is parsed as JSONC and rewritten as plain JSON (valid JSON
// is valid JSONC, so nothing breaks) -- any comments the user had survive only
// in the timestamped .bak, which is why `hadComments` is surfaced to the caller.
export function registerWhatsappMcp(targetDir, environment) {
  const configPath = path.join(targetDir, "opencode.jsonc");
  const mcpCwd = toConfigPath(path.join(targetDir, "mcp-whatsapp"));

  let config;
  let backup = null;
  let hadComments = false;
  let created = false;

  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, "utf8");
    hadComments = hasComments(raw);
    try {
      config = parseJsonc(raw);
    } catch (err) {
      throw new Error(
        `Could not parse existing ${configPath}:\n  ${err.message}\n` +
          `Left it untouched. Add the whatsapp MCP entry by hand (see the README "Manual config" section).`
      );
    }
    if (config === null || typeof config !== "object" || Array.isArray(config)) {
      throw new Error(`${configPath} did not contain a JSON object -- refusing to overwrite it.`);
    }
    backup = backupIfExists(configPath);
  } else {
    mkdirSync(targetDir, { recursive: true });
    config = { $schema: "https://opencode.ai/config.json" };
    created = true;
  }

  if (!config.mcp || typeof config.mcp !== "object" || Array.isArray(config.mcp)) {
    config.mcp = {};
  }

  const entry = {
    type: "local",
    command: ["npx", "-y", "tsx", "index.ts"],
    cwd: mcpCwd,
    enabled: true,
  };
  if (environment && Object.keys(environment).length) {
    entry.environment = environment;
  }
  const replaced = Boolean(config.mcp.whatsapp);
  config.mcp.whatsapp = entry;

  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");

  return { configPath, backup, hadComments, created, replaced, entry };
}

// Builds the `environment` object from the collected answers, including only
// values that differ from the code's built-in defaults so the written config
// stays minimal and readable.
export function buildEnvironment(answers) {
  const env = {};
  if (answers.allowlist) env.WHATSAPP_ALLOWED_RECIPIENTS = answers.allowlist;
  if (answers.sendMax && answers.sendMax !== 10) env.WHATSAPP_SEND_MAX = String(answers.sendMax);
  if (answers.windowMs && answers.windowMs !== 60000) env.WHATSAPP_SEND_WINDOW_MS = String(answers.windowMs);
  if (answers.sendRoot) env.WHATSAPP_SEND_ROOT = answers.sendRoot;
  return env;
}
