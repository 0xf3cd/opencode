import { artifactKind, artifactMime, type ArtifactKind } from "@opencode/util/artifact"
import type { FileContent } from "@opencode/gui-extensions/sdk"

/** Kinds whose raw bytes are kept so media elements and binary viewers can read them without a text round trip. */
const binaryKinds = new Set<ArtifactKind>([
  "image",
  "audio",
  "video",
  "pdf",
  "font",
  "document",
  "spreadsheet",
  "presentation",
])

/** Text files never contain NUL; a NUL in the first 8 KiB marks an unknown binary. */
function isBinaryBytes(bytes: Uint8Array) {
  return bytes.subarray(0, 8192).includes(0)
}

/** Media above this stays a placeholder so the in-memory file cache stays bounded. */
export const MAX_MEDIA_BYTES = 256 * 1024 * 1024

export function fileContentFromBytes(path: string, bytes: Uint8Array): FileContent {
  const kind = artifactKind(path)
  const mimeType = artifactMime(path)

  if (binaryKinds.has(kind)) {
    if (bytes.length > MAX_MEDIA_BYTES) return { type: "binary", content: "", size: bytes.length }

    return { type: "binary", content: "", bytes, mimeType }
  }

  // Unknown binaries keep no bytes: the viewer only shows a placeholder for them.
  if (kind === "text" && isBinaryBytes(bytes)) return { type: "binary", content: "", size: bytes.length }

  return { type: "text", content: new TextDecoder().decode(bytes), mimeType }
}

const sameBytes = (a: Uint8Array | undefined, b: Uint8Array | undefined) =>
  a === b || (!!a && !!b && a.length === b.length && a.every((byte, index) => byte === b[index]))

/** Whether a reread found what is already shown, so the viewer can keep its content. */
export function sameFileContent(a: FileContent | undefined, b: FileContent) {
  return (
    !!a &&
    a.type === b.type &&
    a.content === b.content &&
    a.size === b.size &&
    a.mimeType === b.mimeType &&
    sameBytes(a.bytes, b.bytes)
  )
}
