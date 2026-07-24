import { existsSync, mkdirSync, rmSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
} from "@whiskeysockets/baileys"
import QRCode from "qrcode"
import { handleUpsert } from "./messages.js"

type WASocket = ReturnType<typeof makeWASocket>

const AUTH_DIR = join(homedir(), ".config", "opencode", "whatsapp")
const QR_FILE = join(AUTH_DIR, "qr.png")
const MAX_BACKOFF_MS = 30_000

// Baileys is chatty. Keep info/debug/trace silent, but surface warn/error/fatal
// on STDERR — never stdout, which is the MCP JSON-RPC channel. This restores
// observability without corrupting the protocol stream.
const logger: any = {
  level: "silent",
  fatal: (...a: any[]) => console.error("[whatsapp:fatal]", ...a),
  error: (...a: any[]) => console.error("[whatsapp:error]", ...a),
  warn: (...a: any[]) => console.warn("[whatsapp:warn]", ...a),
  info() {},
  debug() {},
  trace() {},
  child() {
    return logger
  },
}

let sock: WASocket | null = null
let connected = false
let meJid: string | null = null
let lastError: string | null = null
let lastQr: string | null = null
let reconnectAttempts = 0
let reconnecting = false
let steppedAside = false
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

export function getSocket(): WASocket | null {
  return sock
}
export function isConnected() {
  return connected
}
export function getMyJid() {
  return meJid
}
export function getQrPath() {
  return QR_FILE
}
export function getAuthDir() {
  return AUTH_DIR
}
export function getLastError() {
  return lastError
}
// The most recent QR string emitted by Baileys, or null once linked. Powers the
// `login_qr` tool so the code can be rendered inline in the OpenCode TUI.
export function getLastQr() {
  return lastQr
}
// True when this instance deliberately gave up the connection because another
// OpenCode session / linked device took it over (see connectionReplaced below).
export function hasSteppedAside() {
  return steppedAside
}
// Exposed for downloadMediaMessage, which needs a logger and the socket's own
// updateMediaMessage (reachable via getSocket().updateMediaMessage) as its
// reuploadRequest.
export function getLogger() {
  return logger
}

function log(msg: string) {
  console.error(`[whatsapp] ${msg}`)
}

function scheduleReconnect() {
  if (reconnecting) return
  reconnecting = true
  const delay = Math.min(MAX_BACKOFF_MS, 2 ** reconnectAttempts * 1000)
  reconnectAttempts++
  log(`reconnecting in ${delay}ms (attempt ${reconnectAttempts})`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    reconnecting = false
    initConnection().catch((e) => {
      lastError = (e as Error).message
      log(`reconnect failed: ${lastError}`)
      scheduleReconnect()
    })
  }, delay)
}

/** Fire-and-forget entry point used at startup. Never rejects; failures are
 *  recorded in lastError and retried with backoff so the MCP stays available. */
export function startConnection() {
  initConnection().catch((e) => {
    lastError = (e as Error).message
    log(`initial connection failed: ${lastError}`)
    scheduleReconnect()
  })
}

/**
 * Reconnect from scratch in-process, so re-linking never needs an OpenCode
 * restart. Tears down the current socket, cancels any pending reconnect, resets
 * state, and (when `wipe`) deletes the stored session so Baileys emits a fresh QR.
 *
 * - `wipe: false` — reconnect with the existing session (reclaim a stepped-aside
 *   link, or retry after an error). No QR unless the session is already dead.
 * - `wipe: true` — delete the session first (use after a "Logged out" state, or to
 *   link a different number). A fresh QR follows a moment later; show it with login_qr.
 */
