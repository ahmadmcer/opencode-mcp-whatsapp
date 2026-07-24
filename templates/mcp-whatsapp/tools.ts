import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { readFile, stat } from "node:fs/promises"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join, delimiter } from "node:path"
import { getSocket, isConnected, getMyJid, getQrPath, getAuthDir, getLastError } from "./store.js"
import { getRecent, getChats } from "./messages.js"
import { toJid, filenameOf, resolveWithinRoots, isInside } from "./utils.js"
import { isRecipientAllowed, allowedRecipients, sendLimiter, rateLimitConfig } from "./policy.js"

// Directories `send_file` is allowed to read from. Defaults to the user's
// Downloads and a dedicated outbox; override with WHATSAPP_SEND_ROOT (OS-separated
// list). This sandbox is what prevents the tool from exfiltrating arbitrary files.
const SEND_ROOTS = (
  process.env.WHATSAPP_SEND_ROOT
    ? process.env.WHATSAPP_SEND_ROOT.split(delimiter)
    : [join(homedir(), "Downloads"), join(homedir(), ".config", "opencode", "whatsapp-outbox")]
)
  .map((s) => s.trim())
  .filter(Boolean)

const IMAGE_EXT = ["jpg", "jpeg", "png", "gif", "webp"]
const VIDEO_EXT = ["mp4", "3gp", "mov", "mkv"]

function errText(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] }
}

function notConnected() {
  const last = getLastError() ? ` Last error: ${getLastError()}` : ""
  return errText(
    `Not connected. If the QR at ${getQrPath()} is fresh, scan it in WhatsApp > Settings > Linked Devices. ` +
      `If linking keeps failing, WhatsApp may be rate-limiting your account — wait 1+ hour.${last}`,
  )
}

// Returns an error result if the recipient is off the allowlist, else null.
function recipientDenied(jid: string) {
  if (isRecipientAllowed(jid)) return null
  return errText(`Recipient ${jid} is not in the allowlist (WHATSAPP_ALLOWED_RECIPIENTS). Refusing to send.`)
}

// Consumes a rate-limit token; returns an error result if the limit is hit, else null.
// Call this immediately before the actual sendMessage so tokens track real sends.
function rateLimited() {
  const rl = sendLimiter.check()
  if (rl.ok) return null
  const { max, windowMs } = rateLimitConfig()
  return errText(
    `Rate limit reached (${max} sends / ${Math.round(windowMs / 1000)}s). ` +
      `Try again in ${Math.ceil(rl.retryAfterMs / 1000)}s.`,
  )
}

