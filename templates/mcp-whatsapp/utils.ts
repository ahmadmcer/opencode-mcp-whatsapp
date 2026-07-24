import { resolve, relative, isAbsolute } from "node:path"

export function toJid(input: string): string {
  const trimmed = input.trim()
  if (trimmed.includes("@")) return trimmed
  const digits = trimmed.replace(/\D/g, "")
  if (digits.length < 7) throw new Error(`Invalid phone: ${input}`)
  return `${digits}@s.whatsapp.net`
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
 * Throws otherwise. This is the sandbox that stops `send_file` from being
 * an arbitrary-file-read primitive.
 */
export function resolveWithinRoots(roots: string[], p: string): string {
  const abs = resolve(p)
  if (roots.some((r) => isInside(r, abs))) return abs
  throw new Error(
    `filePath is outside the allowed send directories (${roots.join(", ")}). ` +
      `Set WHATSAPP_SEND_ROOT to allow another location.`,
  )
}
