// Baileys disconnect-status-code → human-readable diagnostic table.
// `statusCode` from `lastDisconnect?.error?.output?.statusCode` is the Boom
// HTTP-like code that Baileys uses to signal why a session dropped. The bare
// number is opaque; this table is the only place we map them to actionable
// text. Mirrors persona-bot's `connection.update` warning pattern but in a
// dedicated, testable module.

import { DisconnectReason } from "@whiskeysockets/baileys"

export interface Diagnostic {
  /** Short reason slug. */
  reason: string
  /** One-line description for logs / connection_state. */
  description: string
  /** Longer remediation hint, optional. */
  hint: string
  /** True if the session should auto-reconnect. False = user action needed. */
  recoverable: boolean
}

const TABLE: Record<number, Diagnostic> = {
  // Codes used by Baileys. The numbers come from DisconnectReason enum and
  // are stable across recent Baileys versions. We map by integer so callers
  // don't need to import the enum.
  [DisconnectReason.loggedOut]: {
    reason: "logged_out",
    description: "Logged out — the session has been terminated on the phone.",
    hint:
      "Run relink with wipe: true to clear the stale session and generate a fresh QR. The phone may also have explicitly logged out this device.",
    recoverable: false,
  },
  [DisconnectReason.badSession]: {
    reason: "bad_session",
    description: "Session is corrupted or unreadable.",
    hint: "Run relink with wipe: true to rebuild credentials from scratch.",
    recoverable: false,
  },
  [DisconnectReason.connectionClosed]: {
    reason: "connection_closed",
    description: "WebSocket closed cleanly.",
    hint: "Will auto-reconnect. If it keeps happening, check network stability.",
    recoverable: true,
  },
  [DisconnectReason.connectionLost]: {
    reason: "connection_lost",
    description: "WebSocket dropped without a clean close.",
    hint: "Transient network blip; the auto-reconnect logic will retry.",
    recoverable: true,
  },
  [DisconnectReason.timedOut]: {
    reason: "timed_out",
    description: "Handshake or heartbeat timed out.",
    hint: "Network too slow or the WhatsApp server is having issues. Will auto-reconnect.",
    recoverable: true,
  },
  [DisconnectReason.connectionReplaced]: {
    reason: "connection_replaced",
    description: "Another session took over this device id.",
    hint:
      "A different linked device connected with the same identity. Either let it stay (this MCP will step aside) or relink if the takeover was unintentional.",
    recoverable: false,
  },
  [DisconnectReason.multideviceMismatch]: {
    reason: "multidevice_mismatch",
    description: "Server says the device keys don't match multi-device expectations.",
    hint: "Re-link required: run relink with wipe: true.",
    recoverable: false,
  },
  [DisconnectReason.notFound]: {
    reason: "not_found",
    description: "Server returned 404 for this session.",
    hint: "Session expired or was removed server-side. Run relink with wipe: true.",
    recoverable: false,
  },
  [DisconnectReason.restartRequired]: {
    reason: "restart_required",
    description: "WhatsApp requested a protocol-level restart.",
    hint: "Auto-reconnect should handle this. If persistent, restart the MCP process.",
    recoverable: true,
  },
  [DisconnectReason.timedOut]: {
    reason: "timed_out",
    description: "Handshake or heartbeat timed out.",
    hint: "Network too slow or the WhatsApp server is having issues. Will auto-reconnect.",
    recoverable: true,
  },
  [DisconnectReason.forbidden]: {
    reason: "forbidden",
    description: "Server returned 403 — account/IP banned or blocked.",
    hint:
      "This account or IP may be banned by WhatsApp. Send_message will return ERROR 0 from the server until the ban lifts (often hours, sometimes never).",
    recoverable: false,
  },
  [DisconnectReason.unavailableService]: {
    reason: "service_unavailable",
    description: "WhatsApp servers are temporarily unreachable.",
    hint: "Wait a few minutes; auto-reconnect will keep trying.",
    recoverable: true,
  },
}

const FALLBACK: Diagnostic = {
  reason: "unknown",
  description: "Unrecognised disconnect reason code.",
  hint: "Look up the code in Baileys source or share it in a bug report. Will auto-reconnect by default.",
  recoverable: true,
}

export function getDiagnostic(code: number | undefined | null): Diagnostic {
  if (code == null) return FALLBACK
  return TABLE[code] ?? { ...FALLBACK, description: `Unrecognised disconnect reason (code ${code})` }
}

/** One-line string suitable for logs. */
export function describeCode(code: number | undefined | null): string {
  const d = getDiagnostic(code)
  return `${d.reason} (${code ?? "?"}) — ${d.description}`
}