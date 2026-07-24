# Reference

Everything the installer sets up, and why it's shaped this way.

## Layout after install

```
~/.config/opencode/
├── opencode.jsonc          # gains an mcp.whatsapp entry (backed up first)
├── mcp-whatsapp/           # the server (copied from templates/)
│   ├── index.ts            # entry: brings up MCP transport, then WhatsApp in the background
│   ├── store.ts            # Baileys socket, auth, QR, reconnection with backoff
│   ├── messages.ts         # in-memory ingestion of inbound messages (bounded)
│   ├── tools.ts            # the MCP tools + policy enforcement
│   ├── policy.ts           # recipient allowlist + send rate limiter
│   ├── utils.ts            # pure helpers (JID parsing, path sandbox)
│   ├── *.test.ts           # unit tests (run with `npm test`)
│   └── package.json
└── whatsapp/               # created at first run — session creds + qr.png (git-ignored)
```

## The server entry

```json
{
  "type": "local",
  "command": ["npx", "-y", "tsx", "index.ts"],
  "cwd": "<config-dir>/mcp-whatsapp",
  "enabled": true,
  "environment": { ... }
}
```

- **`tsx`** runs the TypeScript directly — no build step. It's also pinned as a
  local devDependency, so after `npm install` the `npx` call resolves the local
  copy instead of re-downloading it each launch.
- **`cwd`** is absolute and uses forward slashes; OpenCode's own resolver reads
  this string, and backslashes from `path.join` on Windows can break it.
- **`environment`** carries the policy knobs (below). Only non-default values are
  written, so the block stays minimal.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `WHATSAPP_ALLOWED_RECIPIENTS` | unset → all allowed | Comma / `;` / newline list of phone numbers or JIDs permitted as send targets. Numbers are normalized to `<digits>@s.whatsapp.net`. |
| `WHATSAPP_SEND_MAX` | `10` | Maximum sends per window. |
| `WHATSAPP_SEND_WINDOW_MS` | `60000` | Rate-limit window, in milliseconds. |
| `WHATSAPP_SEND_ROOT` | `~/Downloads` + `~/.config/opencode/whatsapp-outbox` | OS-path-separated list of directories `send_media` may read from and `download_media_message` may write to. |

Edit these any time in the `environment` block of the `whatsapp` server and
restart OpenCode. The `connection_state` tool prints the effective values.

## Tools

Tool names mirror the Baileys calls behind them (snake_cased). Tools flagged
**[gated]** run the recipient allowlist and consume a shared send-rate-limit token
before sending. Message-action tools take a `message_id` from `messages_upsert`;
only messages seen since the server connected can be referenced (in-memory). This
includes the session's **own** sent messages: each successful send records its
result into the same buffer, so `edit_message` / `delete_message` / `send_reaction`
and `quoted_message_id` can target a message the MCP just sent (Baileys does not
echo our own sends back through `messages.upsert`, so they are recorded on send).

### Messaging

- **`send_message`** *[gated]* — `to` (phone `+xxx` or JID), `message` (1–4096),
  optional `quoted_message_id` (reply). Returns the sent message id, or an
  `isError` result if not connected / denied / rate-limited / the send throws.
- **`send_media`** *[gated]* — `to`, `filePath`, optional `quoted_message_id`.
  `filePath` must resolve (after normalization, defeating `..` traversal) inside a
  `WHATSAPP_SEND_ROOT` directory and outside the auth dir. Routed to
  `image` / `video` / `document` by extension.
- **`send_reaction`** *[gated]* — `message_id`, `emoji` (empty removes the reaction).
- **`edit_message`** *[gated]* — `message_id` (must be your own), `new_text`.
- **`delete_message`** *[gated]* — `message_id`. Revoke-for-everyone only for your
  own messages.
- **`send_location`** *[gated]* — `to`, `latitude` (−90..90), `longitude`
  (−180..180), optional `name` / `address`.
- **`send_contact`** *[gated]* — `to`, `contact_name`, `contact_phone` (built into a
  vCard, phone normalized).
- **`send_poll`** *[gated]* — `to`, `name`, `options` (2–12), optional
  `selectable_count` (default 1, clamped to the option count).

### Chat state & media

- **`read_messages`** — `message_id`. Sends a read receipt (`sock.readMessages`).
  Allowlist-checked on the chat; not rate-limited.
- **`send_presence_update`** — `to`, `state` ∈
  `composing|recording|paused|available|unavailable`. Not rate-limited.
- **`download_media_message`** — `message_id` (must carry media), optional
  `dest_dir` (default: first send root) and `filename`. The destination is
  re-checked against `WHATSAPP_SEND_ROOT` (and refuses the auth dir), so it can
  only write inside the sandbox. Filename comes from `filename` (basename only),
  the document's own name, or a generated `whatsapp-<id>.<ext>`. Not rate-limited.

