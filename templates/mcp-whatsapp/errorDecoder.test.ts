import test from "node:test"
import assert from "node:assert/strict"
import { decodeSendError, formatDecodedError } from "./errorDecoder.js"

test("decodes network drop", () => {
  const d = decodeSendError(new Error("socket hang up"))
  assert.equal(d.reason, "network_drop")
  assert.ok(d.hint)
})

test("decodes stream closed", () => {
  const d = decodeSendError(new Error("Stream closed"))
  assert.equal(d.reason, "stream_closed")
})

test("decodes 403/forbidden", () => {
  const d = decodeSendError(new Error("403 Forbidden"))
  assert.equal(d.reason, "forbidden")
})

test("decodes 429/rate limit", () => {
  const d = decodeSendError(new Error("429 Too Many Requests"))
  assert.equal(d.reason, "rate_limit")
})

test("decodes invalid recipient", () => {
  const d = decodeSendError(new Error("invalid jid format"))
  assert.equal(d.reason, "invalid_recipient")
})

test("decodes payload too large", () => {
  const d = decodeSendError(new Error("413 Request Entity Too Large"))
  assert.equal(d.reason, "payload_too_large")
})

test("decodes session missing", () => {
  const d = decodeSendError(new Error("No SenderKeyRecord found"))
  assert.equal(d.reason, "no_session")
})

test("falls back to raw for unknown errors", () => {
  const d = decodeSendError(new Error("some weird new error from upstream"))
  assert.equal(d.reason, "unknown")
  assert.equal(d.raw, "some weird new error from upstream")
  assert.equal(d.message, "some weird new error from upstream")
  assert.equal(d.hint, null)
})

test("handles non-Error values", () => {
  const d = decodeSendError("just a string")
  assert.equal(d.raw, "just a string")
  assert.equal(d.reason, "unknown")
})

test("null/undefined pass through safely", () => {
  const d = decodeSendError(undefined)
  assert.equal(d.reason, "unknown")
  assert.ok(d.message.length > 0)
})

test("includes jid in message when provided", () => {
  const d = decodeSendError(new Error("Stream closed"), { jid: "628123456789@s.whatsapp.net" })
  assert.ok(d.message.includes("628123456789@s.whatsapp.net"))
})

test("formatDecodedError produces hint + raw line", () => {
  const d = decodeSendError(new Error("Stream closed"))
  const s = formatDecodedError(d)
  assert.ok(s.includes("Hint:"))
  assert.ok(s.includes("Stream closed"))
})