import test from "node:test"
import assert from "node:assert/strict"
import { handleUpsert, getRecent, getMessageById, recordOutgoing } from "./messages.js"

// Build a synthetic Baileys "notify" upsert event for one message.
function notify(msg: any) {
  return { type: "notify", messages: [msg] }
}

function textMsg(id: string, jid: string, text: string, ts = 1000) {
  return {
    key: { remoteJid: jid, id, fromMe: false },
    message: { conversation: text },
    messageTimestamp: ts,
    pushName: "Tester",
  }
}

function imageMsg(id: string, jid: string, caption?: string, ts = 1000) {
  return {
    key: { remoteJid: jid, id, fromMe: false },
    message: { imageMessage: caption ? { caption } : {} },
    messageTimestamp: ts,
    pushName: "Tester",
  }
}

test("caption-less media is retained with a placeholder body and mediaType", () => {
  handleUpsert(notify(imageMsg("IMG_NOCAP", "111@s.whatsapp.net")))
  const found = getRecent(50).find((m) => m.id === "IMG_NOCAP")
  assert.ok(found, "caption-less image should be recorded, not dropped")
  assert.equal(found!.body, "[image]")
  assert.equal(found!.mediaType, "image")
})

test("media with a caption keeps the caption as the body", () => {
  handleUpsert(notify(imageMsg("IMG_CAP", "111@s.whatsapp.net", "hello")))
  const found = getRecent(50).find((m) => m.id === "IMG_CAP")
  assert.equal(found!.body, "hello")
  assert.equal(found!.mediaType, "image")
})

test("non-media, non-text messages are skipped", () => {
  const before = getRecent(200).length
  handleUpsert(notify({ key: { remoteJid: "111@s.whatsapp.net", id: "EMPTY" }, message: { pollUpdateMessage: {} }, messageTimestamp: 1000 }))
  assert.equal(getRecent(200).find((m) => m.id === "EMPTY"), undefined)
  assert.equal(getRecent(200).length, before)
})

test("getMessageById returns the stored key and raw message", () => {
  handleUpsert(notify(textMsg("TXT_1", "222@s.whatsapp.net", "yo")))
  const resolved = getMessageById("TXT_1")
  assert.ok(resolved)
  assert.equal(resolved!.key.id, "TXT_1")
  assert.equal(resolved!.chatJid, "222@s.whatsapp.net")
  assert.equal(resolved!.raw.message.conversation, "yo")
})

test("getMessageById returns null for an unknown id", () => {
  assert.equal(getMessageById("NOPE"), null)
})

test("recordOutgoing makes a sent message resolvable for edit/delete/react", () => {
  const sent = {
    key: { remoteJid: "444@s.whatsapp.net", id: "OUT_1", fromMe: true },
    message: { conversation: "hi there" },
    messageTimestamp: 5000,
  }
  recordOutgoing(sent, "hi there")
  const resolved = getMessageById("OUT_1")
  assert.ok(resolved, "an outgoing message should be resolvable by its send id")
  assert.equal(resolved!.key.fromMe, true)
  assert.equal(resolved!.chatJid, "444@s.whatsapp.net")
  // It should also surface in the recent list, marked as ours.
  const inRecent = getRecent(50).find((m) => m.id === "OUT_1")
  assert.equal(inRecent!.fromMe, true)
  assert.equal(inRecent!.body, "hi there")
})

test("recordOutgoing ignores a send result with no id", () => {
  recordOutgoing({ key: {} }, "nope")
  assert.equal(getRecent(200).find((m) => m.body === "nope"), undefined)
})

test("the raw-message map is bounded (oldest ages out past the cap)", () => {
  for (let i = 0; i < 260; i++) {
    handleUpsert(notify(textMsg(`BULK_${i}`, "333@s.whatsapp.net", `m${i}`, 2000 + i)))
  }
  // The earliest bulk id should have been evicted; a recent one should remain.
  assert.equal(getMessageById("BULK_0"), null)
  assert.ok(getMessageById("BULK_259"))
})
