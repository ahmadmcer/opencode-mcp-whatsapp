# opencode-mcp-whatsapp

An interactive installer that adds a **local WhatsApp MCP server** to your
[OpenCode](https://opencode.ai) setup. Once linked, your agent can send and
receive WhatsApp messages, send files, and list recent chats — through five
tools exposed over the Model Context Protocol.

It's built on [Baileys](https://github.com/WhiskeySockets/Baileys) (an
unofficial WhatsApp Web library) and runs entirely on your machine.

## Quick start

```bash
npx github:ahmadmcer/opencode-mcp-whatsapp
```

No npm publish, no global install — `npx` clones the repo and runs the
installer directly. It copies the server into `~/.config/opencode/mcp-whatsapp`,
registers it in your `opencode.jsonc`, runs `npm install`, and tells you how to
link your phone.

Requires **Node.js ≥ 18** and **npm**. The `opencode` CLI is recommended (used
for a post-install sanity check) but not required to install.

## What it installs

- `mcp-whatsapp/` — the MCP server (`index`, `store`, `messages`, `tools`,
  `utils`, `policy`, plus unit tests), dropped into your OpenCode config dir.
- A `whatsapp` entry in the `mcp` block of your `opencode.jsonc`:

  ```json
  {
    "mcp": {
      "whatsapp": {
        "type": "local",
        "command": ["npx", "-y", "tsx", "index.ts"],
        "cwd": "<config-dir>/mcp-whatsapp",
        "enabled": true,
        "environment": { "WHATSAPP_SEND_MAX": "10" }
      }
    }
  }
  ```

## The five tools

| Tool | What it does |
|---|---|
| `send` | Send a text message to a number or JID. |
| `send_file` | Send a local file (image / video / document) from an allowed directory. |
| `status` | Connection state, your JID, QR path, active policy (send roots, allowlist, rate limit). |
| `recent_messages` | Recent inbound messages seen since the server connected (in-memory). |
| `list_chats` | Chats seen since the server connected. |

## Linking your phone (one time)

1. Start (or restart) `opencode` so the server connects.
2. It writes a QR image to `~/.config/opencode/whatsapp/qr.png`.
3. Open that PNG and scan it in **WhatsApp → Settings → Linked Devices → Link a device**.
4. Ask the agent to run `status` — it should report `Connected: yes`.

The session is cached, so you only scan once. Reconnects are automatic.

## Safety model

This server is designed to be driven by an LLM, so the two write-capable tools
are gated:

- **`send_file` is sandboxed.** It only reads files under `WHATSAPP_SEND_ROOT`
  (default: `~/Downloads` and `~/.config/opencode/whatsapp-outbox`) and refuses
  to read the auth directory. It is *not* an arbitrary-file-read tool.
- **Recipient allowlist.** Optionally restrict who can be messaged
  (`WHATSAPP_ALLOWED_RECIPIENTS`). Unset means no restriction.
- **Send rate limit.** At most `WHATSAPP_SEND_MAX` sends per
  `WHATSAPP_SEND_WINDOW_MS` (default 10 / 60s), shared by `send` and `send_file`.

All three are configurable during install and afterward via the `environment`
block. Full detail: [`docs/REFERENCE.md`](docs/REFERENCE.md).

## What it does NOT do

- **Never silently overwrites.** Every existing file (including your
  `opencode.jsonc`) is renamed to a timestamped `.bak` before being replaced.
- **Never writes secrets to disk.** No tokens or credentials are handled by the
  installer.
- **Doesn't phone home.** Everything runs locally against your filesystem and
  your own `opencode` CLI.

## Prompts you'll see

1. Confirm or override the target directory (defaults to `~/.config/opencode`)
2. Allowed recipients (optional — blank allows all)
3. Max sends per window, and the window length in seconds
4. Send roots override (optional — blank uses the default sandbox)
5. A recap and yes/no confirmation — **nothing is written before this point**

Then: files are copied (with backups), `opencode.jsonc` is updated, `npm install`
runs in `mcp-whatsapp/`, and — if the `opencode` CLI is present —
`opencode debug config` and `opencode mcp list` run so you can see it resolved.

## Rollback

Every backup is a plain renamed file next to the one that replaced it
(e.g. `opencode.jsonc.2026-07-24T12-00-00Z.bak`). To roll back, delete the new
file and rename the `.bak` back. There's no automated rollback command.

## Manual config

If you'd rather not let the installer touch your `opencode.jsonc`, copy the
`templates/mcp-whatsapp` folder into your config dir yourself, run `npm install`
inside it, and paste the `whatsapp` block shown above into your `mcp` object
(using an absolute, forward-slash `cwd`).

## Disclaimer

This uses an **unofficial** WhatsApp library. Automating WhatsApp can violate
its Terms of Service and may result in your account being banned. Use a number
you can afford to lose and keep automated send volume low. Provided as-is, with
no warranty (MIT).

## License

MIT
