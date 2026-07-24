import test from "node:test"
import assert from "node:assert/strict"
import { parseAllowList, isAllowed, createRateLimiter, createPacer } from "./policy.js"

test("parseAllowList normalizes numbers/JIDs and splits on , ; and newline", () => {
  const list = parseAllowList("+1 (555) 123-4567, 447700900123 ; 120363000000000000@g.us")
  assert.deepEqual(list, [
    "15551234567@s.whatsapp.net",
    "447700900123@s.whatsapp.net",
    "120363000000000000@g.us",
  ])
})

test("parseAllowList returns null when unset or blank (no restriction)", () => {
  assert.equal(parseAllowList(undefined), null)
  assert.equal(parseAllowList("   "), null)
  assert.equal(parseAllowList(",, ; \n"), null)
})

test("isAllowed permits all when list is null, restricts otherwise", () => {
  assert.equal(isAllowed(null, "15551234567@s.whatsapp.net"), true)
  const list = ["15551234567@s.whatsapp.net"]
  assert.equal(isAllowed(list, "15551234567@s.whatsapp.net"), true)
  assert.equal(isAllowed(list, "99999999999@s.whatsapp.net"), false)
})

test("rate limiter allows up to max within the window, then blocks", () => {
  const rl = createRateLimiter(2, 1000)
  assert.equal(rl.check(0).ok, true)
  assert.equal(rl.check(100).ok, true)
  const third = rl.check(200)
  assert.equal(third.ok, false)
  if (!third.ok) assert.equal(third.retryAfterMs, 800) // 1000 - (200 - 0)
})

test("rate limiter frees capacity once the window slides past old sends", () => {
  const rl = createRateLimiter(1, 1000)
  assert.equal(rl.check(0).ok, true)
  assert.equal(rl.check(500).ok, false)
  assert.equal(rl.check(1000).ok, true) // the send at t=0 has aged out
})

test("pacer enforces a minimum gap between consecutive calls", async () => {
  const pace = createPacer(40)
  const t0 = Date.now()
  await pace() // first call: no wait
  await pace() // +40ms
  await pace() // +40ms
  assert.ok(Date.now() - t0 >= 75, "three paced calls should span ~2 gaps")
})

test("pacer with gap 0 is a no-op (disabled)", async () => {
  const pace = createPacer(0)
  const t0 = Date.now()
  await pace()
  await pace()
  assert.ok(Date.now() - t0 < 20)
})
