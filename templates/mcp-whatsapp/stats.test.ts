import test from "node:test"
import assert from "node:assert/strict"
import { recordDeliveryTransition, getStats, resetStats } from "./stats.js"

test("recordDeliveryTransition moves a message through the buckets", () => {
  resetStats()
  const id = "STATS_1"
  // Status 2 = SERVER_ACK
  recordDeliveryTransition(id, 2)
  // Promotion to 3 = DELIVERY_ACK decrements 2, increments 3
  recordDeliveryTransition(id, 3)
  // No-op: status 1 < current 3
  recordDeliveryTransition(id, 1)

  const s = getStats()
  assert.equal(s.buckets.serverAck, 0, "should have promoted out of SERVER_ACK")
  assert.equal(s.buckets.delivered, 1, "should sit in DELIVERY_ACK now")
  assert.equal(s.buckets.error, 0)
})

test("recordDeliveryTransition counts ERROR distinctly", () => {
  resetStats()
  recordDeliveryTransition("ERR_1", 0)
  const s = getStats()
  assert.equal(s.buckets.error, 1)
  assert.ok(s.lastErrorAt > 0)
})

test("getStats returns sensible defaults after reset", () => {
  resetStats()
  const s = getStats()
  assert.equal(s.messagesSent, 0)
  assert.equal(s.deliveryRate, 0)
  assert.equal(s.topRecipients.length, 0)
  assert.equal(s.lastErrorAt, null)
  assert.ok(s.uptimeMs >= 0)
})

test("recordSend bumps per-recipient counter", async () => {
  resetStats()
  const { recordSend } = await import("./stats.js")
  recordSend("628111111111@s.whatsapp.net")
  recordSend("628111111111@s.whatsapp.net")
  recordSend("628222222222@s.whatsapp.net")
  const s = getStats()
  assert.equal(s.messagesSent, 3)
  assert.equal(s.topRecipients.length, 2)
  assert.equal(s.topRecipients[0].count, 2)
  assert.equal(s.topRecipients[0].jid, "628111111111@s.whatsapp.net")
})

test("formatUptime formats h/m/s correctly", async () => {
  const { formatUptime } = await import("./stats.js")
  assert.equal(formatUptime(0), "0s")
  assert.equal(formatUptime(45_000), "45s")
  assert.equal(formatUptime(125_000), "2m 5s")
  assert.equal(formatUptime(3_725_000), "1h 2m 5s")
})