// Outbound send policy: a recipient allowlist and a rate limiter. Both guard the
// two send tools so an agent loop (or a prompt-injected instruction) can't blast
// messages to arbitrary numbers or spam a recipient into a WhatsApp ban.
//
// The pure helpers (parseAllowList / isAllowed / createRateLimiter) hold no env
// state so they're unit-testable; the module-level singletons below bind them to
// configuration read once from the environment.

import { toJid } from "./utils.js"

// --- Recipient allowlist -------------------------------------------------

/**
 * Parse WHATSAPP_ALLOWED_RECIPIENTS (comma / semicolon / newline separated) into
 * normalized JIDs. Returns null when unset/empty, meaning "no restriction".
 */
export function parseAllowList(raw: string | undefined): string[] | null {
  if (!raw) return null
  const items = raw
    .split(/[,\n;]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((e) => {
      try {
        return toJid(e)
      } catch {
        return e // keep unrecognized entries verbatim rather than dropping them
      }
    })
  return items.length ? items : null
}

/** Null list = allow everyone. Otherwise the jid must be listed. */
export function isAllowed(list: string[] | null, jid: string): boolean {
  if (!list || list.length === 0) return true
  return list.includes(jid)
}

const allowList = parseAllowList(process.env.WHATSAPP_ALLOWED_RECIPIENTS)

export function allowedRecipients(): string[] | null {
  return allowList
}
export function isRecipientAllowed(jid: string): boolean {
  return isAllowed(allowList, jid)
}

// --- Send rate limiter ---------------------------------------------------

export type RateResult = { ok: true } | { ok: false; retryAfterMs: number }

/** Sliding-window limiter: at most `max` sends per `windowMs`. `now` is injectable
 *  so the behavior is deterministic under test. */
export function createRateLimiter(max: number, windowMs: number) {
  const times: number[] = []
  return {
    check(now: number = Date.now()): RateResult {
      while (times.length && now - times[0] >= windowMs) times.shift()
      if (times.length >= max) return { ok: false, retryAfterMs: windowMs - (now - times[0]) }
      times.push(now)
      return { ok: true }
    },
  }
}

function intEnv(name: string, def: number): number {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : def
}

const RATE_MAX = intEnv("WHATSAPP_SEND_MAX", 10)
const RATE_WINDOW_MS = intEnv("WHATSAPP_SEND_WINDOW_MS", 60_000)
// Per-recipient cap on top of the global rate limit. Defends against agent
// loops that reply to the same person repeatedly.
const RECIPIENT_MAX = intEnv("WHATSAPP_SEND_MAX_PER_RECIPIENT", 3)
const RECIPIENT_WINDOW_MS = intEnv("WHATSAPP_SEND_RECIPIENT_WINDOW_MS", 60_000)
// Minimum gap between outbound sends, in ms. Smooths burst-then-wait that
// WhatsApp's anti-spam heuristic flags. 1000ms matches whatsapp-persona-bot
// defaults; set 0 to disable. Initialized to "now" so the very first send is
// not artificially slowed.
const PACER_DELAY_MS = intEnv("WHATSAPP_PACER_DELAY_MS", 1000)

export function rateLimitConfig() {
  return { max: RATE_MAX, windowMs: RATE_WINDOW_MS }
}

export function pacerConfig() {
  return { delayMs: PACER_DELAY_MS }
}

export const sendLimiter = createRateLimiter(RATE_MAX, RATE_WINDOW_MS)

// --- Per-recipient rate limiter ------------------------------------------
//
// A single global limiter is not enough: an agent loop that gets stuck
// replying to one person could spend the whole window's budget on them and
// still look fine. A per-jid cap catches that pattern. Different jids do not
// affect each other, and the global limiter still applies on top.
//
// Limiters are created lazily so a session that never chats with a particular
// jid costs nothing. A bounded LRU map evicts oldest when we hit
// RECIPIENT_LIMITS_MAX entries, so memory stays predictable for long-running
// agents that touch many contacts.
const RECIPIENT_LIMITS_MAX = 500

const recipientLimiters = new Map<string, ReturnType<typeof createRateLimiter>>()

export function getRecipientLimiter(jid: string): ReturnType<typeof createRateLimiter> {
  let lim = recipientLimiters.get(jid)
  if (!lim) {
    lim = createRateLimiter(RECIPIENT_MAX, RECIPIENT_WINDOW_MS)
    recipientLimiters.set(jid, lim)
    if (recipientLimiters.size > RECIPIENT_LIMITS_MAX) {
      // Map iteration order = insertion order; delete the oldest entry.
      const oldest = recipientLimiters.keys().next().value
      if (oldest !== undefined) recipientLimiters.delete(oldest)
    }
  }
  return lim
}

/** Test helper: forget all per-recipient state. */
export function resetRecipientLimiters() {
  recipientLimiters.clear()
}

export type RecipientRateResult = { ok: true } | { ok: false; retryAfterMs: number }

/** Pure check, no side effects — lets tests assert deterministic behaviour. */
export function checkRecipientLimit(jid: string, now: number = Date.now()): RecipientRateResult {
  const lim = getRecipientLimiter(jid)
  return lim.check(now) as RecipientRateResult
}

export function recipientLimitConfig() {
  return { max: RECIPIENT_MAX, windowMs: RECIPIENT_WINDOW_MS }
}

// --- Send pacer ----------------------------------------------------------
//
// Sleeps before each call so consecutive sends are at least `delayMs` apart.
// WhatsApp flags accounts that burst then idle as automated, so we smooth the
// stream. Unlike the rate limiter, this is purely advisory — it never blocks,
// it just spaces calls in time. `createPacer` is pure (no env reads) so it's
// unit-testable; the singleton below binds it to env config.
export type Pacer = {
  pace<T>(fn: () => Promise<T>): Promise<T>
}

export function createPacer(delayMs: number): Pacer {
  let lastCall = Date.now()
  return {
    async pace<T>(fn: () => Promise<T>): Promise<T> {
      const elapsed = Date.now() - lastCall
      const delay = Math.max(0, delayMs - elapsed)
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
      lastCall = Date.now()
      return fn()
    },
  }
}

export const sendPacer = createPacer(PACER_DELAY_MS)
