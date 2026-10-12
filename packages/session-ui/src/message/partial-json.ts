const escapes = new Map([
  ['"', '"'],
  ["\\", "\\"],
  ["/", "/"],
  ["b", "\b"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
])

/**
 * The top-level string fields of a JSON object that may still be streaming. A string cut off mid-stream keeps its
 * decoded prefix, so a renderer can show an argument as the model writes it. Fields after the cut, and values that are
 * not strings, are left out.
 */
export function partialStringFields(raw: string): Record<string, string> {
  const fields = new Map<string, string>()
  const cursor = { index: raw.indexOf("{") + 1 }

  if (cursor.index === 0) return {}

  const whitespace = () => {
    while (/[\s,]/u.test(raw.charAt(cursor.index))) cursor.index++
  }

  // Reads the string starting at the opening quote under the cursor.
  const string = () => {
    const parts: string[] = []
    cursor.index++

    while (cursor.index < raw.length) {
      const char = raw.charAt(cursor.index)

      if (char === '"') {
        cursor.index++

        return { value: parts.join(""), closed: true }
      }

      if (char !== "\\") {
        parts.push(char)
        cursor.index++
        continue
      }

      const next = raw.charAt(cursor.index + 1)

      if (next === "u") {
        const hex = raw.slice(cursor.index + 2, cursor.index + 6)

        if (!/^[0-9a-fA-F]{4}$/u.test(hex)) break
        parts.push(String.fromCharCode(Number.parseInt(hex, 16)))
        cursor.index += 6
        continue
      }

      const escaped = escapes.get(next)

      if (escaped === undefined) break
      parts.push(escaped)
      cursor.index += 2
    }

    return { value: parts.join(""), closed: false }
  }

  // Skips a non-string value, stopping before the comma or brace that ends it.
  const skip = () => {
    const depth = { value: 0 }

    while (cursor.index < raw.length) {
      const char = raw.charAt(cursor.index)

      if (char === '"') {
        string()
        continue
      }

      if (char === "{" || char === "[") depth.value++

      if (char === "}" || char === "]") {
        if (depth.value === 0) return
        depth.value--
      }

      if (char === "," && depth.value === 0) return
      cursor.index++
    }
  }

  while (cursor.index < raw.length) {
    whitespace()

    if (raw.charAt(cursor.index) !== '"') break
    const key = string()

    if (!key.closed) break
    whitespace()

    if (raw.charAt(cursor.index) !== ":") break
    cursor.index++
    whitespace()

    if (cursor.index >= raw.length) break

    if (raw.charAt(cursor.index) !== '"') {
      skip()
      continue
    }

    const value = string()
    fields.set(key.value, value.value)

    if (!value.closed) break
  }

  return Object.fromEntries(fields)
}
