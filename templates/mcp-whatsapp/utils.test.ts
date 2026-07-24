import test from "node:test"
import assert from "node:assert/strict"
import { join } from "node:path"
import { homedir } from "node:os"
import { toJid, isAbsolutePath, filenameOf, isInside, resolveWithinRoots, buildVcard } from "./utils.js"

test("toJid normalizes messy phone numbers", () => {
  assert.equal(toJid("+1 (555) 123-4567"), "15551234567@s.whatsapp.net")
  assert.equal(toJid("  447700900123 "), "447700900123@s.whatsapp.net")
})

test("toJid passes JIDs through untouched (incl. groups)", () => {
  assert.equal(toJid("15551234567@s.whatsapp.net"), "15551234567@s.whatsapp.net")
  assert.equal(toJid("120363000000000000@g.us"), "120363000000000000@g.us")
})

test("toJid rejects too-short numbers", () => {
  assert.throws(() => toJid("123"))
})

test("isAbsolutePath recognizes posix, drive-letter, and UNC paths", () => {
  assert.equal(isAbsolutePath("/etc/passwd"), true)
  assert.equal(isAbsolutePath("C:\\Users\\a"), true)
  assert.equal(isAbsolutePath("\\\\server\\share"), true)
  assert.equal(isAbsolutePath("relative/path"), false)
})

test("filenameOf extracts the basename across separators", () => {
  assert.equal(filenameOf("C:\\a\\b\\c.png"), "c.png")
  assert.equal(filenameOf("/a/b/report.pdf"), "report.pdf")
  assert.equal(filenameOf(""), "file")
})

test("isInside detects containment and blocks traversal", () => {
  const root = join(homedir(), "Downloads")
  assert.equal(isInside(root, join(root, "pic.png")), true)
  assert.equal(isInside(root, join(root, "sub", "deep", "pic.png")), true)
  assert.equal(isInside(root, join(root, "..", "secret.txt")), false)
  assert.equal(isInside(root, join(homedir(), ".ssh", "id_rsa")), false)
})

test("resolveWithinRoots allows files under a root", () => {
  const root = join(homedir(), "Downloads")
  assert.equal(resolveWithinRoots([root], join(root, "invoice.pdf")), join(root, "invoice.pdf"))
})

test("resolveWithinRoots rejects paths outside every root (exfil guard)", () => {
  const root = join(homedir(), "Downloads")
  assert.throws(() => resolveWithinRoots([root], join(homedir(), ".ssh", "id_rsa")))
  assert.throws(() => resolveWithinRoots([root], join(root, "..", "..", "etc", "passwd")))
})

test("buildVcard normalizes the phone and carries a waid", () => {
  const vcard = buildVcard("Jeff", "+1 (555) 123-4567")
  assert.match(vcard, /^BEGIN:VCARD\nVERSION:3.0\n/)
  assert.match(vcard, /FN:Jeff\n/)
  assert.match(vcard, /TEL;type=CELL;type=VOICE;waid=15551234567:\+15551234567/)
  assert.match(vcard, /\nEND:VCARD$/)
})

test("buildVcard escapes structural characters in the display name", () => {
  const vcard = buildVcard("Doe; Jane, MD", "447700900123")
  assert.match(vcard, /FN:Doe\\; Jane\\, MD\n/)
})

test("buildVcard rejects too-short phone numbers", () => {
  assert.throws(() => buildVcard("X", "123"))
})
