# mcp-whatsapp

A local [OpenCode](https://opencode.ai) / MCP server that links a WhatsApp
account (via [Baileys](https://github.com/WhiskeySockets/Baileys)) and exposes
Baileys-flavored tools: `send_message`, `send_media`, `send_reaction`,
`edit_message`, `delete_message`, `read_messages`, `send_presence_update`,
`send_location`, `send_contact`, `send_poll`, `download_media_message`,
`group_fetch_all_participating`, `group_metadata`, `profile_picture_url`,
`login_qr`, `relink`, `connection_state`, `messages_upsert`, `chats`.

This folder is installed by
[`opencode-mcp-whatsapp`](https://github.com/ahmadmcer/opencode-mcp-whatsapp).
You normally don't run anything here by hand — OpenCode launches it via the
`whatsapp` entry in your `opencode.jsonc`.

## Linking your phone

1. Start OpenCode (or restart it) so the server connects.
2. Ask the agent to run **`login_qr`** to print the QR as ASCII in the TUI (also
   written to `../whatsapp/qr.png`), and scan it in **WhatsApp → Settings → Linked
   Devices → Link a device**.
3. Ask the agent to run the `connection_state` tool to confirm `Connected: yes`.

The session is cached under `~/.config/opencode/whatsapp/`, so you only scan once.
If a newer OpenCode session takes over the link, older ones step aside rather than
fighting for it (which used to force a re-scan); restart one — or run `relink` — to
reclaim the link. If WhatsApp reports **Logged out**, run `relink` with `wipe: true`
then `login_qr` to re-link in place, no OpenCode restart needed.

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `WHATSAPP_ALLOWED_RECIPIENTS` | (unset = all) | Comma/`;`/newline list of numbers or JIDs allowed as send targets. |
| `WHATSAPP_SEND_MAX` | `10` | Max sends per window (rate limit). |
| `WHATSAPP_SEND_WINDOW_MS` | `60000` | Rate-limit window in ms. |
| `WHATSAPP_SEND_ROOT` | `~/Downloads` + `~/.config/opencode/whatsapp-outbox` | OS-path-separated list of directories `send_media` may read from and `download_media_message` may write to. |

Set these in the `environment` block of the `whatsapp` server in your
`opencode.jsonc`.

## Tests

```bash
npm test
```

## Security notes

- `send_media` (read) and `download_media_message` (write) are sandboxed to
  `WHATSAPP_SEND_ROOT` and refuse the auth directory — not arbitrary-file tools.
- Message-action tools (`send_reaction`, `edit_message`, `delete_message`,
  `read_messages`, `download_media_message`) reference a `message_id` from
  `messages_upsert`; only messages seen since connect can be referenced.
- Outbound sends are gated by an optional recipient allowlist and a rate limit.
- This uses an unofficial WhatsApp library. Automating WhatsApp can violate its
  Terms of Service and may get the account banned. Use a number you can afford to
  lose, and keep send volume low.
