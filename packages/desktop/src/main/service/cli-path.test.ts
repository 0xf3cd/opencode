import { describe, expect, test } from "bun:test"
import {
  copyFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Effect, Layer } from "effect"

import { linkCli } from "./cli-path"

const run = (binary: string, directory: string) =>
  Effect.runPromise(linkCli(binary, directory).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))))

// PATH holds one fixed directory while every version stages its own CLI, so the entry there must always
// run the current stage, without replacing it on every launch or leaving old versions behind. Volumes
// without hard links hold a copy instead.
describe("linkCli", () => {
  test.each([
    { name: "a first launch", linked: undefined, current: "2.0.20", kept: false },
    { name: "an upgrade", linked: { version: "2.0.19", copy: false }, current: "2.0.20", kept: false },
    { name: "a downgrade", linked: { version: "2.0.20", copy: false }, current: "2.0.19", kept: false },
    { name: "a relaunch", linked: { version: "2.0.20", copy: false }, current: "2.0.20", kept: true },
    { name: "an upgrade over a copy", linked: { version: "2.0.19", copy: true }, current: "2.0.20", kept: false },
    { name: "a relaunch over a copy", linked: { version: "2.0.20", copy: true }, current: "2.0.20", kept: true },
  ])("runs the current stage after $name", async (input) => {
    const root = mkdtempSync(path.join(tmpdir(), "opencode-link-"))

    try {
      const stage = (version: string) => path.join(root, "cli", version, "opencode")
      ;["2.0.19", "2.0.20"].forEach((version, index) => {
        mkdirSync(path.dirname(stage(version)), { recursive: true })
        writeFileSync(stage(version), version)
        // Builds of different versions never share a modification time.
        utimesSync(stage(version), 1_700_000_000 + index, 1_700_000_000 + index)
      })
      const bin = path.join(root, "bin")
      const link = path.join(bin, "opencode")

      if (input.linked) {
        mkdirSync(bin)
        if (input.linked.copy) copyFileSync(stage(input.linked.version), link)
        if (!input.linked.copy) linkSync(stage(input.linked.version), link)
      }
      const before = input.linked ? statSync(link).ino : undefined

      expect(await run(stage(input.current), bin)).toBe(link)
      expect(readFileSync(link, "utf8")).toBe(input.current)
      expect(statSync(link).ino === before).toBe(input.kept)
      if (!input.linked?.copy) expect(statSync(link).ino).toBe(statSync(stage(input.current)).ino)

      // The next launch removes the replaced entry once nothing runs it.
      await run(stage(input.current), bin)
      expect(readdirSync(bin)).toEqual(["opencode"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
