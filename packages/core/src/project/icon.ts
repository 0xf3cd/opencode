export * as ProjectIcon from "./icon.js"

import path from "path"
import { Effect, Option, Schema } from "effect"
import { parse } from "jsonc-parser"
import { FSUtil } from "@opencode/util/fs-util"
import { Hash } from "@opencode/util/hash"
import { AbsolutePath } from "../schema.js"

export const MAX_BYTES = 2 * 1024 * 1024

export interface Image {
  readonly path: string
  readonly type: string
  readonly hash: string
  readonly bytes: Uint8Array
}
export type Candidate = Image | { readonly url: string }

const IMAGES = new Set([".svg", ".png", ".ico", ".jpg", ".jpeg", ".webp"])
const CANDIDATES = [
  "Assets.xcassets/AppIcon.appiconset",
  "ios/App/Assets.xcassets/AppIcon.appiconset",
  ...["assets/app-icon", "build/icon", "src-tauri/icons/icon", "resources/icon", "icons/icon", "extension/icons/icon"].flatMap(
    (b) => [`${b}.svg`, `${b}.png`],
  ),
  ...["favicon.svg", "icon.svg", "favicon.png", "apple-touch-icon.png", "icon.png", "favicon.ico"].flatMap((f) =>
    ["public/", "app/", "src/app/", "site/public/", ""].map((d) => `${d}${f}`),
  ),
  ...["assets/icon", "assets/logo", "public/logo", "logo"].flatMap((b) => [`${b}.svg`, `${b}.png`]),
]
const decodeConfig = Schema.decodeUnknownOption(Schema.Struct({ icon: Schema.String }))

export const discover = Effect.fn("ProjectIcon.discover")(function* (fs: FSUtil.Interface, root: AbsolutePath) {
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const text = yield* fs.readFileString(path.join(root, name)).pipe(Effect.orElseSucceed(() => undefined))
    const val = text !== undefined ? Option.getOrUndefined(decodeConfig(parse(text)))?.icon.trim() : undefined
    const hit = val ? (/^https?:/i.test(val) ? { url: val } : yield* read(fs, root, val)) : undefined
    if (hit) return hit
  }
  for (const candidate of CANDIDATES) {
    const entries = candidate.endsWith(".appiconset")
      ? yield* fs.readDirectoryEntries(path.join(root, candidate)).pipe(Effect.orElseSucceed(() => []))
      : undefined
    const files = entries
      ?.flatMap((e) => (e.type === "file" && IMAGES.has(path.extname(e.name).toLowerCase()) ? [e.name] : []))
      .toSorted()
    const picked = files ? (files.find((n) => /128|256/.test(n)) ?? files[0]) : undefined
    const image = entries ? (picked ? yield* read(fs, root, `${candidate}/${picked}`) : undefined) : yield* read(fs, root, candidate)
    if (image) return image
  }
})

export const read = Effect.fn("ProjectIcon.read")(function* (fs: FSUtil.Interface, root: AbsolutePath, relative: string) {
  if (relative.includes("\u0000") || path.isAbsolute(relative)) return undefined
  const realRoot = yield* fs.realPath(root).pipe(Effect.orElseSucceed(() => undefined))
  const realFile = yield* fs.realPath(path.resolve(root, relative)).pipe(Effect.orElseSucceed(() => undefined))
  const ext = realFile ? path.extname(realFile).toLowerCase() : ""
  if (!realRoot || !realFile || !FSUtil.contains(realRoot, realFile) || realFile === realRoot || !IMAGES.has(ext))
    return undefined
  const info = yield* fs.stat(realFile).pipe(Effect.orElseSucceed(() => undefined))
  if (!info || info.type !== "File" || !Number(info.size) || Number(info.size) > MAX_BYTES) return undefined
  const bytes = yield* fs.readFile(realFile).pipe(Effect.orElseSucceed(() => undefined))
  if (!bytes || !bytes.byteLength || bytes.byteLength > MAX_BYTES) return undefined
  return {
    path: path.relative(realRoot, realFile).split(path.sep).join("/"),
    type: ext === ".ico" ? "image/x-icon" : FSUtil.mimeType(realFile),
    hash: Hash.fast(Buffer.from(bytes)).slice(0, 16),
    bytes,
  }
})
