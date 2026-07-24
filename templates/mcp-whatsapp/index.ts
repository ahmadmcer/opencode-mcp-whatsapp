import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { startConnection } from "./store.js"
import { registerTools } from "./tools.js"

const server = new McpServer({ name: "whatsapp", version: "1.2.0" })
registerTools(server)

// Bring the MCP transport up first so tools (including `connection_state`) are
// always reachable, then connect to WhatsApp in the background. WhatsApp being
// down no longer makes the whole MCP unavailable — failures surface via
// `connection_state`.
const transport = new StdioServerTransport()
await server.connect(transport)
startConnection()
