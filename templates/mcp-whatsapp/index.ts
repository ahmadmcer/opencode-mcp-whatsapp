import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { startConnection } from "./store.js"
import { registerTools } from "./tools.js"
import { registerResources } from "./resources.js"
import { load as loadHistory, flush as flushHistory } from "./historyStore.js"

const server = new McpServer({ name: "whatsapp", version: "1.3.2" })
registerTools(server)
registerResources(server)

// Load persisted chat history before connecting, so tools can read past chats
// immediately and history-sync merges into what's already on disk.
loadHistory()
// Persist any pending history on shutdown (debounced writes may not have flushed).
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    flushHistory()
    process.exit(0)
  })
}

// Bring the MCP transport up first so tools (including `connection_state`) are
// always reachable, then connect to WhatsApp in the background. WhatsApp being
// down no longer makes the whole MCP unavailable — failures surface via
// `connection_state`.
const transport = new StdioServerTransport()
await server.connect(transport)
startConnection()
