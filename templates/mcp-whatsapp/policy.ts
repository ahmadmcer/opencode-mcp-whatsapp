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

export function rateLimitConfig() {
  return { max: RATE_MAX, windowMs: RATE_WINDOW_MS }
}

export const sendLimiter = createRateLimiter(RATE_MAX, RATE_WINDOW_MS)
