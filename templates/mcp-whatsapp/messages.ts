// In-memory ingestion of inbound WhatsApp messages. This is domain state, so it
// lives here rather than in the tool (presentation) layer. `handleUpsert` is
// attached to the socket inside store.initConnection(), so it re-binds on every
// (re)connect — no messages are missed and no listener leaks to a dead socket.

export type Recent = {
  ts: number
  from: string
  fromName?: string
  body: string
  fromMe: boolean
  id: string
  chatJid: string
}

export type ChatEntry = { jid: string; name: string; lastTs: number; lastBody: string }

const MAX_RECENT = 200
const MAX_CHATS = 200

const recent: Recent[] = []
const chatMap = new Map<string, ChatEntry>()

export function handleUpsert(evt: any) {
  // Only real-time notifications; skip history-sync ("append"/undefined) floods.
  if (evt?.type !== "notify") return
  for (const m of evt?.messages ?? []) {
    if (!m?.message || !m?.key) continue
    const body =
      m.message.conversation ||
      m.message.extendedTextMessage?.text ||
      m.message.imageMessage?.caption ||
      m.message.videoMessage?.caption ||
      m.message.documentMessage?.caption ||
      ""
    if (!body) continue
    const from = m.key.remoteJid ?? "unknown"
    recent.push({
      ts: Number(m.messageTimestamp ?? Math.floor(Date.now() / 1000)),
      from: m.key.participant ?? from,
      fromName: m.pushName,
      body,
      fromMe: m.key.fromMe ?? false,
      id: m.key.id ?? "",
      chatJid: from,
    })
    if (recent.length > MAX_RECENT) recent.shift()

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
