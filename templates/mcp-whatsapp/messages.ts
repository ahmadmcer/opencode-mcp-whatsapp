// In-memory ingestion of inbound WhatsApp messages. This is domain state, so it
// lives here rather than in the tool (presentation) layer. `handleUpsert` is
// attached to the socket inside store.initConnection(), so it re-binds on every
// (re)connect — no messages are missed and no listener leaks to a dead socket.

import { record as recordHistory } from "./historyStore.js"

export type MediaType = "image" | "video" | "document" | "audio" | "sticker"

// A minimal shape of the Baileys message key. Kept structural (not imported from
// baileys) so this module and its tests stay dependency-free.
export type MsgKey = {
  remoteJid?: string | null
  id?: string | null
  fromMe?: boolean | null
  participant?: string | null
}

export type Recent = {
  ts: number
  from: string
  fromName?: string
  body: string
  fromMe: boolean
  id: string
  chatJid: string
  mediaType?: MediaType
  key: MsgKey
}

export type ChatEntry = { jid: string; name: string; lastTs: number; lastBody: string }

// A resolved reference to a stored message, used by the message-action tools
// (react / edit / delete / read / download) to recover the Baileys key and the
// raw message from an agent-supplied id.
export type ResolvedMessage = {
  key: MsgKey
  raw: any
  chatJid: string
  mediaType?: MediaType
}

import { logger } from "./logger.js"
import { recordDeliveryTransition } from "./stats.js"

const MAX_RECENT = 200
const MAX_CHATS = 200
const MAX_RAW = 200

const recent: Recent[] = []
const chatMap = new Map<string, ChatEntry>()
// Bounded id -> raw WAMessage map so the action tools can look a message up by id
// long after it scrolled out of the rendered `recent` list. Insertion-ordered, so
// the first key is always the oldest — cheap FIFO eviction.
const rawById = new Map<string, any>()
// Latest known delivery status per outgoing message id, so the agent can ask
// whether a send actually reached the recipient. WhatsApp status codes:
//   0=ERROR, 1=PENDING, 2=SERVER_ACK, 3=DELIVERY_ACK, 4=READ, 5=PLAYED.
// Bounded so a long-running session can't grow without limit; oldest evicted.
const MAX_STATUS = 500
const statusById = new Map<string, number>()

// Detects a media message with no text body and returns its type + a display
// placeholder, so images/videos/etc. are no longer dropped for lacking a caption.
function detectMedia(message: any): { type: MediaType; placeholder: string } | null {
  if (message.imageMessage) return { type: "image", placeholder: "[image]" }
  if (message.videoMessage) return { type: "video", placeholder: "[video]" }
  if (message.documentMessage || message.documentWithCaptionMessage)
    return { type: "document", placeholder: "[document]" }
  if (message.audioMessage) return { type: "audio", placeholder: "[audio]" }
  if (message.stickerMessage) return { type: "sticker", placeholder: "[sticker]" }
  return null
}

// Parse a raw WAMessage into the normalized fields both the live buffer and the
// history store need, or null for messages that are neither text nor recognized
// media. Shared by handleUpsert (live) and the messaging-history.set handler.
export function extractMessage(m: any): (Recent & { raw: any }) | null {
  if (!m?.message || !m?.key) return null
  // Documents sent with a caption arrive wrapped; unwrap so both the body and
  // the media detection see the inner message.
  const inner = m.message.documentWithCaptionMessage?.message ?? m.message
  const text =
    inner.conversation ||
    inner.extendedTextMessage?.text ||
    inner.imageMessage?.caption ||
    inner.videoMessage?.caption ||
    inner.documentMessage?.caption ||
    ""
  const media = detectMedia(inner)
  if (!text && !media) return null
  const from = m.key.remoteJid ?? "unknown"
  return {
    ts: Number(m.messageTimestamp ?? Math.floor(Date.now() / 1000)),
    from: m.key.participant ?? from,
    fromName: m.pushName ?? undefined,
    body: text || media!.placeholder,
    fromMe: m.key.fromMe ?? false,
    id: m.key.id ?? "",
    chatJid: from,
    mediaType: media?.type,
    key: m.key,
    raw: m,
  }
}

