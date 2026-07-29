// Structured logging via pino with file output. MCP errors and diagnostics
// land in `~/.config/opencode/mcp-whatsapp/logs/app.log` so post-mortem
// analysis survives restarts (vs. ephemeral STDERR). Pattern adapted from
// whatsapp-persona-bot/src/utils/logger.ts.

import pino from "pino"
import { existsSync, mkdirSync, createWriteStream } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"

const DEFAULT_DIR = join(homedir(), ".config", "opencode", "mcp-whatsapp", "logs")
const DEFAULT_FILE = "app.log"

// Per-process override path so tests can redirect logs without polluting the
// user's real log dir. Lazy-read (not captured at import) so setLogFile can be
// called before the logger is built.
let logFileOverride: string | undefined
export function setLogFile(path: string) {
  logFileOverride = path
}

function strEnv(name: string, def: string): string {
  return process.env[name] ?? def
}

function resolveLogPath(): string {
  if (logFileOverride) return logFileOverride
  const file = process.env.WHATSAPP_LOG_FILE ?? DEFAULT_FILE
  // If WHATSAPP_LOG_FILE is absolute (e.g. on Windows starts with drive letter,
  // or starts with /) use it as-is; otherwise join with the default log dir.
  const isAbs = file.match(/^[a-zA-Z]:[\\/]/) !== null || file.startsWith("/")
  if (isAbs) return file
  const dir = process.env.WHATSAPP_LOG_DIR ?? DEFAULT_DIR
  return join(dir, file)
}

function buildLogger() {
  const file = resolveLogPath()
  const dir = dirname(file)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const level = strEnv("WHATSAPP_LOG_LEVEL", "info")
  // Use a writeStream for the file destination (sync writes, no pino
  // worker-thread complexity) and pino-pretty would normally pipe to stdout,
  // but we keep stdout writes simple here for cross-platform reliability.
  const fileStream = createWriteStream(file, { flags: "a" })
  return pino({ level }, fileStream)
}

// Singleton — the first import in the process creates it; subsequent imports
// share the same instance. Tests can call setLogFile() before the first import
// to redirect writes.
export const logger = buildLogger()

export function logPath(): string {
  return resolveLogPath()
}