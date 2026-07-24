import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { backupIfExists } from "./backup.mjs";

// Copies one file verbatim, backing up any pre-existing file at the
// destination first. Returns the backup path (or null).
export function copyFile(srcPath, destPath) {
  mkdirSync(path.dirname(destPath), { recursive: true });
  const backup = backupIfExists(destPath);
  const content = readFileSync(srcPath, "utf8");
  writeFileSync(destPath, content, "utf8");
  return backup;
}
