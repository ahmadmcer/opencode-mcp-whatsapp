import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { downloadMediaMessage } from "@whiskeysockets/baileys"
import qrcodeTerminal from "qrcode-terminal"
import { readFile, writeFile, stat } from "node:fs/promises"
import { existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, delimiter } from "node:path"
import {
  getSocket,
  isConnected,
  getMyJid,
  getQrPath,
  getAuthDir,
  getLastError,
  getLogger,
  getLastQr,
} from "./store.js"
import { getRecent, getChats, getMessageById, recordOutgoing, type ResolvedMessage } from "./messages.js"
import { toJid, filenameOf, resolveWithinRoots, isInside, buildVcard } from "./utils.js"
import { isRecipientAllowed, allowedRecipients, sendLimiter, rateLimitConfig } from "./policy.js"

// Directories `send_media` may read from and `download_media_message` may write to.
// Defaults to the user's Downloads and a dedicated outbox; override with
// WHATSAPP_SEND_ROOT (OS-separated list). This sandbox prevents the tools from
// reading or writing arbitrary files.
const SEND_ROOTS = (
  process.env.WHATSAPP_SEND_ROOT
    ? process.env.WHATSAPP_SEND_ROOT.split(delimiter)
    : [join(homedir(), "Downloads"), join(homedir(), ".config", "opencode", "whatsapp-outbox")]
)
  .map((s) => s.trim())
  .filter(Boolean)

const IMAGE_EXT = ["jpg", "jpeg", "png", "gif", "webp"]
const VIDEO_EXT = ["mp4", "3gp", "mov", "mkv"]

// Default extension per media type, used when generating a download filename.
const MEDIA_EXT: Record<string, string> = {
  image: "jpg",
  video: "mp4",
  audio: "ogg",
  sticker: "webp",
  document: "bin",
}

function errText(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] }
}

function okText(text: string) {
  return { content: [{ type: "text" as const, text }] }
}

function notConnected() {
  const last = getLastError() ? ` Last error: ${getLastError()}` : ""
  const qrHint = getLastQr() ? " A QR is pending — run the login_qr tool to display it here and scan it." : ""
  return errText(
    `Not connected.${qrHint} Otherwise the QR at ${getQrPath()} can be scanned in WhatsApp > Settings > Linked Devices. ` +
      `If linking keeps failing, WhatsApp may be rate-limiting your account — wait 1+ hour.${last}`,
  )
}

// Render a QR string as compact terminal ASCII so it can be scanned straight from
// the OpenCode TUI. qrcode-terminal's callback fires synchronously, wrapped here
// as a promise for a clean await.
function renderQrAscii(qr: string): Promise<string> {
  return new Promise((resolve) => {
    ;(qrcodeTerminal as any).generate(qr, { small: true }, (ascii: string) => resolve(ascii))
  })
}

// Returns an error result if the recipient is off the allowlist, else null.
function recipientDenied(jid: string) {
  if (isRecipientAllowed(jid)) return null
  return errText(`Recipient ${jid} is not in the allowlist (WHATSAPP_ALLOWED_RECIPIENTS). Refusing to send.`)
}

// Consumes a rate-limit token; returns an error result if the limit is hit, else null.
// Call immediately before the actual sendMessage so tokens track real sends.
function rateLimited() {
  const rl = sendLimiter.check()
  if (rl.ok) return null
  const { max, windowMs } = rateLimitConfig()
  return errText(
    `Rate limit reached (${max} sends / ${Math.round(windowMs / 1000)}s). ` +
      `Try again in ${Math.ceil(rl.retryAfterMs / 1000)}s.`,
  )
}

// Full guard for outbound, message-producing tools: allowlist then rate limit.
// Returns an error result to short-circuit on, or null to proceed.
function sendGuard(jid: string) {
  return recipientDenied(jid) ?? rateLimited()
}

