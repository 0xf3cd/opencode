import { describe, expect, test } from "bun:test"
import { parseVoiceDelegation } from "./voice-delegation"

const body = (value: {
  instruction: string
  voice?: string
  call_log_attached?: boolean
  transcript_delta?: string[]
}) => JSON.stringify(value, null, 2)

describe("parseVoiceDelegation", () => {
  test.each([
    {
      name: "shows the voice agent's framing",
      text: `Voice delegation. Header wording.\n${body({ instruction: "uh check the upload test", transcript_delta: [], voice: "Checking the upload test." })}`,
      expected: { text: "Checking the upload test.", callLogAttached: false },
    },
    {
      name: "falls back to the user's words without framing",
      text: `Voice delegation (continued). Same fields as before.\n${body({ instruction: "  Open a PR.  ", transcript_delta: [], voice: " " })}`,
      expected: { text: "Open a PR.", callLogAttached: false },
    },
    {
      name: "reads an attached call log from the body",
      text: `Voice delegation (continued). Same fields as before.\n${body({ call_log_attached: true, instruction: "Open a PR." })}`,
      expected: { text: "Open a PR.", callLogAttached: true },
    },
    {
      name: "reads an attached call log from a trailing file reference",
      text: `Voice delegation. Header.\n${body({ instruction: "Open a PR." })}\nAttached file: \`/tmp/a.png\`\nAttached file: \`/tmp/voice-call-1.json\`\n`,
      expected: { text: "Open a PR.", callLogAttached: true },
    },
    {
      name: "ignores prose mentioning a delegation",
      text: "Voice delegation. Please explain how it works.",
      expected: undefined,
    },
    { name: "ignores a header before non-JSON text", text: "Voice delegation.\nnot json", expected: undefined },
    {
      name: "ignores an empty instruction",
      text: `Voice delegation.\n${body({ instruction: " ", voice: "Hi" })}`,
      expected: undefined,
    },
    { name: "ignores other prompts", text: `Fix this\n${body({ instruction: "Open a PR." })}`, expected: undefined },
  ])("$name", (input) => {
    expect(parseVoiceDelegation(input.text)).toEqual(input.expected)
  })
})
