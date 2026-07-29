import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

// `setLogFile` must be called BEFORE the logger singleton is imported so the
// pino transport is built with the right destination. Top-level imports
// happen after the env setup, so this works.
test("logger writes to configured path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wp-log-"))
  const file = join(dir, "test.log")
  process.env.WHATSAPP_LOG_FILE = file
  process.env.WHATSAPP_LOG_LEVEL = "info"
  try {
    const { setLogFile, logger, logPath } = await import("./logger.js?bust=" + Date.now())
    setLogFile(file)
    logger.info({ test: 1 }, "hello pino")
    await new Promise((r) => setTimeout(r, 150))
    assert.ok(existsSync(file), `expected log file at ${file} (resolved=${logPath()})`)
    const contents = readFileSync(file, "utf8")
    assert.ok(contents.includes("hello pino"), `log should contain message, got: ${contents}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    delete process.env.WHATSAPP_LOG_FILE
  }
})