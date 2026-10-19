export * as SessionMediaBlob from "./media-blob.js"

import { createHash } from "node:crypto"
import { inArray } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database.js"
import { MediaBlobTable, SessionMessageTable } from "./sql.js"

type DatabaseService = Database.Interface["db"]
type SessionMessageRow = typeof SessionMessageTable.$inferSelect
type SessionMessageData = SessionMessageRow["data"]

export const BLOB_PREFIX = "blob:sha256:"
export const MIN_EXTERNALIZE_BYTES = 1_024
const QUERY_BATCH_SIZE = 500

export type BlobEntry = {
  readonly hash: string
  readonly mime: string
  readonly bytes: number
  readonly data: string
}

const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex")

export const isBlobRef = (value: string) => value.startsWith(BLOB_PREFIX)

export const parseBlobRef = (value: string) =>
  value.startsWith(BLOB_PREFIX) ? value.slice(BLOB_PREFIX.length) : undefined

export function externalizeData(data: SessionMessageData): {
  readonly data: SessionMessageData
  readonly blobs: ReadonlyArray<BlobEntry>
} {
  const blobs = new Map<string, BlobEntry>()

  if ("files" in data && data.files) {
    let changed = false
    const files = data.files.map((file) => {
      if (isBlobRef(file.data) || file.data.length < MIN_EXTERNALIZE_BYTES) return file
      const hash = sha256Hex(file.data)
      blobs.set(hash, { hash, mime: file.mime, bytes: Buffer.byteLength(file.data, "utf-8"), data: file.data })
      changed = true
      return { ...file, data: `${BLOB_PREFIX}${hash}` }
    })
    if (!changed) return { data, blobs: [] }
    return { data: { ...data, files }, blobs: Array.from(blobs.values()) }
  }

  if ("content" in data) {
    let partsChanged = false
    const content = data.content.map((part) => {
      if (part.type !== "tool") return part
      if (part.state.status !== "completed" && part.state.status !== "error") return part
      if (!part.state.content) return part
      let contentChanged = false
      const items = part.state.content.map((item) => {
        if (item.type !== "file" || !item.uri.startsWith("data:")) return item
        const marker = item.uri.indexOf(";base64,")
        if (marker === -1) return item
        const raw = item.uri.slice(marker + 8)
        if (raw.length < MIN_EXTERNALIZE_BYTES) return item
        const headerMime = item.uri.slice(5, marker)
        const mime = headerMime || item.mime
        const hash = sha256Hex(raw)
        blobs.set(hash, { hash, mime, bytes: Buffer.byteLength(raw, "utf-8"), data: raw })
        contentChanged = true
        return { ...item, mime, uri: `${BLOB_PREFIX}${hash}` }
      })
      if (!contentChanged) return part
      partsChanged = true
      const first = items[0]!
      return {
        ...part,
        state: {
          ...part.state,
          content: [first, ...items.slice(1)] as const,
        },
      }
    })
    if (!partsChanged) return { data, blobs: [] }
    return { data: { ...data, content }, blobs: Array.from(blobs.values()) }
  }

  return { data, blobs: [] }
}

export const storeBlobs = Effect.fnUntraced(function* (db: DatabaseService, blobs: ReadonlyArray<BlobEntry>) {
  if (blobs.length === 0) return
  const now = Date.now()
  yield* db
    .insert(MediaBlobTable)
    .values(
      blobs.map((blob) => ({
        hash: blob.hash,
        mime: blob.mime,
        bytes: blob.bytes,
        data: blob.data,
        time_created: now,
      })),
    )
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

function collectRowHashes(data: SessionMessageData, out: Set<string>) {
  if ("files" in data && data.files) {
    for (const file of data.files) {
      const hash = parseBlobRef(file.data)
      if (hash) out.add(hash)
    }
  }
  if ("content" in data) {
    for (const part of data.content) {
      if (part.type !== "tool") continue
      if (part.state.status !== "completed" && part.state.status !== "error") continue
      if (!part.state.content) continue
      for (const item of part.state.content) {
        if (item.type !== "file") continue
        const hash = parseBlobRef(item.uri)
        if (hash) out.add(hash)
      }
    }
  }
}

function applyRowBlobs(
  data: SessionMessageData,
  byHash: ReadonlyMap<string, { readonly mime: string; readonly data: string }>,
): SessionMessageData {
  if ("files" in data && data.files) {
    let changed = false
    const files = data.files.map((file) => {
      const hash = parseBlobRef(file.data)
      const blob = hash ? byHash.get(hash) : undefined
      if (!blob) return file
      changed = true
      return { ...file, data: blob.data }
    })
    if (changed) return { ...data, files }
  }

  if ("content" in data) {
    let partsChanged = false
    const content = data.content.map((part) => {
      if (part.type !== "tool") return part
      if (part.state.status !== "completed" && part.state.status !== "error") return part
      if (!part.state.content) return part
      let contentChanged = false
      const items = part.state.content.map((item) => {
        if (item.type !== "file") return item
        const hash = parseBlobRef(item.uri)
        const blob = hash ? byHash.get(hash) : undefined
        if (!blob) return item
        const mime = blob.mime || item.mime
        contentChanged = true
        return { ...item, mime, uri: `data:${mime};base64,${blob.data}` }
      })
      if (!contentChanged) return part
      partsChanged = true
      const first = items[0]!
      return {
        ...part,
        state: {
          ...part.state,
          content: [first, ...items.slice(1)] as const,
        },
      }
    })
    if (partsChanged) return { ...data, content }
  }

  return data
}

export const hydrateRows = Effect.fnUntraced(function* (
  db: DatabaseService,
  rows: ReadonlyArray<SessionMessageRow>,
) {
  const hashes = new Set<string>()
  for (const row of rows) {
    collectRowHashes(row.data, hashes)
  }
  if (hashes.size === 0) return rows

  const allHashes = Array.from(hashes)
  const byHash = new Map<string, { readonly mime: string; readonly data: string }>()
  for (let offset = 0; offset < allHashes.length; offset += QUERY_BATCH_SIZE) {
    const batch = allHashes.slice(offset, offset + QUERY_BATCH_SIZE)
    const found = yield* db
      .select({ hash: MediaBlobTable.hash, mime: MediaBlobTable.mime, data: MediaBlobTable.data })
      .from(MediaBlobTable)
      .where(inArray(MediaBlobTable.hash, batch))
      .all()
      .pipe(Effect.orDie)
    for (const entry of found) {
      byHash.set(entry.hash, { mime: entry.mime, data: entry.data })
    }
  }
  if (byHash.size === 0) return rows

  return rows.map((row) => {
    const hydrated = applyRowBlobs(row.data, byHash)
    return hydrated === row.data ? row : { ...row, data: hydrated }
  })
})
