import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js"
import { isConnected, getMyJid, getLastError, isSyncFullHistory } from "./store.js"
import { listChats, listContacts, getChatMessages, stats } from "./historyStore.js"
import { getRecent } from "./messages.js"
import { toJid } from "./utils.js"

// Read-only MCP *resources* — distinct from tools. These let a client browse and
// pull WhatsApp state into context by URI (via list_mcp_resources / read) without
// invoking a tool. Registering any resource declares the `resources` capability,
// so the server no longer reports "does not support resources".

function json(uri: URL, value: unknown) {
  return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(value, null, 2) }] }
}

export function registerResources(server: McpServer) {
  server.registerResource(
    "connection",
    "whatsapp://connection",
    {
      title: "WhatsApp connection state",
      description: "Current connection status, your JID, history-sync mode, and stored counts.",
      mimeType: "application/json",
    },
    async (uri) =>
      json(uri, {
        connected: isConnected(),
        myJid: getMyJid(),
        lastError: getLastError(),
        historySync: isSyncFullHistory() ? "full" : "recent",
        ...stats(),
      }),
  )

  server.registerResource(
    "chats",
    "whatsapp://chats",
    { title: "WhatsApp chats", description: "Known chats, most recent first.", mimeType: "application/json" },
    async (uri) => json(uri, listChats(200)),
  )

  server.registerResource(
    "contacts",
    "whatsapp://contacts",
    { title: "WhatsApp contacts", description: "Contacts captured from history sync.", mimeType: "application/json" },
    async (uri) => json(uri, listContacts(500)),
  )

  server.registerResource(
    "recent-messages",
    "whatsapp://messages/recent",
    {
      title: "Recent WhatsApp messages",
      description: "Live in-memory messages seen since the server connected.",
      mimeType: "application/json",
    },
    async (uri) => json(uri, getRecent(50)),
  )

  // One resource per chat, addressable as whatsapp://chat/<jid>. The list callback
  // enumerates known chats so a client can discover them; reading returns that
  // chat's stored history.
  server.registerResource(
    "chat-history",
    new ResourceTemplate("whatsapp://chat/{jid}", {
      list: async () => ({
        resources: listChats(200).map((c) => ({
          uri: `whatsapp://chat/${encodeURIComponent(c.jid)}`,
          name: c.name ?? c.jid,
          description: `Last: ${c.lastBody}`,
          mimeType: "application/json",
        })),
      }),
    }),
    {
      title: "Chat history",
      description: "Stored messages for a chat. The {jid} may be a phone number or a full JID.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const raw = decodeURIComponent(String(variables.jid ?? ""))
      let jid = raw
      try {
        jid = toJid(raw)
      } catch {
        // keep the raw value; getChatMessages just returns empty for an unknown jid
      }
      return json(uri, getChatMessages(jid, { limit: 200 }))
    },
  )
}
