import { existsSync, renameSync } from "node:fs";

// Timestamp everywhere in this file avoids `:` -- invalid in Windows filenames.
function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z";
}

// Backs up a single file (not a whole folder) so a user's own pre-existing
// customization of e.g. just one source file is preserved individually rather
// than folded into one blanket folder-level backup. Returns the backup path,
// or null if there was nothing to back up.
export function backupIfExists(destPath) {
  if (!existsSync(destPath)) return null;
  const stamp = timestamp();
  let backupPath = `${destPath}.${stamp}.bak`;
  let n = 2;
  while (existsSync(backupPath)) {
    backupPath = `${destPath}.${stamp}-${n}.bak`;
    n++;
  }
  renameSync(destPath, backupPath);
  return backupPath;
}
