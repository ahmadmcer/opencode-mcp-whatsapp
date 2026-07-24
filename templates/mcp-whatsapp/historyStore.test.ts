import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  record,
  recordMany,
  getChatMessages,
  searchMessages,
  listChats,
  setStoreFile,
  flush,
  load,
  type HistMsg,
} from "./historyStore.js"

function msg(id: string, chatJid: string, body: string, ts: number, fromMe = false): HistMsg {
  return { id, chatJid, from: chatJid, fromName: "T", fromMe, ts, body }
}

// Unique jids per test so the shared module state doesn't cross-contaminate.

test("record dedupes by id and keeps messages ts-ascending", () => {
  const jid = "hsA@s.whatsapp.net"
  record(msg("A2", jid, "second", 200))
  record(msg("A1", jid, "first", 100))
  record(msg("A2", jid, "dupe ignored", 200)) // same id
  const out = getChatMessages(jid, { limit: 10 })
  assert.deepEqual(out.map((m) => m.id), ["A1", "A2"])
  assert.equal(out[1].body, "second")
})

test("getChatMessages honors limit and the before cursor", () => {
  const jid = "hsB@s.whatsapp.net"
  recordMany([msg("B1", jid, "m1", 100), msg("B2", jid, "m2", 200), msg("B3", jid, "m3", 300)])
  assert.deepEqual(getChatMessages(jid, { limit: 2 }).map((m) => m.id), ["B2", "B3"])
  assert.deepEqual(getChatMessages(jid, { before: 300 }).map((m) => m.id), ["B1", "B2"])
})

test("searchMessages is case-insensitive, newest-first, and chat-filterable", () => {
  const a = "hsC1@s.whatsapp.net"
  const b = "hsC2@s.whatsapp.net"
  recordMany([msg("C1", a, "Hello World", 100), msg("C2", b, "hello there", 200), msg("C3", a, "unrelated", 300)])
  const all = searchMessages("HELLO")
  assert.deepEqual(all.map((m) => m.id), ["C2", "C1"]) // newest first
  const onlyA = searchMessages("hello", { chat: a })
  assert.deepEqual(onlyA.map((m) => m.id), ["C1"])
})

test("listChats orders by most recent activity", () => {
  recordMany([msg("D1", "hsD1@s.whatsapp.net", "old", 1000), msg("D2", "hsD2@s.whatsapp.net", "new", 2000)])
  const chats = listChats(50).filter((c) => c.jid.startsWith("hsD"))
  assert.equal(chats[0].jid, "hsD2@s.whatsapp.net")
})

test("the per-chat cap evicts oldest beyond 1000", () => {
  const jid = "hsE@s.whatsapp.net"
  const batch: HistMsg[] = []
  for (let i = 0; i < 1005; i++) batch.push(msg(`E${i}`, jid, `m${i}`, 1000 + i))
  recordMany(batch)
  const out = getChatMessages(jid, { limit: 5000 })
  assert.equal(out.length, 1000)
  assert.equal(out[0].id, "E5") // E0..E4 evicted
})

test("flush writes a JSON snapshot and load restores it", () => {
  const file = join(tmpdir(), `wa-hist-${process.pid}-${Date.now()}.json`)
  setStoreFile(file)
  try {
    record(msg("F1", "hsF@s.whatsapp.net", "persisted", 500))
    flush()
    const raw = JSON.parse(readFileSync(file, "utf8"))
    assert.ok(raw.msgs.some((m: any) => m.id === "F1" && m.body === "persisted"))

    // Craft a file with a NEW id and confirm load() ingests it.
    const file2 = join(tmpdir(), `wa-hist2-${process.pid}-${Date.now()}.json`)
    setStoreFile(file2)
    writeFileSync(file2, JSON.stringify({ version: 1, msgs: [msg("F2", "hsG@s.whatsapp.net", "loaded", 600)], contacts: [], chatNames: [] }))
    load()
    assert.ok(getChatMessages("hsG@s.whatsapp.net").some((m) => m.id === "F2" && m.body === "loaded"))
    rmSync(file2, { force: true })
  } finally {
    rmSync(file, { force: true })
  }
})
