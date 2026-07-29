// Translate low-level Baileys / Node errors thrown by sendMessage into
// messages the agent can act on. Without this every failure shows up as a
// generic "Send failed: <stack>" which is hard for the agent to interpret.
//
// Best-effort, never throws. Anything we don't recognise falls through to the
// original error message verbatim.

export interface DecodedError {
  /** Original error message (kept so the user/agent sees the full text). */
  raw: string
  /** Short reason slug. */
  reason: string
  /** A more helpful sentence than the raw exception. */
  message: string
  /** Optional remediation hint. */
  hint: string | null
}

/**
 * Pattern table. Each entry matches substrings of the raw error message —
 * we deliberately use `includes` rather than `instanceof` because Baileys
 * errors often come back wrapped in Boom or plain Error and the message is
 * the most stable part.
 */
const PATTERNS: Array<{ test: RegExp; reason: string; message: string; hint: string | null }> = [
  {
    test: /socket hang up|ECONNRESET|ETIMEDOUT|EPIPE|ECONNREFUSED/i,
    reason: "network_drop",
    message: "Connection dropped while sending.",
    hint: "Check connection_state. If disconnected, the MCP is auto-reconnecting — retry the send once it's back.",
  },
  {
    test: /Stream closed|stream is not writable|WebSocket is not open/i,
    reason: "stream_closed",
    message: "The WhatsApp stream is not open.",
    hint: "Wait for connection_state to show Connected: yes, then retry.",
  },
  {
    test: /No matching session|No session|no keys|No SenderKeyRecord/i,
    reason: "no_session",
    message: "No Signal-protocol session for this recipient.",
    hint: "The recipient needs an open session with this account. They may need to message you first.",
  },
  {
    test: /not authorized|Forbidden|403/i,
    reason: "forbidden",
    message: "Server returned Forbidden — this account may be restricted.",
    hint: "Stop sending for 1+ hour. WhatsApp sometimes throttles automated sends to flagged accounts.",
  },
  {
    test: /rate.?limit|429|too many/i,
    reason: "rate_limit",
    message: "Rate-limited by WhatsApp server.",
    hint: "Slow down outbound sends — bump WHATSAPP_PACER_DELAY_MS or lower WHATSAPP_SEND_MAX.",
  },
  {
    test: /recipient.*not.*found|invalid.*jid|badjid|invalid.*number/i,
    reason: "invalid_recipient",
    message: "The recipient JID/number looks invalid.",
    hint: "Verify the phone number with the on_whatsapp tool before sending.",
  },
  {
    test: /message.*too.*large|payload.*too.*big|413/i,
    reason: "payload_too_large",
    message: "The message payload exceeds WhatsApp's limits.",
    hint: "Trim the text or split into chunks with format_text, then send in pieces.",
  },
  {
    test: /timed?out.*waiting/i,
    reason: "timeout",
    message: "Timed out waiting for the WhatsApp server to acknowledge.",
    hint: "Network or server-side latency. The message may or may not have been sent — check message_status for the same id.",
  },
]

const FALLBACK: DecodedError = {
  raw: "",
  reason: "unknown",
  message: "Send failed.",
  hint: null,
}

export function decodeSendError(err: unknown, context?: { jid?: string }): DecodedError {
  const raw = err instanceof Error ? err.message : String(err ?? "")
  for (const p of PATTERNS) {
    if (p.test.test(raw)) {
      return {
        raw,
        reason: p.reason,
        message: context?.jid ? `${p.message} (to ${context.jid})` : p.message,
        hint: p.hint,
      }
    }
  }
  return { ...FALLBACK, raw, message: raw || "Send failed." }
}

/** Format a decoded error as a one-or-two-line block for an MCP tool response. */
export function formatDecodedError(decoded: DecodedError): string {
  const lines = [`Send failed: ${decoded.message}`]
  if (decoded.hint) lines.push(`Hint: ${decoded.hint}`)
  lines.push(`(raw: ${decoded.raw})`)
  return lines.join("\n")
}