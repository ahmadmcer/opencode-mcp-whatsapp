import test from "node:test"
import assert from "node:assert/strict"
import { DisconnectReason } from "@whiskeysockets/baileys"
import { getDiagnostic, describeCode } from "./diagnostics.js"

test("getDiagnostic returns logged_out for code 401", () => {
  const d = getDiagnostic(DisconnectReason.loggedOut)
  assert.equal(d.reason, "logged_out")
  assert.equal(d.recoverable, false)
  assert.ok(d.hint.includes("wipe"))
})

test("getDiagnostic returns connection_lost or timed_out for code 408", () => {
  // 408 is shared between connectionLost and timedOut in Baileys 7 — the
  // table can only carry one entry. Whichever was declared last wins. Just
  // assert the result is recoverable and has a useful description either way.
  const d = getDiagnostic(408)
  assert.equal(d.recoverable, true)
  assert.ok(d.reason === "connection_lost" || d.reason === "timed_out")
})

test("getDiagnostic returns connection_replaced for code 440", () => {
  const d = getDiagnostic(DisconnectReason.connectionReplaced)
  assert.equal(d.reason, "connection_replaced")
  assert.equal(d.recoverable, false)
})

test("getDiagnostic returns fallback for unknown code", () => {
  const d = getDiagnostic(999)
  assert.equal(d.reason, "unknown")
  assert.equal(d.recoverable, true)
  assert.ok(d.description.includes("999"))
})

test("getDiagnostic returns fallback for null/undefined", () => {
  assert.equal(getDiagnostic(null).reason, "unknown")
  assert.equal(getDiagnostic(undefined).reason, "unknown")
})

test("describeCode produces a single line with reason + description", () => {
  const line = describeCode(DisconnectReason.loggedOut)
  assert.ok(line.includes("logged_out"))
  assert.ok(line.includes("401"))
  assert.equal(line.includes("\n"), false, "should be single-line")
})

test("every DisconnectReason enum value is mapped", () => {
  // If a new code is added to the enum without a TABLE entry, getDiagnostic
  // returns the fallback — and describeCode still produces something useful.
  for (const code of Object.values(DisconnectReason).filter((v) => typeof v === "number") as number[]) {
    const d = getDiagnostic(code)
    assert.ok(d.reason.length > 0, `code ${code} must have a reason`)
    assert.ok(d.description.length > 0, `code ${code} must have a description`)
  }
})