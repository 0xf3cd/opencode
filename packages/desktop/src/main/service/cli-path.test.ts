import { describe, expect, test } from "bun:test"
import { linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Effect, Layer } from "effect"

import { linkCli } from "./cli-path"

const run = (binary: string, directory: string) =>
  Effect.runPromise(linkCli(binary, directory).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))))

// PATH holds one fixed directory while every version stages its own CLI, so the link there must
// always follow the current stage, without copying 200 MB or leaving old versions behind.
describe("linkCli", () => {
  test.each([
    { name: "a first launch", linked: undefined, current: "2.0.20" },
    { name: "an upgrade", linked: "2.0.19", current: "2.0.20" },
    { name: "a downgrade", linked: "2.0.20", current: "2.0.19" },
    { name: "a relaunch", linked: "2.0.20", current: "2.0.20" },
  ])("links the current stage after $name", async (input) => {
    const root = mkdtempSync(path.join(tmpdir(), "opencode-link-"))

    try {
      const stage = (version: string) => path.join(root, "cli", version, "opencode")
      ;["2.0.19", "2.0.20"].forEach((version) => {
        mkdirSync(path.dirname(stage(version)), { recursive: true })
        writeFileSync(stage(version), version)
      })
      const bin = path.join(root, "bin")
      const link = path.join(bin, "opencode")

      if (input.linked) {
        mkdirSync(bin)
        linkSync(stage(input.linked), link)
      }

      expect(await run(stage(input.current), bin)).toBe(link)
      expect(readFileSync(link, "utf8")).toBe(input.current)
      expect(statSync(link).ino).toBe(statSync(stage(input.current)).ino)

      // The next launch removes the replaced link once nothing runs it.
      await run(stage(input.current), bin)
      expect(readdirSync(bin)).toEqual(["opencode"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
