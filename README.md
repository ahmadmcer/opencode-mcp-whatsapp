# opencode-mcp-whatsapp

An interactive installer that adds a **local WhatsApp MCP server** to your
[OpenCode](https://opencode.ai) setup. Once linked, your agent can send and
receive WhatsApp messages, react/reply/edit/delete, send files, locations,
contacts and polls, download media, and inspect groups — through a set of tools
exposed over the Model Context Protocol.

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

## The tools

Tool names mirror the underlying Baileys calls (snake_cased). Tools marked
**gated** enforce the recipient allowlist and the send rate limit.

**Messaging**

| Tool | What it does |
|---|---|
| `send_message` | Send a text message to a number or JID. Optional `quoted_message_id` replies to a prior message. **(gated)** |
| `send_media` | Send a local file (image / video / document) from an allowed directory. Optional `quoted_message_id`. **(gated)** |
| `send_reaction` | React to a message with an emoji (empty emoji removes it). **(gated)** |
| `edit_message` | Edit the text of a message you sent. **(gated)** |
| `delete_message` | Delete/revoke a message (revoke-for-everyone only for your own). **(gated)** |
| `send_location` | Send a location pin (latitude/longitude, optional name/address). **(gated)** |
| `send_contact` | Send a contact as a vCard. **(gated)** |
| `send_poll` | Send a poll (2–12 options). **(gated)** |

**Chat state & media**

| Tool | What it does |
|---|---|
| `read_messages` | Mark a received message as read (sends a read receipt). |
| `send_presence_update` | Send typing/recording/online/offline presence to a chat. |
| `download_media_message` | Download a received message's media to an allowed directory (write-sandboxed). |

**Discovery**

| Tool | What it does |
|---|---|
| `group_fetch_all_participating` | List the groups this account is in. |
| `group_metadata` | A group's subject, description, owner, and participants. |
| `profile_picture_url` | Profile-picture URL for a contact or group. |
| `login_qr` | Show the pending linking QR as scannable ASCII, right in the TUI. |
| `relink` | Reconnect in-process — optionally wipe the session for a fresh QR (after logout / to switch numbers), no OpenCode restart. |
| `connection_state` | Connection state, your JID, QR path, active policy (send roots, allowlist, rate limit). |
| `messages_upsert` | Recent inbound messages seen since the server connected (in-memory), each with an id other tools reference. |
| `chats` | Chats seen since the server connected. |

Message-action tools (`send_reaction`, `edit_message`, `delete_message`,
`read_messages`, `download_media_message`) take a `message_id` from
`messages_upsert` — only messages seen since the server connected can be
referenced.

## Linking your phone (one time)

1. Start (or restart) `opencode` so the server connects.
2. Ask the agent to run **`login_qr`** — it prints the QR as scannable ASCII right
   in the TUI. (It's also saved as an image at `~/.config/opencode/whatsapp/qr.png`.)
3. Scan it in **WhatsApp → Settings → Linked Devices → Link a device**. The code
   refreshes periodically — re-run `login_qr` if it expires.
4. Ask the agent to run `connection_state` — it should report `Connected: yes`.

The session is cached, so you only scan once. Reconnects are automatic.

**Running more than one session at a time?** Each `opencode` process launches its
own copy of the server, and WhatsApp only allows one live socket per link. When a
newer session connects, older ones now **step aside** instead of fighting to
reclaim the link — the previous behavior (a reconnect ping-pong) was what
occasionally invalidated the session and forced a fresh QR scan. The newest
session owns the connection; restart an older one — or run `relink` — to reclaim it.

**Got "Logged out"?** WhatsApp sometimes drops a linked device. You don't need to
restart OpenCode: ask the agent to run `relink` with `wipe: true` (clears the
stale session), then `login_qr` to scan a fresh code. Plain `relink` (no wipe)
just reconnects with the existing session.

## Safety model

This server is designed to be driven by an LLM, so the write-capable tools are
gated:

- **File access is sandboxed.** `send_file`/`send_media` only reads, and
  `download_media_message` only writes, files under `WHATSAPP_SEND_ROOT`
  (default: `~/Downloads` and `~/.config/opencode/whatsapp-outbox`); both refuse
  the auth directory. It is *not* an arbitrary-file-read/write tool.
- **Recipient allowlist.** Optionally restrict who can be messaged
  (`WHATSAPP_ALLOWED_RECIPIENTS`). Unset means no restriction.
- **Send rate limit.** At most `WHATSAPP_SEND_MAX` sends per
  `WHATSAPP_SEND_WINDOW_MS` (default 10 / 60s), shared by every message-producing
  tool (`send_message`, `send_media`, `send_reaction`, `edit_message`,
  `delete_message`, `send_location`, `send_contact`, `send_poll`).

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
