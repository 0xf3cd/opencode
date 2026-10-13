import { Option, Schema } from "effect"

// The iOS app's voice calls prompt a session as `<header>\n<JSON body>`, optionally followed by
// `Attached file:` lines. The header's wording may change; its opening and the body's shape won't.
const decodeBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      instruction: Schema.String,
      voice: Schema.optional(Schema.String),
      call_log_attached: Schema.optional(Schema.Boolean),
    }),
  ),
)

const attachedFile = /^Attached file: `.*`$/

/**
 * A prompt a voice call delegated, read back for display: the voice agent's framing of the request,
 * or the user's own words when it has none. Undefined for any other prompt, including one that only
 * mentions a voice delegation.
 */
export function parseVoiceDelegation(text: string) {
  if (!text.startsWith("Voice delegation.") && !text.startsWith("Voice delegation (continued).")) return
  const newline = text.indexOf("\n")

  if (newline < 0) return

  const lines = text.slice(newline + 1).split("\n")
  const trailing = lines.findLastIndex((line) => line.trim() !== "" && !attachedFile.test(line.trim())) + 1

  return Option.getOrUndefined(
    Option.flatMap(decodeBody(lines.slice(0, trailing).join("\n")), (body) => {
      const instruction = body.instruction.trim()

      if (!instruction) return Option.none()

      return Option.some({
        text: body.voice?.trim() || instruction,
        // The app attaches the call log as an uploaded `voice-call-….json` file.
        callLogAttached:
          body.call_log_attached === true || lines.slice(trailing).some((line) => line.includes("voice-call-")),
      })
    }),
  )
}

export type VoiceDelegation = NonNullable<ReturnType<typeof parseVoiceDelegation>>