// Persist an extracted message into the searchable history store (used by both
// the live and history-sync paths).
export function toHistory(ex: Recent) {
  recordHistory({
    id: ex.id,
    chatJid: ex.chatJid,
    from: ex.from,
    fromName: ex.fromName,
    fromMe: ex.fromMe,
    ts: ex.ts,
    body: ex.body,
    mediaType: ex.mediaType,
  })
}

export function handleUpsert(evt: any) {
  // Only real-time notifications; skip history-sync ("append"/undefined) floods.
  if (evt?.type !== "notify") return
  for (const m of evt?.messages ?? []) {
    const ex = extractMessage(m)
    if (!ex) continue
    const { raw, ...rec } = ex
    recent.push(rec)
    if (recent.length > MAX_RECENT) recent.shift()

    rememberRaw(rec.id, m)
    toHistory(rec)

    const cur = chatMap.get(rec.chatJid) ?? { jid: rec.chatJid, name: rec.fromName ?? rec.chatJid, lastTs: 0, lastBody: "" }
    if (rec.ts >= cur.lastTs) {
      cur.lastTs = rec.ts
      cur.lastBody = rec.body.slice(0, 80)
      if (rec.fromName) cur.name = rec.fromName
    }
    chatMap.set(rec.chatJid, cur)
    evictOldestChat()
  }
}

// Store a raw message under its id for later key lookup, FIFO-bounded so a
// long-lived session can't grow the map without limit.
function rememberRaw(id: string, raw: any) {
  if (!id) return
  rawById.set(id, raw)
  if (rawById.size > MAX_RAW) {
    const oldest = rawById.keys().next().value
    if (oldest !== undefined) rawById.delete(oldest)
  }
}

// Record a message this session just sent so the action tools (edit / delete /
// react / reply) can reference it by the id that the send_* tools return.
// Baileys does not surface our own sends via messages.upsert, so we register them
// explicitly here. `summary` is a short display body for messages_upsert.
export function recordOutgoing(sent: any, summary: string, mediaType?: MediaType) {
  const id = sent?.key?.id
  if (!id) return
  const jid = sent.key.remoteJid ?? "unknown"
  const rec: Recent = {
    ts: Number(sent.messageTimestamp ?? Math.floor(Date.now() / 1000)),
    from: jid,
    fromName: "me",
    body: summary,
    fromMe: true,
    id,
    chatJid: jid,
    mediaType,
    key: sent.key,
  }
  recent.push(rec)
  if (recent.length > MAX_RECENT) recent.shift()
  rememberRaw(id, sent)
  toHistory(rec)
  // Bump the per-recipient counter so `connection_state` can rank who's
  // been chatted with most. Counter lives in stats.ts so the module-level
  // singleton stays un-imported-cyclic.
  void import("./stats.js").then(({ recordSend }) => recordSend(jid))
}

// Bound chatMap so a long-lived session that touches many chats can't grow
// without limit. Evicts the least-recently-active entry.
function evictOldestChat() {
  if (chatMap.size <= MAX_CHATS) return
  let oldestKey: string | null = null
  let oldestTs = Infinity
  for (const [k, v] of chatMap) {
    if (v.lastTs < oldestTs) {
      oldestTs = v.lastTs
      oldestKey = k
    }
  }
  if (oldestKey) chatMap.delete(oldestKey)
}

export function getRecent(limit: number): Recent[] {
  return recent.slice(-limit).reverse()
}

export function getChats(limit: number): ChatEntry[] {
  return Array.from(chatMap.values())
    .sort((a, b) => b.lastTs - a.lastTs)
    .slice(0, limit)
}

