export * as ConfigInstructionPlugin from "./instruction.js"

import { define } from "@opencode/plugin/effect/plugin"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { sameDirectory } from "@opencode/util/path"
import { basename, dirname, isAbsolute, join } from "path"
import { Effect, FiberMap, PubSub, Semaphore, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { Config } from "../../config.js"
import { Watcher } from "../../filesystem/watcher.js"
import { InstructionDiscovery } from "../../instruction-discovery.js"
import { Instructions } from "../../instructions/index.js"
import { Location } from "../../location.js"

type Loaded =
  | { readonly type: "available"; readonly files: InstructionDiscovery.File[] }
  | { readonly type: "unavailable" }

export const Plugin = define({
  id: "opencode.config.instruction",
  effect: Effect.fn(function* (ctx) {
    const discovery = yield* InstructionDiscovery.Service
    // Configured `instructions` are explicit requests, so they still load when
    // both ambient AGENTS.md scopes are disabled.
    yield* Effect.gen(function* () {
      const config = yield* Config.Service
      const fs = yield* FSUtil.Service
      const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)
      const global = yield* Global.Service
      const location = yield* Location.Service
      const watcher = yield* Watcher.Service
      const changes = yield* PubSub.sliding<string>(1)
      const lock = Semaphore.makeUnsafe(1)
      const start = yield* fs.resolve(location.directory)
      const root = yield* fs.resolve(location.project.directory)
      const home = yield* fs.resolve(global.home)
      const project = discovery.project && FSUtil.contains(root, start)
      const stop = FSUtil.contains(home, start) ? home : root
      const globalFile = yield* fs.resolve(join(global.config, "AGENTS.md"))
      const loaded: { current: Loaded } = { current: { type: "available", files: [] } }
      // Relative `instructions` patterns search from the location directory up to the
      // project root. Without project discovery they resolve in the global config
      // directory instead, so global config cannot pull project files into the prompt.
      const relativeStart = discovery.project ? start : yield* fs.resolve(global.config)
      const relativeStop = project ? root : relativeStart
      const configured: { patterns: string[]; remote: InstructionDiscovery.File[] } = { patterns: [], remote: [] }
      const configuredWatches = yield* FiberMap.make<string>()

      const publish = (update: Watcher.Update) => PubSub.publish(changes, update.path).pipe(Effect.asVoid)
      // The ancestor walk can reach the global file when the location sits
      // beneath the global config dir; global: false excludes it there too.
      const candidates = [
        ...(discovery.global ? [globalFile] : []),
        ...(project
          ? ancestorDirectories(start, stop)
              .map((directory) => join(directory, "AGENTS.md"))
              .filter((file) => discovery.global || file !== globalFile)
          : []),
      ]
      for (const path of new Set(candidates)) {
        const updates = yield* watcher.subscribe({ path, type: "file" })
        yield* updates.pipe(Stream.runForEach(publish), Effect.forkScoped({ startImmediately: true }))
      }

      const read = Effect.fn("ConfigInstructionPlugin.read")(function* (path: string) {
        const content = yield* fs.readFileStringSafe(path)
        if (content !== undefined) return new InstructionDiscovery.File({ path, content })
        yield* Effect.logDebug("instruction file skipped", { path, reason: "unavailable" })
      })

      const globalSource = Effect.fn("ConfigInstructionPlugin.globalSource")(function* () {
        if (!discovery.global || !(yield* fs.isFile(globalFile))) return []
        const file = yield* read(globalFile)
        return file ? [file] : []
      })

      const projectSource = Effect.fn("ConfigInstructionPlugin.projectSource")(function* () {
        if (!project) return []
        const walked = yield* Effect.forEach(
          yield* fs.up({ targets: ["AGENTS.md"], start, stop, type: "file" }),
          fs.resolve,
        )
        const discovered = new Set(walked.filter((file) => discovery.global || file !== globalFile))
        const files = yield* Effect.forEach(discovered, read, { concurrency: "unbounded" })
        if (files.some((file) => file === undefined)) return Instructions.unavailable
        return files.filter((file): file is InstructionDiscovery.File => file !== undefined)
      })

      const configuredSource = Effect.fn("ConfigInstructionPlugin.configuredSource")(function* () {
        yield* FiberMap.clear(configuredWatches)
        const files: InstructionDiscovery.File[] = []
        for (const pattern of configured.patterns) {
          const matches = yield* match(pattern)
          if (matches.length === 0) yield* Effect.logWarning("instruction pattern matched no files", { pattern })
          for (const file of matches) {
            yield* FiberMap.run(
              configuredWatches,
              file,
              Stream.unwrap(watcher.subscribe({ path: file, type: "file" })).pipe(Stream.runForEach(publish)),
              { onlyIfMissing: true, startImmediately: true },
            )
            const content = yield* fs.readFileStringSafe(file)
            if (content === undefined) {
              yield* Effect.logWarning("instruction file unreadable", { pattern, path: file })
              continue
            }
            files.push(new InstructionDiscovery.File({ path: file, content }))
          }
        }
        return files
      })

      // Absolute and `~/` patterns may glob only their final segment, matching v1.
      const match = Effect.fn("ConfigInstructionPlugin.match")(function* (pattern: string) {
        const expanded = pattern.startsWith("~/") ? join(home, pattern.slice(2)) : pattern
        const matches = isAbsolute(expanded)
          ? yield* fs
              .scan(basename(expanded), { cwd: dirname(expanded), absolute: true, include: "file", dot: true })
              .pipe(Effect.orElseSucceed(() => [] as string[]))
          : yield* fs.globUp(expanded, relativeStart, relativeStop)
        // Glob order follows directory listing order; sort so prompts stay stable across scans.
        return [...new Set(matches)].toSorted()
      })

      const fetchRemote = Effect.fn("ConfigInstructionPlugin.fetchRemote")(function* (urls: string[]) {
        const files = yield* Effect.forEach(
          urls,
          (url) =>
            HttpClientRequest.get(url).pipe(
              http.execute,
              Effect.flatMap((response) => response.text),
              Effect.timeout("5 seconds"),
              Effect.map((content) => new InstructionDiscovery.File({ path: url, content })),
              Effect.catch((error) =>
                Effect.logWarning("failed to fetch instruction URL", { url, error }).pipe(Effect.as(undefined)),
              ),
            ),
          { concurrency: 4 },
        )
        return files.filter((file): file is InstructionDiscovery.File => file !== undefined)
      })

      const isolate = <A, E, R>(source: string, effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to load instruction source", { source, cause }).pipe(
              Effect.as(Instructions.unavailable),
            ),
          ),
        )

      const refresh = Effect.fn("ConfigInstructionPlugin.refresh")(
        function* (input: { readonly file?: string; readonly config?: boolean }) {
          // Remote instructions are fetched only when config loads, not on every file change.
          if (input.config) {
            const items = new Set(
              (yield* config.entries()).flatMap((entry) =>
                entry.type === "document" ? (entry.info.instructions ?? []) : [],
              ),
            )
            configured.patterns = [...items].filter((item) => !remote(item))
            configured.remote = yield* fetchRemote([...items].filter(remote))
          }
          const sources = yield* Effect.all({
            global: isolate("global", globalSource()),
            project: isolate("project", projectSource()),
            configured: isolate("configured", configuredSource()),
          })
          loaded.current =
            Array.isArray(sources.global) && Array.isArray(sources.project) && Array.isArray(sources.configured)
              ? {
                  type: "available",
                  files: [...sources.global, ...sources.project, ...sources.configured, ...configured.remote],
                }
              : { type: "unavailable" }
          if (!input.file) return
          yield* Effect.logDebug("instructions rescanned", {
            file: input.file,
            instructions:
              loaded.current.type === "available" ? loaded.current.files.map((item) => item.path) : "unavailable",
          })
        },
        (effect, ..._args: [input: { readonly file?: string; readonly config?: boolean }]) => lock.withPermit(effect),
      )

      // Editor saves arrive as bursts of watcher events; settle before rescanning once. Subscribe
      // before debouncing so no update slips through while the debounce starts its pull.
      const updates = yield* PubSub.subscribe(changes)
      yield* Stream.fromSubscription(updates).pipe(
        Stream.debounce("100 millis"),
        Stream.runForEach((file) => refresh({ file }).pipe(Effect.andThen(discovery.reload()))),
        Effect.forkScoped({ startImmediately: true }),
      )
      // Subscribe before the first config read so an update between them is not lost.
      yield* ctx.event.subscribe().pipe(
        Stream.filter((event) => event.type === "config.updated"),
        Stream.runForEach(() => refresh({ config: true }).pipe(Effect.andThen(discovery.reload()))),
        Effect.forkScoped({ startImmediately: true }),
      )
      yield* refresh({ config: true })
      yield* discovery.transform((editor) => {
        if (loaded.current.type === "unavailable") {
          editor.unavailable()
          return
        }
        for (const file of loaded.current.files) editor.add(file)
      })
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to activate instruction source", { cause }).pipe(
          Effect.andThen(discovery.transform((editor) => editor.unavailable())),
          Effect.asVoid,
        ),
      ),
    )
  }),
})

// `start` keeps the client's spelling while `stop` may come from git, so a Windows drive
// letter can differ only in case (`c:\repo` vs `C:\repo`). Compare the way FSUtil.contains
// admitted `start` beneath `stop`, or the walk passes `stop` and recurses at the drive root.
function ancestorDirectories(start: string, stop: string): string[] {
  if (sameDirectory(start, stop)) return [start]
  return [start, ...ancestorDirectories(dirname(start), stop)]
}

function remote(item: string) {
  return item.startsWith("https://") || item.startsWith("http://")
}
