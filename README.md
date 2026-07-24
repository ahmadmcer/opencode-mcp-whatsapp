# opencode-mcp-whatsapp

[![Release](https://img.shields.io/github/v/release/ahmadmcer/opencode-mcp-whatsapp?label=release&color=25D366)](https://github.com/ahmadmcer/opencode-mcp-whatsapp/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)](package.json)
[![Tools](https://img.shields.io/badge/tools-41-8A2BE2.svg)](docs/REFERENCE.md)
[![Built on Baileys](https://img.shields.io/badge/built%20on-Baileys-25D366.svg)](https://github.com/WhiskeySockets/Baileys)

An interactive installer that adds a **local WhatsApp MCP server** to your
[OpenCode](https://opencode.ai) setup. Once linked, your agent can send and
receive WhatsApp messages, read & search chat history, react/reply/edit/delete,
send files, locations, contacts and polls, download media, and manage groups,
contacts, and chats — through 41 tools exposed over the Model Context Protocol.

It's built on [Baileys](https://github.com/WhiskeySockets/Baileys) (an
unofficial WhatsApp Web library) and runs entirely on your machine.

> [!WARNING]
> **Use a number you can afford to lose, and keep volume low.** This automates
> WhatsApp through an unofficial library. Heavy or bursty activity — bulk sends,
> rapid group/profile changes, stress-testing many tools back-to-back, repeated
> re-links — can trigger WhatsApp's anti-spam system and get your **linked device
> restricted** (often 7 days) or, if you push it, the account banned. Prefer a
> spare/burner number, especially for testing. The server ships conservative
> defaults (5 sends/60s and a 1s minimum gap between *all* operations), but they
> only reduce the risk — they don't eliminate it.

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

- `mcp-whatsapp/` — the MCP server (`index`, `store`, `messages`, `historyStore`,
  `tools`, `resources`, `utils`, `policy`, plus unit tests), dropped into your
  OpenCode config dir.
- A `whatsapp` entry in the `mcp` block of your `opencode.jsonc`:

  ```json
  {
    "mcp": {
      "whatsapp": {
        "type": "local",
        "command": ["npx", "-y", "tsx", "index.ts"],
        "cwd": "<config-dir>/mcp-whatsapp",
        "enabled": true,
        "environment": { "WHATSAPP_SEND_MAX": "3" }
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

**History & search** (persistent — survives restarts, stored under `whatsapp-store/`)

| Tool | What it does |
|---|---|
| `load_messages` | Read a chat's stored messages (with paging via `before`). |
| `search_messages` | Case-insensitive substring search across stored messages. |
| `chats` | List all known chats (from history sync + activity), most recent first. |
| `contacts` | List contacts captured from history sync. |
| `messages_upsert` | Live in-memory view of messages seen since connect (with ids). |
| `fetch_message_history` | Best-effort on-demand pull of older messages (WhatsApp often ignores it for linked devices). |

**Group management** (write-capable, rate-limited; most require admin)

| Tool | What it does |
|---|---|
| `group_create` | Create a group with a subject and participants. |
| `group_participants_update` | Add / remove / promote / demote members. |
| `group_update` | Change a group's subject and/or description. |
| `group_setting_update` | Announce-only / open posting, locked / unlocked info. |
| `group_invite` | Get or revoke the group invite link. |
| `group_accept_invite` | Join a group by invite code or link. |
| `group_get_invite_info` | Preview a group from an invite without joining. |
| `group_metadata` / `group_fetch_all_participating` | Inspect one group / list all groups. |
| `group_leave` | Leave a group (irreversible). |

**Contacts & discovery**

| Tool | What it does |
|---|---|
| `on_whatsapp` | Check whether numbers are registered on WhatsApp (and get JIDs). |
| `update_block_status` | Block or unblock a contact. |
| `fetch_blocklist` | List blocked contacts. |
| `get_business_profile` | Fetch a WhatsApp Business profile. |
| `fetch_status` | A contact's About text. |
| `profile_picture_url` | Profile-picture URL for a contact or group. |
| `presence_subscribe` | Subscribe to and read a contact's presence. |

**Chat & profile management**

| Tool | What it does |
|---|---|
| `chat_modify` | Mute / archive / pin / mark read / delete a chat. |
| `star_message` | Star or unstar a message. |
| `read_messages` | Mark a received message as read. |
| `send_presence_update` | Send typing/recording/online/offline presence. |
| `download_media_message` | Download a received message's media (write-sandboxed). |
| `update_profile` | Set your own name / About text. |
| `update_profile_picture` | Set (from a sandboxed image) or remove your picture. |

**Connection**

| Tool | What it does |
|---|---|
| `login_qr` | Show the pending linking QR as scannable ASCII, in the TUI. |
| `relink` | Reconnect in-process — optionally wipe for a fresh QR, no OpenCode restart. |
| `connection_state` | Connection state, your JID, QR path, policy, and history stats. |

Message-action tools (`send_reaction`, `edit_message`, `delete_message`,
`read_messages`, `download_media_message`, `star_message`) take a `message_id`
from `messages_upsert` or `load_messages`. Sends are gated by the recipient
allowlist + rate limit; other mutating tools consume a rate-limit token.

### Reading chat history

After linking, WhatsApp syncs a **limited recent window** of history to the
device (recent months, not the full archive). That sync plus every message seen
afterward is stored in a persistent, searchable log under
`~/.config/opencode/whatsapp-store/`, so `load_messages` / `search_messages` /
`chats` work across restarts. `fetch_message_history` can *ask* for older messages
but WhatsApp frequently ignores on-demand requests from linked devices, so treat
it as best-effort.

### Resources

Besides tools, the server exposes read-only **MCP resources** (browsable via
`list_mcp_resources` / readable by URI), so a client can pull WhatsApp state into
context without a tool call:

| URI | Contents |
|---|---|
| `whatsapp://connection` | Connection status, your JID, history-sync mode, stored counts. |
| `whatsapp://chats` | Known chats, most recent first. |
| `whatsapp://contacts` | Contacts from history sync. |
| `whatsapp://messages/recent` | Live messages seen since connect. |
| `whatsapp://chat/{jid}` | Stored history for one chat (templated; the chat list enumerates them). |

## Linking your phone (one time)

1. Start (or restart) `opencode` so the server connects.
2. Ask the agent to run **`login_qr`** — it prints the QR as scannable ASCII right
   in the TUI. (It's also saved as an image at `~/.config/opencode/whatsapp/qr.png`.)
3. Scan it in **WhatsApp → Settings → Linked Devices → Link a device**. The code
   refreshes periodically — re-run `login_qr` if it expires.
4. Ask the agent to run `connection_state` — it should report `Connected: yes`.

The session is cached, so you only scan once. Reconnects are automatic. The linked
device shows up as **OpenCode** in WhatsApp → Settings → Linked Devices, so it's
easy to spot (and revoke) among your other sessions.

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
  `WHATSAPP_SEND_WINDOW_MS` (default **5 / 60s**), shared by every message-producing
  tool. Other mutating tools (group/chat/profile/block changes) also consume a
  token, so a runaway agent loop can't spam actions.
- **Global action pacing.** Every WhatsApp operation — sends *and* reads like
  `on_whatsapp`/group lookups — is serialized with a minimum gap
  (`WHATSAPP_MIN_ACTION_GAP_MS`, default **1000ms**; set `0` to disable). This
  smooths bursts, which are a key signal WhatsApp's anti-automation uses.
- **History is local & git-ignored.** The stored message log lives in
  `~/.config/opencode/whatsapp-store/` (personal data) — the installer adds it to
  your config dir's `.gitignore` alongside the session, so it's never committed.
- **Your phone keeps notifying.** The server connects with
  `markOnlineOnConnect: false`, so an agent being connected doesn't mute your
  phone's WhatsApp notifications.

These are configurable during install and afterward via the `environment` block.
Full detail: [`docs/REFERENCE.md`](docs/REFERENCE.md).

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
