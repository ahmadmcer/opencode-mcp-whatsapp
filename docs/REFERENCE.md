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
│   ├── tools.ts            # the five MCP tools + policy enforcement
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
| `WHATSAPP_SEND_ROOT` | `~/Downloads` + `~/.config/opencode/whatsapp-outbox` | OS-path-separated list of directories `send_file` may read from. |

Edit these any time in the `environment` block of the `whatsapp` server and
restart OpenCode. The `status` tool prints the effective values.

## Tools

### `send`
Input: `to` (phone number `+xxx` or JID), `message` (1–4096 chars).
Resolves the JID, checks the allowlist, consumes a rate-limit token, then sends.
Returns the sent message id, or an `isError` result if not connected / denied /
rate-limited / the send throws.

### `send_file`
Input: `to`, `filePath`.
`filePath` must resolve (after normalization, defeating `..` traversal) inside a
`WHATSAPP_SEND_ROOT` directory, and must not be inside the auth dir. Routed to
`image` / `video` / `document` by extension.

### `status`
No input. Reports connection state, your JID, auth dir, QR path + mtime/size,
send roots, allowlist, rate limit, and the last error if any.

### `recent_messages` / `list_chats`
Input: optional `limit` (1–200, default 30). Both read from an in-memory buffer
populated since the server connected; they do not backfill history. `recent` is
capped at 200 messages, `chatMap` at 200 chats (LRU-evicted).

## Resilience

- **Reconnection.** On a dropped socket the server reconnects with exponential
  backoff (1s → 30s cap), resetting on a successful open. A `loggedOut` close is
  terminal — it tells you to delete the auth dir and re-link rather than looping.
- **Startup decoupling.** The MCP transport comes up first; WhatsApp connects in
  the background. WhatsApp being down never makes the MCP itself unavailable —
  `status` still answers and surfaces the last error.
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
