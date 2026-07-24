import { homedir } from "node:os";
import path from "node:path";

// Node does not expand `~` itself -- do it by hand rather than pulling in a dependency.
export function expandHome(p) {
  if (!p) return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(homedir(), p.slice(2));
  return p;
}

export function defaultTargetDir() {
  return path.join(homedir(), ".config", "opencode");
}

export function resolveTargetDir(input) {
  return path.resolve(expandHome(input));
}

// opencode consumes the MCP `cwd` string with its own resolver, so it must use
// forward slashes even on Windows (mirrors how tui.json plugin paths are handled).
export function toConfigPath(p) {
  return p.replaceAll("\\", "/");
}
