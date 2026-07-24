import { resolve, relative, isAbsolute } from "node:path"

export function toJid(input: string): string {
  const trimmed = input.trim()
  if (trimmed.includes("@")) return trimmed
  const digits = trimmed.replace(/\D/g, "")
  if (digits.length < 7) throw new Error(`Invalid phone: ${input}`)
  return `${digits}@s.whatsapp.net`
}

/**
 * Build a minimal vCard for `send_contact`. The phone is normalized to digits and
 * carries the WhatsApp `waid` parameter so the recipient can tap-to-chat. Values
 * are escaped per RFC 6350 so a comma/semicolon/newline in the name can't break
 * the card structure.
 */
export function buildVcard(displayName: string, phone: string): string {
  const digits = phone.replace(/\D/g, "")
  if (digits.length < 7) throw new Error(`Invalid contact phone: ${phone}`)
  const name = (displayName || "Contact").trim() || "Contact"
  const esc = (s: string) => s.replace(/([\\,;])/g, "\\$1").replace(/\n/g, "\\n")
  return [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `FN:${esc(name)}`,
    `TEL;type=CELL;type=VOICE;waid=${digits}:+${digits}`,
    "END:VCARD",
  ].join("\n")
}

export function isAbsolutePath(p: string): boolean {
  return p.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\")
}

export function filenameOf(p: string): string {
  return p.split(/[\\/]/).pop() || "file"
}

/**
 * True when `p` resolves to `base` itself or a path nested inside it.
 * Normalizes both sides first, so `..` traversal and mixed separators
 * cannot escape the base. Used for both allow-listing and deny-listing.
 */
export function isInside(base: string, p: string): boolean {
  const rel = relative(resolve(base), resolve(p))
  return !rel.startsWith("..") && !isAbsolute(rel)
}

/**
 * Resolve `p` to an absolute path only if it lives under one of `roots`.
 * Throws otherwise. This is the sandbox that stops `send_media` /
 * `download_media_message` from being arbitrary-file read/write primitives.
 */
export function resolveWithinRoots(roots: string[], p: string): string {
  const abs = resolve(p)
  if (roots.some((r) => isInside(r, abs))) return abs
  throw new Error(
    `filePath is outside the allowed send directories (${roots.join(", ")}). ` +
      `Set WHATSAPP_SEND_ROOT to allow another location.`,
  )
}
