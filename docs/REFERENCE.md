# Reference

Everything the installer sets up, and why it's shaped this way.

## Layout after install

```
~/.config/opencode/
├── opencode.jsonc          # gains an mcp.whatsapp entry (backed up first)
├── mcp-whatsapp/           # the server (copied from templates/)
│   ├── index.ts            # entry: brings up MCP transport, then WhatsApp in the background
│   ├── store.ts            # Baileys socket, auth, QR, reconnection with backoff
│   ├── messages.ts         # live in-memory ingestion (raw buffer for action tools)
│   ├── historyStore.ts     # persistent, searchable message log (JSON)
│   ├── tools.ts            # the MCP tools + policy enforcement
│   ├── policy.ts           # recipient allowlist + send rate limiter
│   ├── utils.ts            # pure helpers (JID parsing, path sandbox)
│   ├── *.test.ts           # unit tests (run with `npm test`)
│   └── package.json
├── whatsapp/               # created at first run — session creds + qr.png (git-ignored)
└── whatsapp-store/         # persisted chat history — history.json (git-ignored, personal data)
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
| `WHATSAPP_SYNC_FULL_HISTORY` | `true` | Ask WhatsApp for the fuller history window on link. Set `false` for a lighter, recent-only sync. |
| `WHATSAPP_HISTORY_MAX` | `20000` | Max messages kept in the persistent history store (oldest evicted). |

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
- **`messages_upsert`** — optional `limit` (1–200, default 30). Live in-memory view
  since connect (raw buffer capped at 200; id→raw map (200) backs `message_id`
  lookups). Captures caption-less media (`[image]`/`[video]`/…) and this session's
  own sends (marked from `me`).
- **`connection_state`** — no input. Connection state, your JID, auth dir, QR path +
  mtime/size, send roots, allowlist, rate limit, history-sync mode + stored counts,
  and the last error if any.

### History & search (persistent)

Backed by `historyStore.ts` — a JSON log at `whatsapp-store/history.json`, loaded
on boot and saved debounced. Populated from the `messaging-history.set` sync on
link and from every live/sent message. Bounded per-chat (1000) and globally
(`WHATSAPP_HISTORY_MAX`).

- **`load_messages`** — `chat` (phone/JID), `limit`, optional `before` (unix-seconds cursor to page older). Chronological, with ids.
- **`search_messages`** — `query`, optional `chat`, `limit`. Case-insensitive substring, newest first.
- **`chats`** — `limit`. All known chats (history + activity), most recent first.
- **`contacts`** — `limit`. Contacts from history sync.
- **`fetch_message_history`** — `chat`, `count`. Best-effort on-demand pull of older
  messages via `sock.fetchMessageHistory` using the oldest stored message as the
  cursor. WhatsApp often ignores this for linked devices; any results arrive
  asynchronously into the store. Rate-limited.

### Group management (rate-limited; most require admin)

`group_create` (subject, participants[]), `group_participants_update` (jid, participants[], action: add|remove|promote|demote), `group_update` (jid, subject?/description?), `group_setting_update` (jid, setting: announcement|not_announcement|locked|unlocked), `group_invite` (jid, action: get|revoke → `chat.whatsapp.com` link), `group_accept_invite` (code/link), `group_get_invite_info` (code), `group_leave` (jid, irreversible), plus `group_metadata` / `group_fetch_all_participating` (read).

### Contacts & discovery

`on_whatsapp` (numbers[] → registered + JID), `update_block_status` (to, block|unblock), `fetch_blocklist`, `get_business_profile` (to), `fetch_status` (to → About text), `profile_picture_url` (to), `presence_subscribe` (to; subscribes and returns cached presence from the `presence.update` handler).

### Chat & profile management

`chat_modify` (to, action: mute|unmute|archive|unarchive|pin|unpin|mark_read|mark_unread|delete, `mute_hours?`; resolves the chat's last stored message for the actions that need it), `star_message` (message_id, star), `update_profile` (name?/status?), `update_profile_picture` (sandboxed image path, or `remove: true`; targets your own JID). All rate-limited; `delete`/`group_leave`/`update_block_status`/picture-remove are destructive.

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
- **Performance/reliability tuning.** The socket sets `markOnlineOnConnect: false`
  (so being connected doesn't mute the phone's notifications), and uses three
  Baileys-recommended caches (via `node-cache`): `cachedGroupMetadata` (refreshed on
  `groups.update`) so group sends don't re-fetch the participant list every time —
  the refetch is rate-limited and a ban vector; `getMessage` (served from the raw
  buffer) for message-retry resend and poll-vote decryption; and `msgRetryCounterCache`
  to avoid retry loops.
- **History caveats.** WhatsApp only syncs a **limited recent window** to a linked
  device — the store can't hold a chat's entire archive. On-demand
  `fetch_message_history` is **best-effort**: WhatsApp frequently drops it for
  companion devices. Persisted history lives in `whatsapp-store/` (a sibling of the
  auth dir), so `relink { wipe: true }` does not erase it.

## Keeping the session and history out of git

The linked WhatsApp session is written to `<config-dir>/whatsapp/`, and the
persisted chat history to `<config-dir>/whatsapp-store/` — both siblings of
`mcp-whatsapp/`. The session authenticates the account (committing it is an
account-takeover risk) and the history is personal message data. Two things guard
against committing either:

- `mcp-whatsapp/.gitignore` (shipped with the server) ignores its own
  `node_modules/` and `*.bak`.
- The installer idempotently adds `whatsapp/`, `whatsapp-store/`, and `*.bak` to
  `<config-dir>/.gitignore` (creating it if absent, appending only missing lines
  under a labeled section) so a version-controlled config dir never picks up the
  session, the message log, or the installer's backups.

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
