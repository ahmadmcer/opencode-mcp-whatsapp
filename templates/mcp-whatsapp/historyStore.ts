// Persistent, searchable message log. Unlike the ephemeral buffer in messages.ts
// (which keeps raw WAMessages for action-tool key lookup), this stores lightweight
// display records for *every* chat — populated from WhatsApp's history sync on link
// and from live messages — and survives restarts via a debounced JSON snapshot.
//
// Storage is a plain JSON file (no native deps) at <config>/whatsapp-store/, a
// sibling of the auth dir, so `relink { wipe: true }` (which deletes the auth dir)
// does not erase history. The file holds personal data and is git-ignored by the
// installer.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"

export type MediaType = "image" | "video" | "document" | "audio" | "sticker"

export type HistMsg = {
  id: string
  chatJid: string
  from: string
  fromName?: string
  fromMe: boolean
  ts: number
  body: string
  mediaType?: MediaType
}

export type ContactEntry = { jid: string; name?: string }
export type ChatSummary = { jid: string; name?: string; lastTs: number; lastBody: string }

function intEnv(name: string, def: number): number {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : def
}

const DEFAULT_FILE = join(homedir(), ".config", "opencode", "whatsapp-store", "history.json")
const PER_CHAT_MAX = 1000
const GLOBAL_MAX = intEnv("WHATSAPP_HISTORY_MAX", 20000)
const SAVE_DEBOUNCE_MS = 3000

// Overridable so tests can point at a temp file. Read lazily (not captured at
// import) so setStoreFile can redirect it before load()/flush().
let storeFile = process.env.WHATSAPP_HISTORY_FILE || DEFAULT_FILE
export function setStoreFile(path: string) {
  storeFile = path
}
export function getStoreFile() {
  return storeFile
}

const byChat = new Map<string, HistMsg[]>() // each array kept ts-ascending
const seen = new Set<string>() // message ids — dedupe + global count
const chatMeta = new Map<string, ChatSummary>()
const contacts = new Map<string, ContactEntry>()

let dirty = false
let saveTimer: ReturnType<typeof setTimeout> | null = null

function updateMeta(m: HistMsg) {
  const meta = chatMeta.get(m.chatJid) ?? { jid: m.chatJid, name: undefined, lastTs: 0, lastBody: "" }
  if (m.ts >= meta.lastTs) {
    meta.lastTs = m.ts
    meta.lastBody = m.body.slice(0, 80)
    // A DM's sender pushName is the contact's name; group participant names are not
    // the group's subject, so only trust names for one-to-one chats.
    if (m.fromName && !m.fromMe && m.chatJid.endsWith("@s.whatsapp.net")) meta.name = m.fromName
  }
  chatMeta.set(m.chatJid, meta)
}

function enforceGlobalCap() {
  while (seen.size > GLOBAL_MAX) {
    let oldestChat: string | null = null
    let oldestTs = Infinity
    for (const [jid, arr] of byChat) {
      if (arr.length && arr[0].ts < oldestTs) {
        oldestTs = arr[0].ts
        oldestChat = jid
      }
    }
    if (!oldestChat) break
    const arr = byChat.get(oldestChat)!
    const old = arr.shift()!
    seen.delete(old.id)
    if (arr.length === 0) byChat.delete(oldestChat)
  }
}

/** Record one or many messages. Dedupes by id, keeps each chat ts-sorted, and
 *  enforces the per-chat and global caps. */
export function recordMany(msgs: HistMsg[]) {
  const touched = new Set<string>()
  for (const m of msgs) {
    if (!m?.id || !m?.chatJid || seen.has(m.id)) continue
    seen.add(m.id)
    let arr = byChat.get(m.chatJid)
    if (!arr) {
      arr = []
      byChat.set(m.chatJid, arr)
    }
    arr.push(m)
    touched.add(m.chatJid)
    updateMeta(m)
  }
  if (touched.size === 0) return
  for (const jid of touched) {
    const arr = byChat.get(jid)!
    arr.sort((a, b) => a.ts - b.ts)
    while (arr.length > PER_CHAT_MAX) {
      const old = arr.shift()!
      seen.delete(old.id)
    }
  }
  enforceGlobalCap()
  markDirty()
}

