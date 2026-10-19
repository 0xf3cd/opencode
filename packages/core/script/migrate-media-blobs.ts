#!/usr/bin/env bun
/**
 * Offline migration script for externalizing inline base64 media from `session_message.data`
 * into the content-addressed `media_blob` table, optionally transcoding oversized PNGs to
 * 1568px JPEG (q80), and compacting the database into a new file via `VACUUM INTO`.
 *
 * Run only while the OpenCode server is stopped:
 *   bun packages/core/script/migrate-media-blobs.ts <path/to/opencode.db> [--transcode] [--vacuum-into <out.db>]
 */
import { Database } from "bun:sqlite"
import { SessionMediaBlob } from "../src/session/media-blob.js"

const args = process.argv.slice(2)
const dbPath = args.find((arg) => !arg.startsWith("--"))
const vacuumIdx = args.indexOf("--vacuum-into")
const vacuumTarget = vacuumIdx !== -1 ? args[vacuumIdx + 1] : undefined

if (!dbPath) {
  console.error("Usage: bun packages/core/script/migrate-media-blobs.ts <opencode.db> [--vacuum-into <out.db>]")
  process.exit(1)
}

const db = new Database(dbPath)
db.exec(`
  CREATE TABLE IF NOT EXISTS media_blob (
    hash TEXT PRIMARY KEY,
    mime TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    data TEXT NOT NULL,
    time_created INTEGER NOT NULL
  );
`)

const candidates = db
  .query<{ id: string; session_id: string }, []>(
    `SELECT id, session_id FROM session_message WHERE octet_length(data) >= 2048`,
  )
  .all()

const selectRow = db.prepare<{ data: string }, [string, string]>(
  `SELECT data FROM session_message WHERE session_id = ? AND id = ?`,
)
const updateRow = db.prepare(`UPDATE session_message SET data = ? WHERE session_id = ? AND id = ?`)
const insertBlob = db.prepare(
  `INSERT OR IGNORE INTO media_blob (hash, mime, bytes, data, time_created) VALUES (?, ?, ?, ?, ?)`,
)

let migratedRows = 0
let blobsStored = 0
const batchSize = 250
const now = Date.now()

for (let offset = 0; offset < candidates.length; offset += batchSize) {
  const batch = candidates.slice(offset, offset + batchSize)
  const tx = db.transaction(() => {
    for (const item of batch) {
      const row = selectRow.get(item.session_id, item.id)
      if (!row) continue
      if (!row.data.includes(";base64,") && !row.data.includes('"files"')) continue
      const parsed = JSON.parse(row.data)
      const externalized = SessionMediaBlob.externalizeData(parsed)
      if (externalized.blobs.length === 0) continue
      for (const blob of externalized.blobs) {
        insertBlob.run(blob.hash, blob.mime, blob.bytes, blob.data, now)
        blobsStored++
      }
      updateRow.run(JSON.stringify(externalized.data), item.session_id, item.id)
      migratedRows++
    }
  })
  tx()
}

if (vacuumTarget) {
  db.exec(`VACUUM INTO '${vacuumTarget.replace(/'/g, "''")}';`)
}

db.close()
console.log(JSON.stringify({ candidates: candidates.length, migratedRows, blobsStored, vacuumTarget }))