// Resolve an agent-supplied message id to its stored key/raw message, or an error
// result telling it to list messages first. Returns a discriminated tuple.
function resolveMsg(messageId: string): { msg: ResolvedMessage } | { err: ReturnType<typeof errText> } {
  const msg = getMessageById(messageId)
  if (!msg) {
    return {
      err: errText(
        `Unknown message id "${messageId}". Call messages_upsert to list recent messages (with ids) first — ` +
          `only messages seen since this server connected can be referenced.`,
      ),
    }
  }
  return { msg }
}

export function registerTools(server: McpServer) {
  // --- send_message (was `send`) ------------------------------------------
  server.registerTool(
    "send_message",
    {
      title: "Send WhatsApp text message",
      description:
        "Send a WhatsApp text message. `to` is a phone number (+xxx) or JID. Optionally reply to a prior message via `quoted_message_id` (from messages_upsert). Subject to the recipient allowlist and send rate limit (see connection_state).",
      inputSchema: {
        to: z.string(),
        message: z.string().min(1).max(4096),
        quoted_message_id: z.string().optional(),
      },
    },
    async ({ to, message, quoted_message_id }) => {
      const s = getSocket()
      if (!s || !isConnected()) return notConnected()
      let jid: string
      try {
        jid = toJid(to)
      } catch (e) {
        return errText(`Error: ${(e as Error).message}`)
      }
      let quoted: any
      if (quoted_message_id) {
        const r = resolveMsg(quoted_message_id)
        if ("err" in r) return r.err
        quoted = r.msg.raw
      }
      const guard = sendGuard(jid)
      if (guard) return guard
      try {
        const sent = await s.sendMessage(jid, { text: message }, quoted ? { quoted } : undefined)
        recordOutgoing(sent, message)
        return okText(`Sent to ${jid} (id: ${sent?.key?.id ?? "?"})`)
      } catch (e) {
        return errText(`Send failed: ${(e as Error).message}`)
      }
    },
  )

  // --- send_media (was `send_file`) ---------------------------------------
  server.registerTool(
    "send_media",
    {
      title: "Send media/file via WhatsApp",
      description:
        "Send a local file via WhatsApp (image, video, document). The file must live under an allowed send directory. Optionally reply via `quoted_message_id`. Subject to the recipient allowlist and send rate limit. Connection must be open.",
      inputSchema: {
        to: z.string(),
        filePath: z.string(),
        quoted_message_id: z.string().optional(),
      },
    },
    async ({ to, filePath, quoted_message_id }) => {
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

      let quoted: any
      if (quoted_message_id) {
        const r = resolveMsg(quoted_message_id)
        if ("err" in r) return r.err
        quoted = r.msg.raw
      }

      let buffer: Buffer
      try {
        buffer = await readFile(safePath)
      } catch (e) {
        return errText(`Cannot read file: ${(e as Error).message}`)
      }

      const ext = filenameOf(safePath).toLowerCase().split(".").pop() ?? ""
      const name = filenameOf(safePath)
      const mediaType = IMAGE_EXT.includes(ext) ? "image" : VIDEO_EXT.includes(ext) ? "video" : "document"
      const content =
        mediaType === "image"
          ? { image: buffer }
          : mediaType === "video"
            ? { video: buffer }
            : { document: buffer, fileName: name }

      const guard = sendGuard(jid)
      if (guard) return guard
      try {
        const sent = await s.sendMessage(jid, content as any, quoted ? { quoted } : undefined)
        recordOutgoing(sent, `[${mediaType}] ${name}`, mediaType)
        return okText(`Sent ${safePath} to ${jid} (id: ${sent?.key?.id ?? "?"})`)
      } catch (e) {
        return errText(`Send failed: ${(e as Error).message}`)
      }
    },
  )

  // --- send_reaction ------------------------------------------------------
  server.registerTool(
    "send_reaction",
    {
      title: "React to a message",
      description:
        "React to a prior message with an emoji. `message_id` comes from messages_upsert. Pass an empty `emoji` to remove your reaction. Subject to the recipient allowlist and send rate limit.",
      inputSchema: {
        message_id: z.string(),
        emoji: z.string().max(8),
      },
    },
    async ({ message_id, emoji }) => {
      const s = getSocket()
      if (!s || !isConnected()) return notConnected()
      const r = resolveMsg(message_id)
      if ("err" in r) return r.err
      const guard = sendGuard(r.msg.chatJid)
      if (guard) return guard
      try {
        await s.sendMessage(r.msg.chatJid, { react: { text: emoji, key: r.msg.key } })
        return okText(emoji ? `Reacted ${emoji} to ${message_id}` : `Removed reaction from ${message_id}`)
      } catch (e) {
        return errText(`Reaction failed: ${(e as Error).message}`)
      }
    },
  )

  // --- edit_message -------------------------------------------------------
  server.registerTool(
    "edit_message",
    {
      title: "Edit a sent message",
      description:
        "Edit the text of a message you sent. `message_id` comes from messages_upsert and must be one of your own messages. Subject to the allowlist and send rate limit.",
      inputSchema: {
        message_id: z.string(),
        new_text: z.string().min(1).max(4096),
      },
    },
    async ({ message_id, new_text }) => {
      const s = getSocket()
      if (!s || !isConnected()) return notConnected()
      const r = resolveMsg(message_id)
      if ("err" in r) return r.err
      if (!r.msg.key.fromMe) return errText(`Can only edit your own messages; ${message_id} was not sent by you.`)
      const guard = sendGuard(r.msg.chatJid)
      if (guard) return guard
      try {
        await s.sendMessage(r.msg.chatJid, { text: new_text, edit: r.msg.key } as any)
        return okText(`Edited ${message_id}`)
      } catch (e) {
        return errText(`Edit failed: ${(e as Error).message}`)
      }
    },
  )

  // --- delete_message -----------------------------------------------------
  server.registerTool(
    "delete_message",
    {
      title: "Delete/revoke a message",
      description:
        "Delete (revoke) a message. `message_id` comes from messages_upsert. Revoke-for-everyone only works for messages you sent. Subject to the allowlist and send rate limit.",
      inputSchema: {
        message_id: z.string(),
      },
    },
    async ({ message_id }) => {
      const s = getSocket()
      if (!s || !isConnected()) return notConnected()
      const r = resolveMsg(message_id)
      if ("err" in r) return r.err
      const guard = sendGuard(r.msg.chatJid)
      if (guard) return guard
      try {
        await s.sendMessage(r.msg.chatJid, { delete: r.msg.key })
        return okText(`Deleted ${message_id}`)
      } catch (e) {
        return errText(`Delete failed: ${(e as Error).message}`)
      }
    },
  )

  // --- read_messages ------------------------------------------------------
  server.registerTool(
    "read_messages",
    {
      title: "Mark a message read",
      description:
        "Mark a received message as read (sends a read receipt). `message_id` comes from messages_upsert. Not rate-limited.",
      inputSchema: {
        message_id: z.string(),
      },
    },
    async ({ message_id }) => {
      const s = getSocket()
      if (!s || !isConnected()) return notConnected()
      const r = resolveMsg(message_id)
      if ("err" in r) return r.err
      const denied = recipientDenied(r.msg.chatJid)
      if (denied) return denied
      try {
        await s.readMessages([r.msg.key as any])
        return okText(`Marked ${message_id} read`)
      } catch (e) {
        return errText(`Read receipt failed: ${(e as Error).message}`)
      }
    },
  )

  // --- send_presence_update -----------------------------------------------
  server.registerTool(
    "send_presence_update",
    {
      title: "Send presence/typing",
      description:
        "Send a presence update to a chat: composing (typing), recording, paused, available (online), or unavailable (offline). `to` is a phone number or JID. Not rate-limited.",
      inputSchema: {
        to: z.string(),
        state: z.enum(["composing", "recording", "paused", "available", "unavailable"]),
      },
    },
    async ({ to, state }) => {
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
      try {
        await s.sendPresenceUpdate(state as any, jid)
        return okText(`Presence '${state}' sent to ${jid}`)
      } catch (e) {
        return errText(`Presence update failed: ${(e as Error).message}`)
      }
    },
  )

  // --- send_location ------------------------------------------------------
  server.registerTool(
    "send_location",
    {
      title: "Send a location",
      description:
        "Send a location pin. `to` is a phone number or JID; latitude/longitude are decimal degrees. Subject to the allowlist and send rate limit.",
      inputSchema: {
        to: z.string(),
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        name: z.string().optional(),
        address: z.string().optional(),
      },
    },
    async ({ to, latitude, longitude, name, address }) => {
      const s = getSocket()
      if (!s || !isConnected()) return notConnected()
      let jid: string
      try {
        jid = toJid(to)
      } catch (e) {
        return errText(`Error: ${(e as Error).message}`)
      }
      const guard = sendGuard(jid)
      if (guard) return guard
      try {
        const sent = await s.sendMessage(jid, {
          location: { degreesLatitude: latitude, degreesLongitude: longitude, name, address },
        })
        recordOutgoing(sent, `[location] ${latitude},${longitude}`)
        return okText(`Location sent to ${jid} (id: ${sent?.key?.id ?? "?"})`)
      } catch (e) {
        return errText(`Send failed: ${(e as Error).message}`)
      }
    },
  )

  // --- send_contact -------------------------------------------------------
  server.registerTool(
    "send_contact",
    {
      title: "Send a contact card",
      description:
        "Send a contact as a vCard. `to` is a phone number or JID; `contact_name` and `contact_phone` describe the shared contact. Subject to the allowlist and send rate limit.",
      inputSchema: {
        to: z.string(),
        contact_name: z.string().min(1),
        contact_phone: z.string(),
      },
    },
    async ({ to, contact_name, contact_phone }) => {
      const s = getSocket()
      if (!s || !isConnected()) return notConnected()
      let jid: string
      let vcard: string
      try {
        jid = toJid(to)
        vcard = buildVcard(contact_name, contact_phone)
      } catch (e) {
        return errText(`Error: ${(e as Error).message}`)
      }
      const guard = sendGuard(jid)
      if (guard) return guard
      try {
        const sent = await s.sendMessage(jid, {
          contacts: { displayName: contact_name, contacts: [{ vcard }] },
        })
        recordOutgoing(sent, `[contact] ${contact_name}`)
        return okText(`Contact sent to ${jid} (id: ${sent?.key?.id ?? "?"})`)
      } catch (e) {
        return errText(`Send failed: ${(e as Error).message}`)
      }
    },
  )

  // --- send_poll ----------------------------------------------------------
  server.registerTool(
    "send_poll",
    {
      title: "Send a poll",
      description:
        "Send a poll. `to` is a phone number or JID; `options` are 2–12 choices. `selectable_count` (default 1) is how many the recipient may pick. Subject to the allowlist and send rate limit.",
      inputSchema: {
        to: z.string(),
        name: z.string().min(1).max(255),
        options: z.array(z.string().min(1)).min(2).max(12),
        selectable_count: z.number().int().min(1).optional(),
      },
    },
    async ({ to, name, options, selectable_count }) => {
      const s = getSocket()
      if (!s || !isConnected()) return notConnected()
      let jid: string
      try {
        jid = toJid(to)
      } catch (e) {
        return errText(`Error: ${(e as Error).message}`)
      }
      const guard = sendGuard(jid)
      if (guard) return guard
      const selectableCount = Math.min(selectable_count ?? 1, options.length)
      try {
        const sent = await s.sendMessage(jid, { poll: { name, values: options, selectableCount } })
        recordOutgoing(sent, `[poll] ${name}`)
        return okText(`Poll sent to ${jid} (id: ${sent?.key?.id ?? "?"})`)
      } catch (e) {
        return errText(`Send failed: ${(e as Error).message}`)
      }
    },
  )

  // --- download_media_message ---------------------------------------------
  server.registerTool(
    "download_media_message",
    {
      title: "Download received media",
      description:
        "Download the media (image/video/document/audio/sticker) of a received message to disk. `message_id` comes from messages_upsert. Writes only inside an allowed send directory (WHATSAPP_SEND_ROOT); `dest_dir` must be within one. Not rate-limited.",
      inputSchema: {
        message_id: z.string(),
        dest_dir: z.string().optional(),
        filename: z.string().optional(),
      },
    },
    async ({ message_id, dest_dir, filename }) => {
      const s = getSocket()
      if (!s || !isConnected()) return notConnected()
      const r = resolveMsg(message_id)
      if ("err" in r) return r.err
      if (!r.msg.mediaType) return errText(`Message ${message_id} has no downloadable media.`)

      // Resolve + sandbox the destination directory (default: first send root).
      const baseDir = dest_dir ?? SEND_ROOTS[0]
      let destDir: string
      try {
        destDir = resolveWithinRoots(SEND_ROOTS, baseDir)
        if (isInside(getAuthDir(), destDir)) throw new Error("Refusing to write into the WhatsApp auth directory.")
      } catch (e) {
        return errText((e as Error).message)
      }

      // Pick a safe filename: user-provided basename, the document's own name, or
      // a generated one. Then re-check the full path is inside the sandbox.
      const docName = r.msg.raw?.message?.documentMessage?.fileName
      const chosen = filename
        ? filenameOf(filename)
        : docName
          ? filenameOf(docName)
          : `whatsapp-${message_id}.${MEDIA_EXT[r.msg.mediaType] ?? "bin"}`
      let destPath: string
      try {
        destPath = resolveWithinRoots(SEND_ROOTS, join(destDir, chosen))
      } catch (e) {
        return errText((e as Error).message)
      }

      try {
        const buffer = (await downloadMediaMessage(
          r.msg.raw,
          "buffer",
          {},
          { logger: getLogger(), reuploadRequest: (s as any).updateMediaMessage },
        )) as Buffer
        mkdirSync(destDir, { recursive: true })
        await writeFile(destPath, buffer)
        return okText(`Downloaded ${r.msg.mediaType} from ${message_id} to ${destPath} (${buffer.length} bytes)`)
      } catch (e) {
        return errText(`Download failed: ${(e as Error).message}`)
      }
    },
  )

  // --- group_fetch_all_participating --------------------------------------
  server.registerTool(
    "group_fetch_all_participating",
    {
      title: "List groups",
      description: "List all WhatsApp groups this account participates in (id, subject, participant count).",
      inputSchema: {},
    },
    async () => {
      const s = getSocket()
      if (!s || !isConnected()) return notConnected()
      try {
        const groups = await s.groupFetchAllParticipating()
        const list = Object.values(groups) as any[]
        if (list.length === 0) return okText("No groups found.")
        return okText(
          list
            .map((g, i) => `${i + 1}. ${g.subject ?? "(no subject)"} (${g.id}) — ${g.participants?.length ?? 0} participants`)
            .join("\n"),
        )
      } catch (e) {
        return errText(`Could not fetch groups: ${(e as Error).message}`)
      }
    },
  )

  // --- group_metadata -----------------------------------------------------
  server.registerTool(
    "group_metadata",
    {
      title: "Group info",
      description: "Fetch a group's metadata: subject, description, owner, and participants (with admin flags). `jid` is the group JID (…@g.us).",
      inputSchema: {
        jid: z.string(),
      },
    },
    async ({ jid }) => {
      const s = getSocket()
      if (!s || !isConnected()) return notConnected()
      try {
        const g = await s.groupMetadata(jid)
        const lines = [
          `Subject: ${g.subject ?? "(none)"}`,
          `JID: ${g.id}`,
          `Owner: ${g.owner ?? "(unknown)"}`,
          `Description: ${g.desc ?? "(none)"}`,
          `Participants (${g.participants?.length ?? 0}):`,
          ...(g.participants ?? []).map((p: any) => `  ${p.id}${p.admin ? ` [${p.admin}]` : ""}`),
        ]
        return okText(lines.join("\n"))
      } catch (e) {
        return errText(`Could not fetch group metadata: ${(e as Error).message}`)
      }
    },
  )

  // --- profile_picture_url ------------------------------------------------
  server.registerTool(
    "profile_picture_url",
    {
      title: "Profile picture URL",
      description: "Get the profile-picture URL for a contact or group. `to` is a phone number, user JID, or group JID. Returns a message if none is set or it is not visible to you.",
      inputSchema: {
        to: z.string(),
      },
    },
    async ({ to }) => {
      const s = getSocket()
      if (!s || !isConnected()) return notConnected()
      let jid: string
      try {
        jid = toJid(to)
      } catch (e) {
        return errText(`Error: ${(e as Error).message}`)
      }
      try {
        const url = await s.profilePictureUrl(jid, "image")
        return okText(url ? `Profile picture for ${jid}: ${url}` : `No profile picture set for ${jid}.`)
      } catch (e) {
        return okText(`No profile picture available for ${jid} (not set or not visible to you).`)
      }
    },
  )

  // --- login_qr -----------------------------------------------------------
  server.registerTool(
    "login_qr",
    {
      title: "Show login QR code",
      description:
        "Display the pending WhatsApp linking QR as scannable ASCII, right here in the terminal. Use this when connection_state reports not connected. Scan it in WhatsApp > Settings > Linked Devices > Link a device.",
      inputSchema: {},
    },
    async () => {
      if (isConnected()) return okText(`Already connected as ${getMyJid()}. No QR needed.`)
      const qr = getLastQr()
      if (!qr) {
        const last = getLastError() ? `\nLast error: ${getLastError()}` : ""
        return okText(
          `No QR pending right now. The server may still be starting or reconnecting — wait a few seconds and try again. ` +
            `A QR only appears when WhatsApp wants a fresh link; if you were linked before, it should reconnect on its own.${last}`,
        )
      }
      const ascii = await renderQrAscii(qr)
      return okText(
        `Scan this in WhatsApp > Settings > Linked Devices > Link a device:\n\n${ascii}\n` +
          `(Also saved as an image at ${getQrPath()}. The code refreshes periodically — re-run login_qr if it expires.)`,
      )
    },
  )

  // --- connection_state (was `status`) ------------------------------------
  server.registerTool(
    "connection_state",
    {
      title: "Connection state",
      description: "Show the current WhatsApp connection state. Use this to check if the link succeeded.",
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
        if (getLastQr()) {
          lines.push("A QR is pending — run the login_qr tool to display it here, or open the QR file above.")
        } else {
          lines.push("To link: run login_qr (or open the QR file above) and scan with WhatsApp > Settings > Linked Devices.")
        }
        lines.push(
          "If the link fails with 'Try again later', your WhatsApp account is rate-limited at the server. The MCP cannot bypass that — wait 1+ hour and try again.",
        )
      }
      return okText(lines.join("\n"))
    },
  )

  // --- messages_upsert (was `recent_messages`) ----------------------------
  server.registerTool(
    "messages_upsert",
    {
      title: "Recent messages",
      description:
        "List recent inbound WhatsApp messages observed by the MCP (in-memory only; lost on restart). Each line includes the message id, which other tools (send_reaction, delete_message, download_media_message, …) reference.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ limit = 30 }) => {
      const items = getRecent(limit)
      if (items.length === 0) {
        return okText(
          "No messages yet. The MCP only sees messages received after it connected — for full history, ask the user to send you a message first.",
        )
      }
      return okText(
        items
          .map(
            (m, i) =>
              `${i + 1}. [id:${m.id}] [${new Date(m.ts * 1000).toISOString()}] ${m.fromName ?? m.from} (${m.chatJid}): ${m.body}`,
          )
          .join("\n"),
      )
    },
  )

  // --- chats (was `list_chats`) -------------------------------------------
  server.registerTool(
    "chats",
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
        return okText("No chats observed yet. The MCP only sees chats that have sent a message since it connected.")
      }
      return okText(items.map((c, i) => `${i + 1}. ${c.name} (${c.jid}) — last: ${c.lastBody}`).join("\n"))
    },
  )
}
