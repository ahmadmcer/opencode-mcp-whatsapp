# mcp-whatsapp

A local [OpenCode](https://opencode.ai) / MCP server that links a WhatsApp
account (via [Baileys](https://github.com/WhiskeySockets/Baileys)) and exposes
five tools: `send`, `send_file`, `status`, `recent_messages`, `list_chats`.

This folder is installed by
[`opencode-mcp-whatsapp`](https://github.com/ahmadmcer/opencode-mcp-whatsapp).
You normally don't run anything here by hand — OpenCode launches it via the
`whatsapp` entry in your `opencode.jsonc`.

## Linking your phone

1. Start OpenCode (or restart it) so the server connects. On first run it writes
   a QR image to `../whatsapp/qr.png` (i.e. `~/.config/opencode/whatsapp/qr.png`).
2. Open that PNG and scan it in **WhatsApp → Settings → Linked Devices → Link a
   device**.
3. Ask the agent to run the `status` tool to confirm `Connected: yes`.

The session is cached under `~/.config/opencode/whatsapp/`, so you only scan once.

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `WHATSAPP_ALLOWED_RECIPIENTS` | (unset = all) | Comma/`;`/newline list of numbers or JIDs allowed as send targets. |
| `WHATSAPP_SEND_MAX` | `10` | Max sends per window (rate limit). |
| `WHATSAPP_SEND_WINDOW_MS` | `60000` | Rate-limit window in ms. |
| `WHATSAPP_SEND_ROOT` | `~/Downloads` + `~/.config/opencode/whatsapp-outbox` | OS-path-separated list of directories `send_file` may read from. |

Set these in the `environment` block of the `whatsapp` server in your
`opencode.jsonc`.

## Tests

```bash
npm test
```

## Security notes

- `send_file` is sandboxed to `WHATSAPP_SEND_ROOT` and refuses to read the auth
  directory — it is not an arbitrary-file-read tool.
- Outbound sends are gated by an optional recipient allowlist and a rate limit.
- This uses an unofficial WhatsApp library. Automating WhatsApp can violate its
  Terms of Service and may get the account banned. Use a number you can afford to
  lose, and keep send volume low.