export function registerTools(server: McpServer) {
  server.registerTool(
    "send",
    {
      title: "Send WhatsApp text message",
      description:
        "Send a WhatsApp text message. `to` is a phone number (+xxx) or JID. Connection must be open. Subject to the recipient allowlist and send rate limit (see `status`).",
      inputSchema: {
        to: z.string(),
        message: z.string().min(1).max(4096),
      },
    },
    async ({ to, message }) => {
      const s = getSocket()
      if (!s || !isConnected()) return notConnected()
      let jid: string
      try {
        jid = toJid(to)
      } catch (e) {
        return errText(`Error: ${(e as Error).message}`)
      }
      const denied = recipientDenied(jid)
      if (denied) return denied
      const limited = rateLimited()
      if (limited) return limited
      try {
        const sent = await s.sendMessage(jid, { text: message })
        return { content: [{ type: "text", text: `Sent to ${jid} (id: ${sent?.key?.id ?? "?"})` }] }
      } catch (e) {
        return errText(`Send failed: ${(e as Error).message}`)
      }
    },
  )

  server.registerTool(
    "send_file",
    {
      title: "Send file via WhatsApp",
      description:
        "Send a local file via WhatsApp (image, video, document). The file must live under an allowed send directory, and is subject to the recipient allowlist and send rate limit (see the `status` tool). Connection must be open.",
      inputSchema: {
        to: z.string(),
        filePath: z.string(),
      },
    },
    async ({ to, filePath }) => {
      const s = getSocket()
      if (!s || !isConnected()) return notConnected()

      let safePath: string
      try {
        safePath = resolveWithinRoots(SEND_ROOTS, filePath)
        if (isInside(getAuthDir(), safePath)) {
          throw new Error("Refusing to send files from the WhatsApp auth directory.")
        }
      } catch (e) {
        return errText((e as Error).message)
      }

      let jid: string
      try {
        jid = toJid(to)
      } catch (e) {
        return errText(`Error: ${(e as Error).message}`)
      }
      const denied = recipientDenied(jid)
      if (denied) return denied

      let buffer: Buffer
      try {
        buffer = await readFile(safePath)
      } catch (e) {
        return errText(`Cannot read file: ${(e as Error).message}`)
      }

      const ext = filenameOf(safePath).toLowerCase().split(".").pop() ?? ""
      const content = IMAGE_EXT.includes(ext)
        ? { image: buffer }
        : VIDEO_EXT.includes(ext)
          ? { video: buffer }
          : { document: buffer, fileName: filenameOf(safePath) }

      const limited = rateLimited()
      if (limited) return limited
      try {
        const sent = await s.sendMessage(jid, content as any)
        return { content: [{ type: "text", text: `Sent ${safePath} to ${jid} (id: ${sent?.key?.id ?? "?"})` }] }
      } catch (e) {
        return errText(`Send failed: ${(e as Error).message}`)
      }
    },
  )

  server.registerTool(
    "status",
    {
      title: "Connection status",
      description: "Show the current WhatsApp connection status. Use this to check if the link succeeded.",
      inputSchema: {},
    },
    async () => {
      const qrStat = existsSync(getQrPath())
        ? await stat(getQrPath())
            .then((s) => `${s.mtime.toISOString()} (${s.size} bytes)`)
            .catch(() => "exists but unreadable")
        : "not present"
      const lines = [
        `Connected: ${isConnected() ? "yes" : "no"}`,
        `My JID:   ${getMyJid() ?? "(not connected)"}`,
        `Auth dir: ${getAuthDir()}`,
        `QR file:  ${getQrPath()} — ${qrStat}`,
        `Send roots: ${SEND_ROOTS.join(", ")}`,
        `Allowed recipients: ${allowedRecipients()?.join(", ") ?? "all (WHATSAPP_ALLOWED_RECIPIENTS unset)"}`,
        `Send rate limit: ${rateLimitConfig().max} per ${Math.round(rateLimitConfig().windowMs / 1000)}s`,
      ]
      if (getLastError()) lines.push(`Last error: ${getLastError()}`)
      if (!isConnected()) {
        lines.push("")
        lines.push("To link: open the QR file above and scan with WhatsApp > Settings > Linked Devices.")
        lines.push(
          "If the link fails with 'Try again later', your WhatsApp account is rate-limited at the server. The MCP cannot bypass that — wait 1+ hour and try again.",
        )
      }
      return { content: [{ type: "text", text: lines.join("\n") }] }
    },
  )

  server.registerTool(
    "recent_messages",
    {
      title: "Recent messages",
      description: "List recent inbound WhatsApp messages observed by the MCP (in-memory only; lost on restart).",
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ limit = 30 }) => {
      const items = getRecent(limit)
      if (items.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No messages yet. The MCP only sees messages received after it connected — for full history, ask the user to send you a message first.",
            },
          ],
        }
      }
      return {
        content: [
          {
            type: "text",
            text: items
              .map((m, i) => `${i + 1}. [${new Date(m.ts * 1000).toISOString()}] ${m.fromName ?? m.from} (${m.chatJid}): ${m.body}`)
              .join("\n"),
          },
        ],
      }
    },
  )

  server.registerTool(
    "list_chats",
    {
      title: "List chats",
      description:
        "List chats observed by the MCP (from recent message activity). Limited — only chats that sent a message while this MCP was running.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ limit = 30 }) => {
      const items = getChats(limit)
      if (items.length === 0) {
        return {
          content: [
            { type: "text", text: "No chats observed yet. The MCP only sees chats that have sent a message since it connected." },
          ],
        }
      }
      return {
        content: [
          { type: "text", text: items.map((c, i) => `${i + 1}. ${c.name} (${c.jid}) — last: ${c.lastBody}`).join("\n") },
        ],
      }
    },
  )
}
