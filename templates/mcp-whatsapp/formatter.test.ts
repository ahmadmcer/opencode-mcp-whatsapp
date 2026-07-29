import test from "node:test"
import assert from "node:assert/strict"
import { formatWhatsAppText, chunkMessage, splitBubbles } from "./formatter.js"

test("formatWhatsAppText strips <think> tags", () => {
  expect(formatWhatsAppText("hello <think>internal</think> world")).toBe("hello  world")
})
function expect<T>(actual: T): { toBe: (expected: T) => void } {
  return { toBe: (expected: T) => assert.deepStrictEqual(actual, expected) }
}

test("formatWhatsAppText strips <reasoning> tags", () => {
  expect(formatWhatsAppText("ok <reasoning>deep</reasoning> done")).toBe("ok  done")
})

test("formatWhatsAppText strips markdown code blocks", () => {
  expect(formatWhatsAppText('text ```json\n{"a":1}\n``` end')).toBe("text  end")
})

test("formatWhatsAppText strips [fact:...] markers", () => {
  expect(formatWhatsAppText("info [fact:something] more")).toBe("info  more")
})

test("formatWhatsAppText returns empty string for empty input", () => {
  expect(formatWhatsAppText("")).toBe("")
})

test("formatWhatsAppText handles whitespace-only input", () => {
  expect(formatWhatsAppText("   \n  ")).toBe("")
})

test("formatWhatsAppText preserves emoji", () => {
  expect(formatWhatsAppText("😊🎉🔥")).toBe("😊🎉🔥")
})

test("formatWhatsAppText preserves normal text", () => {
  expect(formatWhatsAppText("halo apa kabar?")).toBe("halo apa kabar?")
})

test("formatWhatsAppText converts markdown bold to WA bold", () => {
  expect(formatWhatsAppText("this is **important** really")).toBe("this is *important* really")
})

test("formatWhatsAppText strips heading markers", () => {
  expect(formatWhatsAppText("# Title\n## Sub\nbody")).toBe("Title\nSub\nbody")
})

test("chunkMessage returns single chunk for short text", () => {
  const r = chunkMessage("short text", 4096)
  assert.equal(r.length, 1)
  assert.equal(r[0], "short text")
})

test("chunkMessage splits at chunk boundary for long text", () => {
  // Build long text with sentence delimiters; the regex chunks on `.!?`/`\n`
  const text = "hello world. ".repeat(500) // ~6500 chars, many sentences
  const r = chunkMessage(text, 4096)
  assert.ok(r.length > 1, `expected multiple chunks, got ${r.length}`)
  for (const c of r) assert.ok(c.length <= 4096, `chunk too long: ${c.length}`)
})

test("chunkMessage handles empty string", () => {
  assert.deepEqual(chunkMessage("", 4096), [""])
})

test("splitBubbles splits on double newlines", () => {
  assert.deepEqual(splitBubbles("a\n\nb\n\nc"), ["a", "b", "c"])
})

test("splitBubbles merges numbered list items with preceding text", () => {
  const r = splitBubbles("intro\n\n1. first\n2. second\n\noutro")
  assert.equal(r.length, 2)
  assert.equal(r[0], "intro\n\n1. first\n2. second")
  assert.equal(r[1], "outro")
})

test("splitBubbles merges colon-ended lines with next segment", () => {
  const r = splitBubbles("Berikut langkahnya:\n\n1. step one\n2. step two")
  assert.equal(r.length, 1)
  assert.equal(r[0], "Berikut langkahnya:\n\n1. step one\n2. step two")
})

test("splitBubbles handles single paragraph", () => {
  assert.deepEqual(splitBubbles("just one"), ["just one"])
})

test("splitBubbles handles empty string", () => {
  assert.deepEqual(splitBubbles(""), [])
})