import photonWasm from "#photon-wasm"
import { Effect } from "effect"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { FileSystem } from "../filesystem.js"
import { DecodeError, ResizerUnavailableError, SizeError, type Limits } from "../image.js"

const PNG_PASSTHROUGH_MAX_BASE64_BYTES = 384 * 1024
const SMALL_PNG_MAX_PIXELS = 256 * 256
const JPEG_QUALITIES = [80, 70, 55, 40]

function hasTransparency(pixels: Uint8Array) {
  const samples = Math.min(4_096, Math.floor(pixels.length / 4))
  if (samples === 0) return false
  const stride = Math.max(1, Math.floor(pixels.length / 4 / samples)) * 4
  let transparent = 0
  for (let index = 3; index < pixels.length; index += stride) {
    if (pixels[index]! < 250) transparent++
  }
  return transparent / samples > 0.05
}

export const make = Effect.gen(function* () {
  const loadPhoton = yield* Effect.cached(
    // A runtime without a photon wasm artifact (#photon-wasm resolves to the
    // empty string on workerd) has no resizer, by declaration: fail typed
    // before touching URLs or module loading. The path resolution and import
    // for runtimes that DO have an artifact stay inside the guard too — a
    // throw outside it (workerd's undefined import.meta.url was one) is a
    // defect that escapes the ResizerUnavailableError handling and turns any
    // image-bearing prompt into a 500 instead of degrading to passthrough.
    photonWasm === ""
      ? Effect.fail(new ResizerUnavailableError())
      : Effect.tryPromise({
          try: async () => {
            ;(
              globalThis as typeof globalThis & { __OPENCODE_PHOTON_WASM_PATH?: string }
            ).__OPENCODE_PHOTON_WASM_PATH = path.isAbsolute(photonWasm)
              ? photonWasm
              : fileURLToPath(new URL(photonWasm, import.meta.url))
            return await import("@silvia-odwyer/photon-node")
          },
          catch: () => new ResizerUnavailableError(),
        }),
  )
  return Effect.fn("Image.Photon.normalize")(function* (
    resource: string,
    content: FileSystem.Content & { readonly encoding: "base64" },
    limits: Readonly<Limits>,
  ) {
    const photon = yield* loadPhoton
    const decoded = yield* Effect.try({
      try: () => photon.PhotonImage.new_from_byteslice(Buffer.from(content.content, "base64")),
      catch: () => new DecodeError({ resource }),
    })
    try {
      const width = decoded.get_width()
      const height = decoded.get_height()
      const bytes = Buffer.byteLength(content.content, "utf-8")
      const transparent =
        content.mime === "image/png" && bytes > PNG_PASSTHROUGH_MAX_BASE64_BYTES
          ? hasTransparency(decoded.get_raw_pixels())
          : false
      const keepOriginal =
        content.mime !== "image/png" ||
        !limits.autoResize ||
        bytes <= PNG_PASSTHROUGH_MAX_BASE64_BYTES ||
        transparent
      if (width <= limits.maxWidth && height <= limits.maxHeight && bytes <= limits.maxBase64Bytes && keepOriginal)
        return content
      if (!limits.autoResize)
        return yield* new SizeError({
          resource,
          width,
          height,
          bytes,
          maxWidth: limits.maxWidth,
          maxHeight: limits.maxHeight,
          maxBytes: limits.maxBase64Bytes,
        })
      const scale = Math.min(1, limits.maxWidth / width, limits.maxHeight / height)
      const sizes = Array.from({ length: 32 }).reduce<Array<{ width: number; height: number }>>((acc) => {
        const previous = acc.at(-1) ?? {
          width: Math.max(1, Math.round(width * scale)),
          height: Math.max(1, Math.round(height * scale)),
        }
        const next =
          acc.length === 0
            ? previous
            : {
                width: previous.width === 1 ? 1 : Math.max(1, Math.floor(previous.width * 0.75)),
                height: previous.height === 1 ? 1 : Math.max(1, Math.floor(previous.height * 0.75)),
              }
        return acc.some((item) => item.width === next.width && item.height === next.height) ? acc : [...acc, next]
      }, [])
      const preferPng =
        transparent ||
        (content.mime === "image/png" &&
          bytes <= PNG_PASSTHROUGH_MAX_BASE64_BYTES &&
          hasTransparency(decoded.get_raw_pixels()))
      for (const size of sizes) {
        const resized =
          size.width === width && size.height === height
            ? decoded
            : photon.resize(decoded, size.width, size.height, photon.SamplingFilter.Lanczos3)
        try {
          const pngEncoder = ["image/png", () => resized.get_bytes()] as const
          const jpegEncoders = JPEG_QUALITIES.map(
            (quality) => ["image/jpeg", () => resized.get_bytes_jpeg(quality)] as const,
          )
          const pngFirst = preferPng || size.width * size.height <= SMALL_PNG_MAX_PIXELS
          const encoders: Array<readonly [mime: string, encode: () => Uint8Array]> = pngFirst
            ? [pngEncoder, ...jpegEncoders]
            : [...jpegEncoders, pngEncoder]
          for (const [mime, encode] of encoders) {
            const candidate = encode()
            // Base64 uses four bytes per three input bytes, including padding.
            if (Math.ceil(candidate.length / 3) * 4 <= limits.maxBase64Bytes)
              return {
                ...content,
                content: Buffer.from(candidate).toString("base64"),
                encoding: "base64" as const,
                mime,
              }
          }
        } finally {
          if (resized !== decoded) resized.free()
        }
      }
      return yield* new SizeError({
        resource,
        width,
        height,
        bytes,
        maxWidth: limits.maxWidth,
        maxHeight: limits.maxHeight,
        maxBytes: limits.maxBase64Bytes,
      })
    } finally {
      decoded.free()
    }
  })
})
