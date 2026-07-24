import { shellExec, shellExecInherit } from "./shellExec.mjs";

// Runs `npm install` in the mcp-whatsapp folder so Baileys and friends are
// available before OpenCode ever launches the server. cwd (not process.chdir or
// a --prefix arg) so the installer's own cwd is untouched and the user path
// never lands inside the shell command string. stdio inherited so a multi-second
// install doesn't look hung.
export function runNpmInstall(mcpDir) {
  console.log("\nRunning npm install in mcp-whatsapp (this pulls Baileys -- may take a minute)...");
  shellExecInherit("npm", ["install"], { cwd: mcpDir });
}

// Non-fatal: by the time this runs every file is already on disk, so a
// resolution miss here is diagnostic, not something to roll back over.
export function verifyConfig(targetDir) {
  let parsed;
  try {
    const out = shellExec("opencode", ["debug", "config"], { cwd: targetDir });
    parsed = JSON.parse(out);
  } catch (err) {
    console.log(`\nConfig did not resolve cleanly:\n  ${err.message}`);
    console.log("Files were already written -- re-run `opencode debug config` manually after investigating.");
    return false;
  }

  const ok = parsed.mcp?.whatsapp?.enabled === true;
  console.log("\nConfig verification (opencode debug config):");
  console.log(`  ${ok ? "OK" : "FAIL"}  mcp.whatsapp.enabled`);
  return ok;
}

export function listMcpStatus(targetDir) {
  console.log("\nMCP server status (opencode mcp list):");
  try {
    shellExecInherit("opencode", ["mcp", "list"], { cwd: targetDir });
  } catch (err) {
    console.log(`  Could not check MCP status: ${err.message}`);
  }
}