export function record(m: HistMsg) {
  recordMany([m])
}

/** Fold a contact (from history sync) into the store; updates the chat name for DMs. */
export function upsertContact(c: ContactEntry) {
  if (!c?.jid) return
  const existing = contacts.get(c.jid)
  contacts.set(c.jid, { jid: c.jid, name: c.name ?? existing?.name })
  const meta = chatMeta.get(c.jid)
  if (meta && c.name) {
    meta.name = c.name
    markDirty()
  }
}

/** Set a chat's display name (e.g. a group's subject from history sync). */
export function setChatName(jid: string, name?: string) {
  if (!jid || !name) return
  const meta = chatMeta.get(jid) ?? { jid, name: undefined, lastTs: 0, lastBody: "" }
  meta.name = name
  chatMeta.set(jid, meta)
  markDirty()
}

/** Messages for a chat, chronological (ascending). `before` pages older (ts <). */
export function getChatMessages(jid: string, opts: { limit?: number; before?: number } = {}): HistMsg[] {
  const limit = opts.limit ?? 30
  let arr = byChat.get(jid) ?? []
  if (opts.before) arr = arr.filter((m) => m.ts < opts.before!)
  return arr.slice(-limit)
}

/** Case-insensitive substring search over stored bodies, newest first. */
export function searchMessages(query: string, opts: { chat?: string; limit?: number } = {}): HistMsg[] {
  const q = query.toLowerCase()
  const limit = opts.limit ?? 30
  const arrays = opts.chat ? [byChat.get(opts.chat) ?? []] : [...byChat.values()]
  const out: HistMsg[] = []
  for (const arr of arrays) for (const m of arr) if (m.body.toLowerCase().includes(q)) out.push(m)
  out.sort((a, b) => b.ts - a.ts)
  return out.slice(0, limit)
}

export function listChats(limit = 30): ChatSummary[] {
  return [...chatMeta.values()].sort((a, b) => b.lastTs - a.lastTs).slice(0, limit)
}

export function listContacts(limit = 100): ContactEntry[] {
  return [...contacts.values()].slice(0, limit)
}

/** Oldest stored message for a chat — the cursor for on-demand fetchMessageHistory. */
export function oldestFor(jid: string): HistMsg | null {
  const arr = byChat.get(jid)
  return arr && arr.length ? arr[0] : null
}

export function stats() {
  return { messages: seen.size, chats: chatMeta.size, contacts: contacts.size }
}

// --- persistence ---------------------------------------------------------

function markDirty() {
  dirty = true
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    flush()
  }, SAVE_DEBOUNCE_MS)
  // Don't let the pending save keep the process (or a test run) alive; shutdown
  // flushes explicitly via SIGINT/SIGTERM.
  saveTimer.unref?.()
}

/** Write the snapshot to disk immediately if there are unsaved changes. */
export function flush() {
  if (!dirty) return
  dirty = false
  try {
    mkdirSync(dirname(storeFile), { recursive: true })
    const msgs: HistMsg[] = []
    for (const arr of byChat.values()) for (const m of arr) msgs.push(m)
    const names: [string, string][] = []
    for (const meta of chatMeta.values()) if (meta.name) names.push([meta.jid, meta.name])
    const payload = { version: 1, msgs, contacts: [...contacts.values()], chatNames: names }
    writeFileSync(storeFile, JSON.stringify(payload), "utf8")
  } catch (e) {
    console.error(`[whatsapp:history] save failed: ${(e as Error).message}`)
  }
}

/** Load the snapshot from disk. Missing/corrupt file starts empty. */
export function load() {
  try {
    if (!existsSync(storeFile)) return
    const payload = JSON.parse(readFileSync(storeFile, "utf8"))
    if (Array.isArray(payload?.msgs)) recordMany(payload.msgs)
    for (const c of payload?.contacts ?? []) upsertContact(c)
    for (const [jid, name] of payload?.chatNames ?? []) setChatName(jid, name)
    dirty = false // loading is not a change to persist back
  } catch (e) {
    console.error(`[whatsapp:history] load failed, starting empty: ${(e as Error).message}`)
  }
}
