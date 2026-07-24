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
  forceRelink,
  getPresence,
  cacheGroupMetadata,
  isSyncFullHistory,
} from "./store.js"
import { getRecent, getMessageById, recordOutgoing, type ResolvedMessage } from "./messages.js"
import {
  getChatMessages,
  searchMessages as searchHistory,
  listChats as listHistoryChats,
  listContacts,
  oldestFor,
  stats as historyStats,
} from "./historyStore.js"
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

// Bare phone/user part of a JID, ignoring the device suffix (…:NN) and domain,
// so an own-JID comparison works regardless of how WhatsApp formats it.
function barePart(jid: string | null | undefined) {
  return (jid ?? "").split("@")[0].split(":")[0]
}

// Turn WhatsApp's raw invite errors (bad-request/not-authorized/…) into a plain
// message; other errors pass through with the given prefix.
function inviteError(prefix: string, e: unknown) {
  const msg = (e as Error).message
  if (/not-authorized|bad-request|gone|404|not-acceptable|invalid|resource-not-found/i.test(msg)) {
    return errText(`Invite link is invalid or expired — the group may be empty or full, or the link was revoked. (${msg})`)
  }
  return errText(`${prefix}: ${msg}`)
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
        cacheGroupMetadata(jid, g) // warm the send-path cache
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

  // --- relink -------------------------------------------------------------
  server.registerTool(
    "relink",
    {
      title: "Re-link WhatsApp",
      description:
        "Reconnect the WhatsApp session in-process — no OpenCode restart needed. Set `wipe: true` to delete the stored session first and generate a fresh QR (use this after a 'Logged out' state, or to link a different number); `wipe: false` just reconnects with the existing session (e.g. to reclaim a link a newer session took over). After running with wipe, wait a few seconds and call login_qr.",
      inputSchema: {
        wipe: z.boolean().optional(),
      },
    },
    async ({ wipe = false }) => {
      try {
        await forceRelink(wipe)
      } catch (e) {
        return errText(`Relink failed: ${(e as Error).message}`)
      }
      return okText(
        wipe
          ? "Session wiped and the connection is restarting. Wait ~3–5 seconds, then run login_qr to scan a fresh code."
          : "Reconnecting with the existing session. Run connection_state in a few seconds to confirm; if it was logged out, use relink with wipe: true instead.",
      )
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
        const loggedOut = getLastError()?.includes("Logged out")
        const last = getLastError() ? `\nLast error: ${getLastError()}` : ""
        const hint = loggedOut
          ? "The session is logged out — run the relink tool with wipe: true to clear it and generate a fresh QR."
          : "The server may still be starting or reconnecting — wait a few seconds and try again. A QR only appears when WhatsApp wants a fresh link; if you were linked before, it should reconnect on its own."
        return okText(`No QR pending right now. ${hint}${last}`)
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
        `History sync: ${isSyncFullHistory() ? "full" : "recent only"} — stored ${historyStats().messages} messages across ${historyStats().chats} chats`,
      ]
      if (getLastError()) lines.push(`Last error: ${getLastError()}`)
      if (!isConnected()) {
        lines.push("")
        if (getLastError()?.includes("Logged out")) {
          lines.push("Logged out — run the relink tool with wipe: true to clear the stale session and get a fresh QR (no OpenCode restart needed), then login_qr.")
        } else if (getLastQr()) {
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
        "List known chats, most recent first — from the persistent history store (includes chats synced on link, not only those active since this run).",
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ limit = 30 }) => {
      const items = listHistoryChats(limit)
      if (items.length === 0) {
        return okText("No chats known yet. History syncs shortly after linking; ask the user to send a message if it stays empty.")
      }
      return okText(items.map((c, i) => `${i + 1}. ${c.name ?? c.jid} (${c.jid}) — last: ${c.lastBody}`).join("\n"))
    },
  )

  // ======================================================================
  // History (persistent, searchable)
  // ======================================================================

  server.registerTool(
    "load_messages",
    {
      title: "Read a chat's messages",
      description:
        "Read stored messages for a chat from the persistent history (survives restarts). `chat` is a phone number or JID. Page older with `before` (a unix-seconds timestamp). Returns messages oldest→newest with ids.",
      inputSchema: {
        chat: z.string(),
        limit: z.number().int().min(1).max(200).optional(),
        before: z.number().int().positive().optional(),
      },
    },
    async ({ chat, limit = 30, before }) => {
      let jid: string
      try {
        jid = toJid(chat)
      } catch (e) {
        return errText(`Error: ${(e as Error).message}`)
      }
      const items = getChatMessages(jid, { limit, before })
      if (items.length === 0) {
        return okText(
          `No stored messages for ${jid}. History only covers WhatsApp's recent window plus messages seen since linking; try fetch_message_history for older ones (best-effort).`,
        )
      }
      return okText(
        items
          .map((m) => `[id:${m.id}] [${new Date(m.ts * 1000).toISOString()}] ${m.fromMe ? "me" : m.fromName ?? m.from}: ${m.body}`)
          .join("\n"),
      )
    },
  )

  server.registerTool(
    "search_messages",
    {
      title: "Search message history",
      description:
        "Case-insensitive substring search over stored message text, newest first. Optionally restrict to one `chat` (phone or JID).",
      inputSchema: {
        query: z.string().min(1),
        chat: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ query, chat, limit = 30 }) => {
      let chatJid: string | undefined
      if (chat) {
        try {
          chatJid = toJid(chat)
        } catch (e) {
          return errText(`Error: ${(e as Error).message}`)
        }
      }
      const items = searchHistory(query, { chat: chatJid, limit })
      if (items.length === 0) return okText(`No stored messages match "${query}".`)
      return okText(
        items
          .map((m) => `[id:${m.id}] [${new Date(m.ts * 1000).toISOString()}] ${m.chatJid} — ${m.fromMe ? "me" : m.fromName ?? m.from}: ${m.body}`)
          .join("\n"),
      )
    },
  )

  server.registerTool(
    "fetch_message_history",
    {
      title: "Fetch older history (best-effort)",
      description:
        "Ask WhatsApp for messages older than what's stored for a chat, via on-demand history sync. Best-effort: WhatsApp often ignores this for linked devices. Any results arrive asynchronously and land in the history store — re-run load_messages after a few seconds.",
      inputSchema: {
        chat: z.string(),
        count: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ chat, count = 50 }) => {
      const s = getSocket()
      if (!s || !isConnected()) return notConnected()
      let jid: string
      try {
        jid = toJid(chat)
      } catch (e) {
        return errText(`Error: ${(e as Error).message}`)
      }
      const oldest = oldestFor(jid)
      if (!oldest) return errText(`No stored messages for ${jid} yet — nothing to page back from. Open the chat / wait for history sync first.`)
      const limited = rateLimited()
      if (limited) return limited
      try {
        await (s as any).fetchMessageHistory(count, { remoteJid: jid, id: oldest.id, fromMe: oldest.fromMe }, oldest.ts)
        return okText(`Requested up to ${count} older messages for ${jid}. Best-effort — re-run load_messages in a few seconds to see any that arrived.`)
      } catch (e) {
        return errText(`Fetch failed: ${(e as Error).message}`)
      }
    },
  )

  server.registerTool(
    "contacts",
    {
      title: "List known contacts",
      description: "List contacts captured from WhatsApp's history sync (name + JID). Limited to what WhatsApp shared with this device.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    async ({ limit = 100 }) => {
      const items = listContacts(limit)
      if (items.length === 0) return okText("No contacts known yet (they arrive with history sync after linking).")
      return okText(items.map((c, i) => `${i + 1}. ${c.name ?? "(no name)"} (${c.jid})`).join("\n"))
    },
  )

  // ======================================================================
  // Group management
  // ======================================================================

  server.registerTool(
    "group_create",
    {
      title: "Create a group",
      description: "Create a WhatsApp group with a subject and initial participants (phone numbers or JIDs). Rate-limited.",
      inputSchema: {
        subject: z.string().min(1),
        participants: z.array(z.string()).min(1).max(50),
      },
    },
    async ({ subject, participants }) => {
      const s = getSocket()
      if (!s || !isConnected()) return notConnected()
      let jids: string[]
      try {
        jids = participants.map(toJid)
      } catch (e) {
        return errText(`Error: ${(e as Error).message}`)
      }
      const limited = rateLimited()
      if (limited) return limited
      try {
        const g = await s.groupCreate(subject, jids)
        return okText(`Created group "${subject}" (${g.id}) with ${g.participants?.length ?? jids.length} participants.`)
      } catch (e) {
        return errText(`Create failed: ${(e as Error).message}`)
      }
    },
  )

  server.registerTool(
    "group_participants_update",
    {
      title: "Add/remove/promote group members",
      description: "Modify group participants. `action` is add | remove | promote | demote. `jid` is the group JID; `participants` are phone numbers or JIDs. Requires admin. Rate-limited.",
      inputSchema: {
        jid: z.string(),
        participants: z.array(z.string()).min(1).max(50),
        action: z.enum(["add", "remove", "promote", "demote"]),
      },
    },
    async ({ jid, participants, action }) => {
      const s = getSocket()
      if (!s || !isConnected()) return notConnected()
      let jids: string[]
      try {
        jids = participants.map(toJid)
      } catch (e) {
        return errText(`Error: ${(e as Error).message}`)
      }
      const limited = rateLimited()
      if (limited) return limited
      try {
        const res = await s.groupParticipantsUpdate(jid, jids, action)
        return okText(`${action} on ${jid}:\n${(res ?? []).map((r: any) => `  ${r.jid}: ${r.status}`).join("\n") || "(done)"}`)
      } catch (e) {
        return errText(`Update failed: ${(e as Error).message}`)
      }
    },
  )

  server.registerTool(
    "group_update",
    {
      title: "Update group subject/description",
      description: "Change a group's subject and/or description. `jid` is the group JID. Requires admin. Rate-limited.",
      inputSchema: {
        jid: z.string(),
        subject: z.string().optional(),
        description: z.string().optional(),
      },
    },
    async ({ jid, subject, description }) => {
      const s = getSocket()
      if (!s || !isConnected()) return notConnected()
      if (!subject && description === undefined) return errText("Provide subject and/or description.")
      const limited = rateLimited()
      if (limited) return limited
      try {
        if (subject) await s.groupUpdateSubject(jid, subject)
        if (description !== undefined) await s.groupUpdateDescription(jid, description)
        return okText(`Updated ${jid}${subject ? ` (subject)` : ""}${description !== undefined ? ` (description)` : ""}.`)
      } catch (e) {
        return errText(`Update failed: ${(e as Error).message}`)
      }
    },
  )

  server.registerTool(
    "group_setting_update",
    {
      title: "Change group settings",
      description:
        "Change who can post/edit: announcement (only admins send), not_announcement (all send), locked (only admins edit info), unlocked (all edit). Requires admin. Rate-limited.",
      inputSchema: {
        jid: z.string(),
        setting: z.enum(["announcement", "not_announcement", "locked", "unlocked"]),
      },
    },
    async ({ jid, setting }) => {
      const s = getSocket()
      if (!s || !isConnected()) return notConnected()
      const limited = rateLimited()
      if (limited) return limited
      try {
        await s.groupSettingUpdate(jid, setting)
        return okText(`Set ${setting} on ${jid}.`)
      } catch (e) {
        return errText(`Update failed: ${(e as Error).message}`)
      }
    },
  )

  server.registerTool(
    "group_invite",
    {
      title: "Get or revoke group invite link",
      description: "Get the group's invite link, or revoke it and get a new one. `action` is get | revoke. Requires admin. Revoking invalidates the old link.",
      inputSchema: {
        jid: z.string(),
        action: z.enum(["get", "revoke"]).optional(),
      },
    },
    async ({ jid, action = "get" }) => {
      const s = getSocket()
      if (!s || !isConnected()) return notConnected()
      if (action === "revoke") {
        const limited = rateLimited()
        if (limited) return limited
      }
      try {
        const code = action === "revoke" ? await s.groupRevokeInvite(jid) : await s.groupInviteCode(jid)
        return okText(`${action === "revoke" ? "New invite" : "Invite"} link for ${jid}: https://chat.whatsapp.com/${code}`)
      } catch (e) {
        return errText(`Failed: ${(e as Error).message}`)
      }
    },
  )

  server.registerTool(
    "group_accept_invite",
    {
      title: "Join a group by invite",
      description: "Join a group using an invite code or full https://chat.whatsapp.com/... link. Rate-limited.",
      inputSchema: {
        code: z.string().min(1),
      },
    },
    async ({ code }) => {
      const s = getSocket()
      if (!s || !isConnected()) return notConnected()
      const c = code.trim().split("/").pop() ?? code.trim()
      const limited = rateLimited()
      if (limited) return limited
      try {
        const jid = await s.groupAcceptInvite(c)
        return okText(`Joined group ${jid ?? "(unknown)"}.`)
      } catch (e) {
        return inviteError("Join failed", e)
      }
    },
  )

  server.registerTool(
    "group_get_invite_info",
    {
      title: "Preview a group invite",
      description: "Look up a group's metadata from an invite code or link without joining.",
      inputSchema: {
        code: z.string().min(1),
      },
    },
    async ({ code }) => {
      const s = getSocket()
      if (!s || !isConnected()) return notConnected()
      const c = code.trim().split("/").pop() ?? code.trim()
      try {
        const g: any = await s.groupGetInviteInfo(c)
        return okText(`${g.subject ?? "(no subject)"} (${g.id}) — ${g.size ?? g.participants?.length ?? "?"} members`)
      } catch (e) {
        return inviteError("Lookup failed", e)
      }
    },
  )

  server.registerTool(
    "group_leave",
    {
      title: "Leave a group",
      description: "Leave a group. This is irreversible — you'd need a new invite to rejoin. `jid` is the group JID. Rate-limited.",
      inputSchema: {
        jid: z.string(),
      },
    },
    async ({ jid }) => {
      const s = getSocket()
      if (!s || !isConnected()) return notConnected()
      const limited = rateLimited()
      if (limited) return limited
      try {
        await s.groupLeave(jid)
        return okText(`Left ${jid}.`)
      } catch (e) {
        return errText(`Leave failed: ${(e as Error).message}`)
      }
    },
  )

  // ======================================================================
  // Contacts & discovery
  // ======================================================================

  server.registerTool(
    "on_whatsapp",
    {
      title: "Check numbers on WhatsApp",
      description: "Check whether phone numbers are registered on WhatsApp (and get their JIDs). Useful before sending. Pass numbers in international format.",
      inputSchema: {
        numbers: z.array(z.string()).min(1).max(20),
      },
    },
    async ({ numbers }) => {
      const s = getSocket()
      if (!s || !isConnected()) return notConnected()
      try {
        const results = await s.onWhatsApp(...numbers)
        return okText(
          numbers
            .map((n) => {
              const hit = (results ?? []).find((r: any) => r.jid?.startsWith(n.replace(/\D/g, "")))
              return `${n}: ${hit?.exists ? `on WhatsApp (${hit.jid})` : "not on WhatsApp"}`
            })
            .join("\n"),
        )
      } catch (e) {
        return errText(`Lookup failed: ${(e as Error).message}`)
      }
    },
  )

  server.registerTool(
    "update_block_status",
    {
      title: "Block or unblock a contact",
      description: "Block or unblock a contact. `to` is a phone number or JID; `action` is block | unblock. Blocking stops all messages from them. Rate-limited.",
      inputSchema: {
        to: z.string(),
        action: z.enum(["block", "unblock"]),
      },
    },
    async ({ to, action }) => {
      const s = getSocket()
      if (!s || !isConnected()) return notConnected()
      let jid: string
      try {
        jid = toJid(to)
      } catch (e) {
        return errText(`Error: ${(e as Error).message}`)
      }
      if (barePart(jid) === barePart(getMyJid())) {
        return errText("Can't block your own number.")
      }
      const limited = rateLimited()
      if (limited) return limited
      try {
        await s.updateBlockStatus(jid, action)
        return okText(`${action === "block" ? "Blocked" : "Unblocked"} ${jid}.`)
      } catch (e) {
        return errText(`Failed: ${(e as Error).message}`)
      }
    },
  )

  server.registerTool(
    "fetch_blocklist",
    {
      title: "List blocked contacts",
      description: "List the JIDs you have blocked.",
      inputSchema: {},
    },
    async () => {
      const s = getSocket()
      if (!s || !isConnected()) return notConnected()
      try {
        const list = await s.fetchBlocklist()
        return okText(list?.length ? list.join("\n") : "No blocked contacts.")
      } catch (e) {
        return errText(`Failed: ${(e as Error).message}`)
      }
    },
  )

  server.registerTool(
    "get_business_profile",
    {
      title: "Business profile",
      description: "Fetch a WhatsApp Business profile (description, category, email, website) for a number or JID, if it's a business account.",
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
        const p: any = await s.getBusinessProfile(jid)
        if (!p) return okText(`${jid} has no business profile (not a business account).`)
        const lines = [
          `Business: ${jid}`,
          p.description ? `Description: ${p.description}` : null,
          p.category ? `Category: ${p.category}` : null,
          p.email ? `Email: ${p.email}` : null,
          p.website?.length ? `Website: ${p.website.join(", ")}` : null,
          p.address ? `Address: ${p.address}` : null,
        ].filter(Boolean)
        return okText(lines.join("\n"))
      } catch (e) {
        return errText(`Failed: ${(e as Error).message}`)
      }
    },
  )

  server.registerTool(
    "fetch_status",
    {
      title: "Contact about/status text",
      description: "Fetch a contact's About text (the 'status' line, not a story) for a number or JID.",
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
        const res: any = await s.fetchStatus(jid)
        const st = Array.isArray(res) ? res[0]?.status : res
        if (!st?.status) return okText(`No About text visible for ${jid}.`)
        return okText(`${jid} — About: ${st.status}${st.setAt ? ` (set ${new Date(st.setAt).toISOString()})` : ""}`)
      } catch (e) {
        return errText(`Failed: ${(e as Error).message}`)
      }
    },
  )

  server.registerTool(
    "presence_subscribe",
    {
      title: "Subscribe to presence",
      description: "Subscribe to a contact's presence (online/typing/last-seen) and return the latest known value. Presence arrives asynchronously — re-run to see updates. `to` is a phone number or JID.",
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
        await s.presenceSubscribe(jid)
        const p = getPresence(jid)
        return okText(p ? `${jid}: ${p}` : `Subscribed to ${jid}. No presence received yet — re-run in a moment.`)
      } catch (e) {
        return errText(`Failed: ${(e as Error).message}`)
      }
    },
  )

  // ======================================================================
  // Chat & profile management
  // ======================================================================

  server.registerTool(
    "chat_modify",
    {
      title: "Modify a chat",
      description:
        "Change a chat's state. `action` is mute | unmute | archive | unarchive | pin | unpin | mark_read | mark_unread | delete. `mute_hours` sets a mute duration (default 8). delete removes the chat from your list (irreversible on this device). `to` is a phone number or JID. Rate-limited.",
      inputSchema: {
        to: z.string(),
        action: z.enum(["mute", "unmute", "archive", "unarchive", "pin", "unpin", "mark_read", "mark_unread", "delete"]),
        mute_hours: z.number().positive().max(720).optional(),
      },
    },
    async ({ to, action, mute_hours = 8 }) => {
      const s = getSocket()
      if (!s || !isConnected()) return notConnected()
      let jid: string
      try {
        jid = toJid(to)
      } catch (e) {
        return errText(`Error: ${(e as Error).message}`)
      }
      const last = getChatMessages(jid, { limit: 1 })[0]
      const lastMessages = last ? [{ key: { remoteJid: jid, id: last.id, fromMe: last.fromMe }, messageTimestamp: last.ts }] : []
      const limited = rateLimited()
      if (limited) return limited
      let mod: any
      switch (action) {
        case "mute":
          mod = { mute: mute_hours * 60 * 60 * 1000 }
          break
        case "unmute":
          mod = { mute: null }
          break
        case "archive":
          mod = { archive: true, lastMessages }
          break
        case "unarchive":
          mod = { archive: false, lastMessages }
          break
        case "pin":
          mod = { pin: true }
          break
        case "unpin":
          mod = { pin: false }
          break
        case "mark_read":
          mod = { markRead: true, lastMessages }
          break
        case "mark_unread":
          mod = { markRead: false, lastMessages }
          break
        case "delete":
          mod = { delete: true, lastMessages }
          break
      }
      try {
        await s.chatModify(mod, jid)
        return okText(`${action} applied to ${jid}.`)
      } catch (e) {
        return errText(`Failed: ${(e as Error).message}`)
      }
    },
  )

  server.registerTool(
    "star_message",
    {
      title: "Star/unstar a message",
      description: "Star or unstar a message. `message_id` comes from messages_upsert / load_messages. `star` true to star, false to unstar. Rate-limited.",
      inputSchema: {
        message_id: z.string(),
        star: z.boolean().optional(),
      },
    },
    async ({ message_id, star = true }) => {
      const s = getSocket()
      if (!s || !isConnected()) return notConnected()
      const r = resolveMsg(message_id)
      if ("err" in r) return r.err
      const limited = rateLimited()
      if (limited) return limited
      try {
        await s.chatModify(
          { star: { messages: [{ id: message_id, fromMe: r.msg.key.fromMe ?? false }], star } } as any,
          r.msg.chatJid,
        )
        return okText(`${star ? "Starred" : "Unstarred"} ${message_id}.`)
      } catch (e) {
        return errText(`Failed: ${(e as Error).message}`)
      }
    },
  )

  server.registerTool(
    "update_profile",
    {
      title: "Update your profile",
      description: "Update your own WhatsApp profile name and/or About text. Rate-limited.",
      inputSchema: {
        name: z.string().min(1).max(25).optional(),
        status: z.string().max(139).optional(),
      },
    },
    async ({ name, status }) => {
      const s = getSocket()
      if (!s || !isConnected()) return notConnected()
      if (name === undefined && status === undefined) return errText("Provide name and/or status.")
      const limited = rateLimited()
      if (limited) return limited
      try {
        if (name !== undefined) await s.updateProfileName(name)
        if (status !== undefined) await s.updateProfileStatus(status)
        return okText(`Updated your profile${name !== undefined ? " (name)" : ""}${status !== undefined ? " (about)" : ""}.`)
      } catch (e) {
        return errText(`Failed: ${(e as Error).message}`)
      }
    },
  )

  server.registerTool(
    "update_profile_picture",
    {
      title: "Set/remove your profile picture",
      description:
        "Set your own profile picture from a local image (must be under an allowed send directory), or remove it with `remove: true`. Rate-limited.",
      inputSchema: {
        filePath: z.string().optional(),
        remove: z.boolean().optional(),
      },
    },
    async ({ filePath, remove = false }) => {
      const s = getSocket()
      if (!s || !isConnected()) return notConnected()
      const me = getMyJid()
      if (!me) return errText("Not connected — no own JID yet.")
      const limited = rateLimited()
      if (limited) return limited
      try {
        if (remove) {
          await s.removeProfilePicture(me)
          return okText("Removed your profile picture.")
        }
        if (!filePath) return errText("Provide filePath (an image under an allowed send directory) or remove: true.")
        let safePath: string
        try {
          safePath = resolveWithinRoots(SEND_ROOTS, filePath)
          if (isInside(getAuthDir(), safePath)) throw new Error("Refusing to read from the WhatsApp auth directory.")
        } catch (e) {
          return errText((e as Error).message)
        }
        await s.updateProfilePicture(me, { url: safePath })
        return okText(`Updated your profile picture from ${safePath}.`)
      } catch (e) {
        return errText(`Failed: ${(e as Error).message}`)
      }
    },
  )
}
