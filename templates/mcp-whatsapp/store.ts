import { existsSync, mkdirSync } from "node:fs"
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
let reconnectAttempts = 0
let reconnecting = false

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
  setTimeout(() => {
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
    browser: ["Windows", "Chrome", "131.0.0.0"],
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
      QRCode.toBuffer(qr, { type: "png", width: 512, margin: 2 })
        .then((png) => writeFile(QR_FILE, png))
        .then(() => log(`QR written to ${QR_FILE} — scan it in WhatsApp > Linked Devices`))
        .catch((e) => {
          lastError = `QR write failed: ${(e as Error).message}`
          log(lastError)
        })
    }
    if (connection === "open") {
      connected = true
      meJid = sock?.user?.id ?? null
      lastError = null
      reconnectAttempts = 0
      log(`connected as ${meJid}`)
    }
    if (connection === "close") {
      connected = false
      meJid = null
      const code = (lastDisconnect?.error as any)?.output?.statusCode
      if (code === DisconnectReason.loggedOut) {
        // Terminal: creds are dead. Reconnecting would loop forever.
        lastError = `Logged out. Delete ${AUTH_DIR} and re-link by scanning a fresh QR.`
        log(lastError)
        return
      }
      const reasonName = (code != null && DisconnectReason[code]) || code || "unknown"
      log(`connection closed (${reasonName}) — will reconnect`)
      scheduleReconnect()
    }
  })
}
