const marks = [
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  ",",
  ":",
  "?",
  "=",
  "+",
  "-",
  "*",
  "/",
  "%",
  "<",
  ">",
  "!",
] as const

export type Mark = (typeof marks)[number]

export type Token =
  | { readonly kind: "name"; readonly value: string }
  | { readonly kind: "state"; readonly value: string }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "mark"; readonly value: Mark }

const number = /\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y
const name = /[A-Za-z_][A-Za-z0-9_]*/y
const escapes: Readonly<Record<string, string>> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", "0": "\0" }

/**
 * The tokens of one statement. A string still open at the end, as in a statement that is still streaming, ends the
 * tokens and sets `open`; `error` names the first character that starts no token.
 */
export function tokenize(source: string): {
  readonly tokens: readonly Token[]
  readonly open: boolean
  readonly error?: string
} {
  const tokens: Token[] = []
  let index = 0

  while (index < source.length) {
    const char = source.charAt(index)

    if (/\s/u.test(char)) {
      index++
      continue
    }

    if (char === "#" || source.startsWith("//", index)) {
      const end = source.indexOf("\n", index)
      index = end === -1 ? source.length : end
      continue
    }

    if (char === '"' || char === "'") {
      const string = readString(source, index)
      tokens.push({ kind: "string", value: string.value })
      if (string.open) return { tokens, open: true }
      index = string.end
      continue
    }

    const digits = match(number, source, index)
    if (digits) {
      tokens.push({ kind: "number", value: Number(digits) })
      index += digits.length
      continue
    }

    const word = match(name, source, char === "$" ? index + 1 : index)
    if (word) {
      tokens.push(char === "$" ? { kind: "state", value: `$${word}` } : { kind: "name", value: word })
      index += word.length + (char === "$" ? 1 : 0)
      continue
    }

    const mark = marks.find((candidate) => source.startsWith(candidate, index))
    if (!mark) return { tokens, open: false, error: `Unexpected character ${JSON.stringify(char)}` }
    tokens.push({ kind: "mark", value: mark })
    index += mark.length
  }

  return { tokens, open: false }
}

function match(pattern: RegExp, source: string, index: number) {
  pattern.lastIndex = index
  return pattern.exec(source)?.[0]
}

function readString(source: string, start: number) {
  const quote = source.charAt(start)
  const parts: string[] = []
  let index = start + 1

  while (index < source.length) {
    const char = source.charAt(index)
    if (char === quote) return { value: parts.join(""), end: index + 1, open: false }
    if (char === "\n") break
    if (char !== "\\") {
      parts.push(char)
      index++
      continue
    }
    const next = source.charAt(index + 1)
    if (next === "u") {
      const hex = source.slice(index + 2, index + 6)
      // A `\u` escape cut off mid-stream ends the string for now; it completes on the next update.
      if (!/^[0-9a-fA-F]{4}$/u.test(hex)) break
      parts.push(String.fromCharCode(Number.parseInt(hex, 16)))
      index += 6
      continue
    }
    if (!next) break
    parts.push(escapes[next] ?? next)
    index += 2
  }

  return { value: parts.join(""), end: source.length, open: true }
}
