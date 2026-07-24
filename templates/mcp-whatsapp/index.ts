import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { startConnection } from "./store.js"
import { registerTools } from "./tools.js"

const server = new McpServer({ name: "whatsapp", version: "1.0.0" })
registerTools(server)

// Bring the MCP transport up first so tools (including `status`) are always
// reachable, then connect to WhatsApp in the background. WhatsApp being down no
// longer makes the whole MCP unavailable — failures surface via `status`.
const transport = new StdioServerTransport()
await server.connect(transport)
startConnection()
