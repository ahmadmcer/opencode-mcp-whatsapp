// In-memory ingestion of inbound WhatsApp messages. This is domain state, so it
// lives here rather than in the tool (presentation) layer. `handleUpsert` is
// attached to the socket inside store.initConnection(), so it re-binds on every
// (re)connect — no messages are missed and no listener leaks to a dead socket.

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

const MAX_RECENT = 200
const MAX_CHATS = 200
const MAX_RAW = 200

const recent: Recent[] = []
const chatMap = new Map<string, ChatEntry>()
// Bounded id -> raw WAMessage map so the action tools can look a message up by id
// long after it scrolled out of the rendered `recent` list. Insertion-ordered, so
// the first key is always the oldest — cheap FIFO eviction.
const rawById = new Map<string, any>()

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

export function handleUpsert(evt: any) {
  // Only real-time notifications; skip history-sync ("append"/undefined) floods.
  if (evt?.type !== "notify") return
  for (const m of evt?.messages ?? []) {
    if (!m?.message || !m?.key) continue
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
    // Skip only messages that are neither text nor recognized media (receipts,
    // reactions, protocol messages, ...).
    if (!text && !media) continue
    const body = text || media!.placeholder

    const from = m.key.remoteJid ?? "unknown"
    const id = m.key.id ?? ""
    recent.push({
      ts: Number(m.messageTimestamp ?? Math.floor(Date.now() / 1000)),
      from: m.key.participant ?? from,
      fromName: m.pushName,
      body,
      fromMe: m.key.fromMe ?? false,
      id,
      chatJid: from,
      mediaType: media?.type,
      key: m.key,
    })
    if (recent.length > MAX_RECENT) recent.shift()

    rememberRaw(id, m)

    const cur = chatMap.get(from) ?? { jid: from, name: m.pushName ?? from, lastTs: 0, lastBody: "" }
    const ts = Number(m.messageTimestamp ?? 0)
    if (ts >= cur.lastTs) {
      cur.lastTs = ts
      cur.lastBody = body.slice(0, 80)
      if (m.pushName) cur.name = m.pushName
    }
    chatMap.set(from, cur)
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
  recent.push({
    ts: Number(sent.messageTimestamp ?? Math.floor(Date.now() / 1000)),
    from: jid,
    fromName: "me",
    body: summary,
    fromMe: true,
    id,
    chatJid: jid,
    mediaType,
    key: sent.key,
  })
  if (recent.length > MAX_RECENT) recent.shift()
  rememberRaw(id, sent)
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
