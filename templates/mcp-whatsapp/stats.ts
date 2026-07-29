// In-process runtime counters that are cheap to update on every event and
// cheap to render in `connection_state`. Inspired by persona-bot's
// `awareness/self.ts:getBotHealthContext` and `/status` command.

import { logger } from "./logger.js"

export type DeliveryBuckets = {
  pending: number
  serverAck: number
  delivered: number
  read: number
  played: number
  error: number
}

const MAX_STATUS_TRACK = 500

const counters = {
  startedAt: Date.now(),
  messagesSent: 0, // outgoing count tracked via sendGuards
  buckets: {
    pending: 0,
    serverAck: 0,
    delivered: 0,
    read: 0,
    played: 0,
    error: 0,
  } as DeliveryBuckets,
  byRecipient: new Map<string, number>(), // jid -> sends
  lastErrorAt: 0,
}

let statsLogged = false

/**
 * Increment the per-recipient counter on a successful send. Called from the
 * send tools right after the message goes out. Cheap (Map.set is O(1)).
 */
export function recordSend(jid: string) {
  counters.messagesSent++
  counters.byRecipient.set(jid, (counters.byRecipient.get(jid) ?? 0) + 1)
}

/** Reset everything (used by wipe_session in case we ever want to). */
export function resetStats() {
  counters.startedAt = Date.now()
  counters.messagesSent = 0
  counters.buckets = { pending: 0, serverAck: 0, delivered: 0, read: 0, played: 0, error: 0 }
  counters.byRecipient.clear()
  counters.lastErrorAt = 0
  logger.debug("stats reset")
}

/**
 * Increment a delivery-status bucket. Called from `handleMessageUpdate` for
 * the highest status we've seen so far per message id — we promote a single
 * message through the buckets rather than incrementing several.
 *
 * Without a "promotion" approach we'd over-count (e.g. one message counts
 * toward PENDING, then SERVER_ACK, then DELIVERED — three buckets for one
 * truth). Instead we track "highest seen per id" and move counts when it
 * changes.
 */
const highestById = new Map<string, number>()

export function recordDeliveryTransition(messageId: string, newCode: number) {
  const prev = highestById.get(messageId)
  // Promote: only count the *new* bucket if this is a higher-priority status
  // than what we've seen for this message. Otherwise it's a stale or
  // redundant update we already accounted for.
  if (prev !== undefined && prev >= newCode) return
  highestById.set(messageId, newCode)
  if (prev !== undefined) {
    decrementBucket(prev)
  }
  incrementBucket(newCode)
  if (newCode === 0) counters.lastErrorAt = Date.now()
  // Keep the maps bounded; same eviction policy as statusById in messages.ts
  if (highestById.size > MAX_STATUS_TRACK) {
    const oldest = highestById.keys().next().value
    if (oldest !== undefined) highestById.delete(oldest)
  }
}

function incrementBucket(code: number) {
  switch (code) {
    case 0: counters.buckets.error++; break
    case 1: counters.buckets.pending++; break
    case 2: counters.buckets.serverAck++; break
    case 3: counters.buckets.delivered++; break
    case 4: counters.buckets.read++; break
    case 5: counters.buckets.played++; break
  }
}

function decrementBucket(code: number) {
  switch (code) {
    case 0: counters.buckets.error = Math.max(0, counters.buckets.error - 1); break
    case 1: counters.buckets.pending = Math.max(0, counters.buckets.pending - 1); break
    case 2: counters.buckets.serverAck = Math.max(0, counters.buckets.serverAck - 1); break
    case 3: counters.buckets.delivered = Math.max(0, counters.buckets.delivered - 1); break
    case 4: counters.buckets.read = Math.max(0, counters.buckets.read - 1); break
    case 5: counters.buckets.played = Math.max(0, counters.buckets.played - 1); break
  }
}

export interface Stats {
  uptimeMs: number
  uptimeFormatted: string
  rssMb: number
  messagesSent: number
  buckets: DeliveryBuckets
  deliveryRate: number // delivered+read+played / messagesSent
  topRecipients: Array<{ jid: string; count: number }>
  lastErrorAt: number | null
  lastErrorAgeMs: number | null
}

export function getStats(): Stats {
  const rss = process.memoryUsage().rss >> 20
  const b = counters.buckets
  const success = b.delivered + b.read + b.played
  const rate = counters.messagesSent > 0 ? (success / counters.messagesSent) * 100 : 0

  const top = [...counters.byRecipient.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([jid, count]) => ({ jid, count }))

  return {
    uptimeMs: Date.now() - counters.startedAt,
    uptimeFormatted: formatUptime(Date.now() - counters.startedAt),
    rssMb: rss,
    messagesSent: counters.messagesSent,
    buckets: { ...b },
    deliveryRate: rate,
    topRecipients: top,
    lastErrorAt: counters.lastErrorAt || null,
    lastErrorAgeMs: counters.lastErrorAt ? Date.now() - counters.lastErrorAt : null,
  }
}

export function formatUptime(ms: number): string {
  const sec = Math.floor(ms / 1000)
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

/** Quick no-op guard so we only log once at module load. */
function markLogged() {
  if (!statsLogged) {
    statsLogged = true
    logger.debug("stats module loaded")
  }
}
markLogged()