### Discovery

- **`group_fetch_all_participating`** — no input. Lists groups (id, subject,
  participant count).
- **`group_metadata`** — `jid` (…@g.us). Subject, description, owner, participants
  with admin flags.
- **`profile_picture_url`** — `to`. Returns the picture URL, or a friendly message
  when none is set / not visible.
- **`login_qr`** — no input. Renders the pending linking QR as scannable ASCII in
  the terminal (via `qrcode-terminal`). Returns "already connected" when linked, or
  guidance when no QR is pending yet. The raw QR is also written to `qr.png`.
- **`relink`** — optional `wipe` (default false). Reconnects the socket in-process,
  so re-linking never needs an OpenCode restart. `wipe: true` deletes the stored
  session first (use after a `loggedOut` state or to switch numbers) and a fresh QR
  follows — show it with `login_qr`. `wipe: false` reconnects with the existing
  session (reclaim a stepped-aside link, or retry). See Resilience below.
- **`connection_state`** — no input. Connection state, your JID, auth dir, QR path +
  mtime/size, send roots, allowlist, rate limit, and the last error if any.
- **`messages_upsert`** / **`chats`** — optional `limit` (1–200, default 30). Both
  read from an in-memory buffer populated since connect; no history backfill.
  `recent` is capped at 200 messages, `chatMap` at 200 chats (LRU-evicted), and a
  bounded id→raw-message map (200) backs `message_id` lookups. `messages_upsert`
  now captures caption-less media (shown as `[image]`/`[video]`/… with the id) so
  it can be reacted to, replied to, or downloaded, and also lists this session's
  own sent messages (marked from `me`) so they can be edited or deleted.

## Resilience

- **Reconnection.** On a dropped socket the server reconnects with exponential
  backoff (1s → 30s cap), resetting on a successful open. A `loggedOut` close is
  terminal — reconnecting with dead creds would loop forever — so it stops and
  points you at the `relink` tool.
- **Re-linking without a restart (`relink`).** Deleting the auth dir from outside
  does nothing to a running server: it stopped on logout and holds no live socket
  to notice. The `relink` tool fixes this in-process — it cancels any pending
  reconnect, tears down the socket, optionally wipes the session (`wipe: true`), and
  re-initializes, so a fresh QR appears (via `login_qr`) with no OpenCode restart.
- **Multiple instances / `connectionReplaced`.** Every `opencode` process starts
  its own server, but WhatsApp permits only one live socket per link. When a newer
  session connects, the older socket receives a `connectionReplaced` (440) close.
  The server treats this as terminal and **steps aside** instead of reconnecting —
  reconnecting would reclaim the link and kick the newer session, a ping-pong that
  WhatsApp flags and that used to invalidate the session and force a fresh QR.
  `connection_state` reports the step-aside; restart that instance to reclaim the
  link. The linked session on disk is untouched, so a normal cold start reuses it
  (no re-scan).
- **Startup decoupling.** The MCP transport comes up first; WhatsApp connects in
  the background. WhatsApp being down never makes the MCP itself unavailable —
  `connection_state` still answers and surfaces the last error.
- **Logging.** Baileys `warn`/`error`/`fatal` go to **stderr** (never stdout,
  which is the MCP JSON-RPC channel); `info`/`debug` are silenced.

## Keeping the session out of git

The linked WhatsApp session is written to `<config-dir>/whatsapp/` — a sibling of
`mcp-whatsapp/`. Those files authenticate the account, so committing them is an
account-takeover risk. Two things guard against it:

- `mcp-whatsapp/.gitignore` (shipped with the server) ignores its own
  `node_modules/` and `*.bak`.
- The installer idempotently adds `whatsapp/` and `*.bak` to
  `<config-dir>/.gitignore` (creating it if absent, appending only missing lines
  under a labeled section) so a version-controlled config dir never picks up the
  session or the installer's backups.

## How the installer edits opencode.jsonc

The existing file is parsed as JSONC (comments and trailing commas tolerated,
string-aware so nothing inside a string is touched) and rewritten as plain JSON
after injecting `mcp.whatsapp`. Valid JSON is valid JSONC, so this is safe — but
any comments you had survive only in the `.bak`. If the file can't be parsed, the
installer leaves it untouched and tells you to add the entry by hand.

## Contributing

`templates/mcp-whatsapp/` is the source of truth for the installed server — it's
a verbatim copy of a working MCP. If you change the server, change it there. The
installer copies every file in that folder, so adding a file needs no installer
change.
