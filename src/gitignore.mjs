import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// Ensures the given ignore entries exist in <dir>/.gitignore. Additive and
// idempotent -- only missing lines are appended, under a labeled section, and
// nothing already present is disturbed. This is how a user who keeps their
// OpenCode config directory under git is protected from accidentally committing
// their WhatsApp session (which authenticates the account) or the installer's
// .bak files. Returns { file, added, created }.
const HEADER = "# opencode-mcp-whatsapp";

export function ensureGitignore(dir, entries) {
  const file = path.join(dir, ".gitignore");
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const present = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const missing = entries.filter((e) => !present.has(e));
  if (missing.length === 0) return { file, added: [], created: false };

  let out = existing;
  if (out && !out.endsWith("\n")) out += "\n";
  if (!present.has(HEADER)) out += `${HEADER}\n`;
  out += missing.join("\n") + "\n";
  writeFileSync(file, out, "utf8");
  return { file, added: missing, created: existing === "" };
}
