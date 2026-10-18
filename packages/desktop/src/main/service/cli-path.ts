import { execFile } from "node:child_process"
import { stat } from "node:fs/promises"
import { promisify } from "node:util"
import { Effect, FileSystem, Path } from "effect"

const execFileAsync = promisify(execFile)

// Each version stages its CLI in its own directory, so the user PATH holds one fixed directory with a
// link to the current stage instead. PATH is edited only when that directory is first created: a user
// who removes the entry keeps it removed, and the uninstaller deletes both to start over on reinstall.
export const exposeCli = Effect.fn("DesktopCli.expose")(function* (binary: string, directory: string) {
  const fs = yield* FileSystem.FileSystem

  if (!(yield* fs.exists(directory))) yield* addToUserPath(directory)
  const target = yield* linkCli(binary, directory)
  yield* Effect.logInfo("v2 CLI linked on PATH", { path: target })
})

export const linkCli = Effect.fn("DesktopCli.link")(function* (binary: string, directory: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const target = path.join(directory, path.basename(binary))
  yield* fs.makeDirectory(directory, { recursive: true })

  // Windows refuses to delete an image that a terminal still runs, so a replaced link waits here until
  // a later launch can remove it.
  const names = yield* fs.readDirectory(directory)
  yield* Effect.forEach(
    names.filter((name) => name.endsWith(".old")),
    (name) => fs.remove(path.join(directory, name)).pipe(Effect.ignore),
  )

  // NTFS file IDs exceed 2^53, so only the bigint form tells two files apart reliably.
  const current = yield* Effect.promise(() => stat(target, { bigint: true }).catch(() => undefined))
  const source = yield* Effect.tryPromise(() => stat(binary, { bigint: true }))

  if (current?.ino === source.ino && current.dev === source.dev) return target
  const temp = `${target}.${process.pid}.tmp`
  yield* fs.remove(temp, { force: true })
  yield* fs.link(binary, temp).pipe(Effect.catch(() => fs.copyFile(binary, temp)))

  // Renaming a running image is allowed, so a terminal that still runs the old link does not block the update.
  if (current) yield* fs.rename(target, `${target}.${process.pid}-${Date.now()}.old`)
  yield* fs.rename(temp, target)

  return target
})

// Reads the raw value so entries such as %USERPROFILE%\bin stay unexpanded; .NET would write Path back as
// REG_SZ. Clearing an unused variable through .NET broadcasts WM_SETTINGCHANGE, so Explorer and the
// terminals it starts see the entry without signing out.
const addToUserPath = Effect.fn("DesktopCli.addToUserPath")(function* (directory: string) {
  yield* Effect.tryPromise(() =>
    execFileAsync(
      `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", addToUserPathScript],
      { env: { ...process.env, OPENCODE_CLI_DIRECTORY: directory }, windowsHide: true },
    ),
  )
  yield* Effect.logInfo("v2 CLI directory added to user PATH", { directory })
})

const addToUserPathScript = `
$directory = $env:OPENCODE_CLI_DIRECTORY
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
$entries = @(([string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')) -split ';' | Where-Object { $_ })
if ($entries -contains $directory) { exit 0 }
$key.SetValue('Path', (($entries + $directory) -join ';'), 'ExpandString')
[Environment]::SetEnvironmentVariable('OPENCODE_PATH_REFRESH', $null, 'User')
`