// Resolve an agent-supplied message id to its Baileys key + raw message. Returns
// null when the id was never seen (or has aged out of the bounded buffer), which
// the tool layer turns into a "call messages_upsert first" error.
// The raw WAMessage for an id, or null. Backs the socket's `getMessage` config
// (message-retry resend + poll-vote decryption).
export function getRawMessageById(id: string): any | null {
  return rawById.get(id) ?? null
}

export function getMessageById(id: string): ResolvedMessage | null {
  const raw = rawById.get(id)
  if (!raw) return null
  const entry = recent.find((r) => r.id === id)
  return {
    key: raw.key,
    raw,
    chatJid: raw.key?.remoteJid ?? entry?.chatJid ?? "unknown",
    mediaType: entry?.mediaType,
  }
}

/**
 * Look up a LID that we've already passively observed for a phone number.
 * Baileys does NOT publish `remoteJid` as a LID for plain 1:1 chats, but it
 * DOES publish `remoteJid` (or `remoteJidAlternate` / `participant`) as the
 * LID for groups, channels, and certain device-tied messages. When you've
 * received a message *from* the contact in a group context, the LID-PN
 * mapping is cached here.
 *
 * Returns the LID JID (`…@lid`) or null if no cached mapping exists.
 */
export function getCachedLidForPn(pn: string): string | null {
  const digits = pn.replace(/\D/g, "")
  for (const raw of rawById.values()) {
    const key = raw?.key
    if (!key) continue
    const candidates = [key.remoteJid, key.participant, key.remoteJidAlternate].filter(Boolean) as string[]
    for (const jid of candidates) {
      if (!jid.endsWith("@lid")) continue
      const local = jid.split("@")[0].split(":")[0]
      // Heuristic: if the LID-local is a phone-like number that matches the
      // PN's last 7-12 digits, it's almost certainly the same user. A real
      // LID is opaque; the only stable signal is "this conversation worked",
      // so we accept either an exact suffix match or a shared trailing 9
      // digits (WhatsApp LIDs in our observation are the same PN but with a
      // trailing check digit difference).
      if (local === digits || (local.length >= 9 && digits.endsWith(local.slice(-9)))) {
        return jid
      }
    }
  }
  return null
}

// Status code labels for the `message_status` tool and the logger.
const STATUS_NAMES: Record<number, string> = {
  0: "ERROR",
  1: "PENDING",
  2: "SERVER_ACK",
  3: "DELIVERY_ACK",
  4: "READ",
  5: "PLAYED",
}

/**
 * Subscribe to Baileys `messages.update` events. Each entry carries a key +
 * an `update` patch; we only care about `update.status` changes (delivery
 * state for our own sends and read-receipts for inbound). Anything else
 * (poll votes, reactions) is ignored here.
 *
 * Surface ERRORs to STDERR so the user sees them in the OpenCode TUI — the
 * `send_message` tool resolves on enqueue and never fails on server-side
 * delivery rejection, so this is the only visibility we get.
 */
export function handleMessageUpdate(updates: any[]) {
  for (const u of updates ?? []) {
    const id = u?.key?.id
    if (!id) continue
    const status = typeof u?.update?.status === "number" ? u.update.status : null
    if (status == null) continue
    statusById.set(id, status)
    if (statusById.size > MAX_STATUS) {
      const oldest = statusById.keys().next().value
      if (oldest !== undefined) statusById.delete(oldest)
    }
    if (status === 0) {
      const jid = u.key.remoteJid ?? "?"
      logger.warn({ messageId: id, jid, update: u.update }, `delivery ERROR for ${id} → ${jid}`)
    }
    // Track the highest status we've seen for stats — moved to its own
    // helper so `connection_state` can show delivery-rate at a glance.
    recordDeliveryTransition(id, status)
  }
}

/** Latest known delivery status for a message id, or null if never seen. */
export function getMessageStatus(id: string): { code: number; name: string } | null {
  const code = statusById.get(id)
  if (code == null) return null
  return { code, name: STATUS_NAMES[code] ?? `UNKNOWN(${code})` }
}
