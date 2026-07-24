// Minimal, string-aware JSONC -> value parser. opencode.jsonc is JSON plus
// `//` and `/* */` comments and trailing commas; JSON.parse rejects all three.
// We strip them (respecting string literals so a `//` or comma inside a string
// is never touched) and hand the result to JSON.parse. No dependency, and the
// caller always backs up the original file first, so a parse miss is recoverable.
//
// Only double-quoted strings are recognized, which is all valid JSONC allows.

export function stripComments(input) {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    const next = input[i + 1];
    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i++;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

export function stripTrailingCommas(input) {
  let out = "";
  let inString = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += input[i + 1] ?? "";
        i++;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j])) j++;
      if (input[j] === "}" || input[j] === "]") continue; // drop the trailing comma
    }
    out += c;
  }
  return out;
}

export function parseJsonc(input) {
  return JSON.parse(stripTrailingCommas(stripComments(input)));
}

export function hasComments(input) {
  return stripComments(input) !== input;
}