export async function forceRelink(wipe: boolean): Promise<void> {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  reconnecting = false
  reconnectAttempts = 0
  if (sock) {
    try {
      ;(sock.ev as any).removeAllListeners?.()
    } catch {}
    try {
      ;(sock as any).end?.(undefined)
    } catch {}
    sock = null
  }
  connected = false
  meJid = null
  lastQr = null
  lastError = null
  steppedAside = false
  if (wipe) {
    try {
      rmSync(AUTH_DIR, { recursive: true, force: true })
      log(`wiped session at ${AUTH_DIR}`)
    } catch (e) {
      log(`could not wipe ${AUTH_DIR}: ${(e as Error).message}`)
    }
  }
  await initConnection()
}

export async function initConnection() {
  if (!existsSync(AUTH_DIR)) mkdirSync(AUTH_DIR, { recursive: true })

  // Drop listeners from any previous socket before replacing it, so a stale
  // socket can't keep firing events into a connection we've abandoned.
  if (sock) {
    try {
      ;(sock.ev as any).removeAllListeners?.()
    } catch {}
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version } = await fetchLatestBaileysVersion()
  // makeCacheableSignalKeyStore is required — without it the signal keys aren't
  // cached and the registration handshake gets stuck at "Logging in..." on the phone.
  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    logger,
    // [client, browser, version]. The first element is what WhatsApp shows in
    // Settings > Linked Devices, so it's set to "OpenCode" to be recognizable;
    // the browser stays a real value (Chrome) so pairing behaves normally. The
    // name is baked in at pairing time — changing it only affects a fresh link.
    browser: ["OpenCode", "Chrome", "131.0.0.0"],
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
  })

  sock.ev.on("creds.update", saveCreds)
  // Attached here (not lazily in the tools layer) so it re-binds on every
  // reconnect and never misses messages that arrive before a tool is first called.
  sock.ev.on("messages.upsert", handleUpsert)

  sock.ev.on("connection.update", (u: any) => {
    const { connection, qr, lastDisconnect } = u
    if (qr) {
      // Keep the raw string in memory (for `login_qr`) as well as the PNG.
      lastQr = qr
      QRCode.toBuffer(qr, { type: "png", width: 512, margin: 2 })
        .then((png) => writeFile(QR_FILE, png))
        .then(() => log(`QR ready — run the login_qr tool, or open ${QR_FILE}`))
        .catch((e) => {
          lastError = `QR write failed: ${(e as Error).message}`
          log(lastError)
        })
    }
    if (connection === "open") {
      connected = true
      steppedAside = false
      meJid = sock?.user?.id ?? null
      lastError = null
      lastQr = null
      reconnectAttempts = 0
      log(`connected as ${meJid}`)
    }
    if (connection === "close") {
      connected = false
      meJid = null
      const code = (lastDisconnect?.error as any)?.output?.statusCode
      if (code === DisconnectReason.loggedOut) {
        // Terminal: creds are dead. Reconnecting with them would loop forever —
        // stop, and let the user re-link in-process via the `relink` tool (which
        // wipes the session and generates a fresh QR without an OpenCode restart).
        lastError = "Logged out by WhatsApp. Run the relink tool (wipe: true) to clear the stale session and get a fresh QR — no OpenCode restart needed."
        log(lastError)
        return
      }
      if (code === DisconnectReason.connectionReplaced) {
        // Another OpenCode session (or linked device) connected with the same
        // credentials and took the socket. Reconnecting here would reclaim it and
        // kick the other instance, which reclaims it back — a ping-pong that
        // WhatsApp eventually flags and that invalidates the session, forcing a new
        // QR. Step aside instead: the newest session owns the link. Restart this
        // one to reclaim it deliberately.
        steppedAside = true
        lastError =
          "Another OpenCode session or linked device took over this WhatsApp connection. " +
          "This instance stepped aside to avoid a reconnect loop (which is what used to force a re-scan). " +
          "Restart this session if you want it to reclaim the link."
        log(lastError)
        return
      }
      const reasonName = (code != null && DisconnectReason[code]) || code || "unknown"
      log(`connection closed (${reasonName}) — will reconnect`)
      scheduleReconnect()
    }
  })
}
