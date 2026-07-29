// WhatsApp text formatting helpers. Ported from whatsapp-persona-bot's
// src/utils/formatter.ts so MCP can (a) strip LLM artefacts like <think> or
// [fact:...] when rendering chat history, and (b) accept raw model output
// when the agent opts into auto-formatting on send_message.

/**
 * Strip noise from an LLM response and normalise it for WhatsApp's flavour
 * of Markdown:
 *   - drop `<think>…</think>` and `<reasoning>…</reasoning>` blocks
 *   - drop ``` fenced code blocks
 *   - drop `[fact:…]` markers the persona-bot writes for its own memory
 *   - convert `**bold**` → `*bold*` (WA uses single asterisks)
 *   - strip leading `#`/`##`/… heading markers (lines start with `#+ `)
 *   - trim whitespace
 */
export function formatWhatsAppText(text: string): string {
  let result = text

  result = result.replace(/\*\*(.+?)\*\*/g, "*$1*")

  result = result.replace(/^#+\s+(.+)$/gm, "$1")

  result = result.replace(/```[\s\S]*?```/g, "")

  result = result.replace(/\[fact:.+?\]/g, "")

  result = result.replace(/<think>[\s\S]*?<\/think>/gi, "").trim()

  result = result.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "").trim()

  result = result.trim()

  return result
}

/**
 * Split long text into ≤ maxLen chunks at sentence boundaries. WhatsApp
 * caps text messages around 65k characters in practice, and shorter chunks
 * read more naturally as multiple bubbles. Splits on `.`, `!`, `?` or newlines.
 */
export function chunkMessage(text: string, maxLen = 4096): string[] {
  if (text.length <= maxLen) return [text]

  const chunks: string[] = []
  const sentences = text.match(/[^.!?\n]+[.!?\n]*/g) || [text]
  let current = ""

  for (const sentence of sentences) {
    if ((current + sentence).length > maxLen) {
      if (current.trim()) chunks.push(current.trim())
      current = sentence
    } else {
      current += sentence
    }
  }
  if (current.trim()) chunks.push(current.trim())
  return chunks
}

/**
 * Split text into WhatsApp-style "bubbles" separated by `\n\n`. Keeps
 * numbered/bulleted lists merged with the preceding paragraph so the list
 * doesn't get its own bubble (which reads oddly on mobile).
 */
export function splitBubbles(text: string): string[] {
  const segments = text.split(/\n\n+/).filter((s) => s.trim().length > 0)
  if (segments.length <= 1) return segments

  const result: string[] = []
  let current = segments[0]

  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i]
    const trimmed = seg.trim()

    const isListItem = /^\s*\d+[.)]\s/.test(trimmed) || /^\s*[-*]\s+/.test(trimmed)
    const prevEndsWithColon = current.trim().endsWith(":")

    if (isListItem || prevEndsWithColon) {
      current += "\n\n" + seg
    } else {
      result.push(current.trim())
      current = seg
    }
  }
  result.push(current.trim())

  return result.filter((s) => s.length > 0)
}