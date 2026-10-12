# OpenCode 1 / OpenCode 2 release isolation

OpenCode 2 releases are published as GitHub Releases in `anomalyco/opencode`, the same repository as
OpenCode 1. OpenCode 1 clients must keep discovering only 1.x releases. Moving to OpenCode 2 stays an
explicit step (`opencode upgrade --major` or the OpenCode 2.0 offer in `/update`).

## How OpenCode 1 finds releases

Every shipped OpenCode 1 path that reads GitHub uses the release marked **Latest**, not the newest release:

| Consumer                                                     | Source                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| CLI, curl / yarn / unknown installs (1.0.204 through 1.19.0) | `api.github.com/repos/anomalyco/opencode/releases/latest`                |
| `opencode.ai/install` (redirects to the `v1` branch file)    | `releases/latest` API and `releases/latest/download/<asset>`             |
| Electron desktop (1.2.17+)                                   | electron-updater GitHub provider, `allowPrerelease: false` → Latest      |
| Tauri desktop (before 1.2.17)                                | `releases/latest/download/latest.json`                                   |
| GitHub Action (`github/action.yml`)                          | `releases/latest` API, then `opencode.ai/install`                        |
| Scoop main bucket                                            | `checkver: github` → Latest                                              |
| npm / bun / pnpm installs, Homebrew tap                      | `opencode-ai` dist-tags and `anomalyco/tap/opencode`, which are 1.x only |

So, as long as Latest stays on a 1.x release, publishing OpenCode 2 GitHub Releases does not reach
OpenCode 1 clients. Two defaults would break that: `gh release create` without `--latest` uses
"automatic" (the highest version wins), and publishing a draft through the API defaults
`make_latest` to `true`. OpenCode 2 releases therefore always pass `--latest=false`.

### Verified behaviour

Checked on 2026-10-12 in the private scratch repository `thdxr/latest-flag-test`:

| Step                                                                    | `GET /releases/latest` |
| ----------------------------------------------------------------------- | ---------------------- |
| `v1.0.0` created as Latest, then `v2.0.0` created with `--latest=false` | `v1.0.0`               |
| `gh release edit v2.0.0 --latest=false`                                 | `v1.0.0`               |
| `v2.3.0` created with `--verify-tag --latest=false`                     | `v1.0.1`               |
| draft `v2.1.0` published with `gh release edit --draft=false` (no flag) | **`v2.1.0`**           |
| `v2.2.0` created with `gh release create` (no flag)                     | **`v2.2.0`**           |
| draft `v1.0.1` published with `gh release edit --draft=false --latest`  | `v1.0.1`               |

GraphQL `isLatest` agreed in every case. The web redirects (`github.com/<repo>/releases/latest` and
`releases/latest/download/<asset>`) need a browser session on a private repository, so they were checked
on public repositories whose newest release is not Latest (for example `envoyproxy/envoy`, where
`v1.36.13` is newer than the Latest `v1.39.3`). Both redirects, and the JSON response electron-updater
requests, resolved to the Latest release.

## Changes

- **OpenCode 2 (`dev`, #54903):**
  - `script/publish.ts` creates or edits the GitHub Release for each stable tag with
    `--latest=false`, using the reviewed release notes. It attaches no assets.
  - This only runs when the repository variable `OPENCODE_V2_GITHUB_RELEASES` is `true`.
  - The `verify-github-latest` job in `publish.yml` runs `script/check-github-latest.ts`, which fails
    unless Latest is still a `v1.` release.
  - `notify-discord.yml` only announces `v1.` releases; the publish workflow announces OpenCode 2.
  - The update service accepts `refs/heads/v1` publishes, only to the `v1` channel.
- **OpenCode 1 (`v1`, #54904):**
  - The CLI discovers curl, yarn and unknown installs through `opencode.ai/update/api/v1/cli/github`,
    with a 10s timeout, and falls back to the `opencode-ai` npm dist-tag. It never reads GitHub's Latest.
  - Every install method ignores versions outside the installed major version, and only newer
    versions count as updates. OpenCode 2 is still offered through the existing major upgrade.
  - The installer reads the `v1` channel, falls back to the newest `v1.*` GitHub release, and refuses
    `VERSION` / `--version` 2.x or later.
  - The OpenCode 1 publish keeps Latest with `--latest` and publishes `github`, `npm` and
    `homebrew` artifacts to the `v1` channel.

## Rollout

Each step needs approval; none of them is automatic.

1. **Verify `--latest=false` behaviour.** Done (see above).
2. **Merge the OpenCode 2 PR.** It stays inert for releases until the variable is set in step 6. The
   verification job runs on every stable OpenCode 2 release from then on.
3. **Deploy the update service.** Push `dev` to `production` (`deploy-update.yml`), or run
   `bun run deploy` in `services/update`. No migration is needed.
4. **Seed the `v1` channel with 1.19.0** so the installer has a release before 1.19.1 ships. The
   publish endpoint only accepts OIDC tokens from the publish workflow, so seed through D1:

   ```sh
   cd services/update
   bunx wrangler d1 execute opencode-update --remote --command "
     INSERT INTO artifact (channel, name, distribution, version, metadata, active, minimum, time_created, time_updated)
     VALUES
       ('v1', 'cli', 'github',   '1.19.0', '{\"tag\":\"v1.19.0\"}',                        1, 0, strftime('%s','now') * 1000, strftime('%s','now') * 1000),
       ('v1', 'cli', 'npm',      '1.19.0', '{\"package\":\"opencode-ai\"}',                1, 0, strftime('%s','now') * 1000, strftime('%s','now') * 1000),
       ('v1', 'cli', 'homebrew', '1.19.0', '{\"package\":\"anomalyco/tap/opencode\"}',     1, 0, strftime('%s','now') * 1000, strftime('%s','now') * 1000)"
   curl -s https://opencode.ai/update/api/v1/cli/github
   ```

5. **Merge the OpenCode 1 PR and release 1.19.1.** Merging changes `opencode.ai/install` right away,
   because it redirects to the `v1` branch file. Release with the publish workflow on `v1` (bump
   `patch`). Check that:
   - the job publishes to the `v1` channel;
   - `curl -s https://opencode.ai/update/api/v1/cli/github` returns 1.19.1;
   - `gh api repos/anomalyco/opencode/releases/latest --jq .tag_name` returns `v1.19.1`.
6. **Start publishing OpenCode 2 GitHub Releases:**
   `gh variable set OPENCODE_V2_GITHUB_RELEASES --repo anomalyco/opencode --body true`. On the next
   stable OpenCode 2 release, confirm the release exists, is not Latest, and that `verify-github-latest`
   passed.
   - Optionally backfill existing tags without moving Latest:
     `gh release create v2.0.27 --repo anomalyco/opencode --verify-tag --latest=false --notes-file <notes>`.
   - Run `./script/check-github-latest.ts` afterwards.

## Flip criteria

Keep Latest on 1.x until all of these are true:

- Few clients older than 1.19.1 remain on curl, yarn or unknown installs. Those clients still read
  GitHub's Latest. Clients before 1.19.0 only show a notice for a major release, but `opencode upgrade`
  would then try to install it. 1.19.0 shows it as a normal update in `/update`.
- `opencode.ai/install` and the GitHub Action are updated to install OpenCode 2 (or pin OpenCode 1).
- The Scoop main bucket is coordinated. Its `opencode` manifest tracks GitHub Latest, and its
  autoupdate URLs expect V1 asset names.
- OpenCode 1 desktop users are handled deliberately. After the flip, electron-updater fetches
  `latest*.yml` from the OpenCode 2 release. Those files are absent, so update checks fail rather than
  install anything.

Flip with:

```sh
gh release edit v2.<x>.<y> --repo anomalyco/opencode --latest
```

At the same time:

- change OpenCode 1's `script/publish.ts` to `--latest=false`, so later 1.x patches don't take Latest back;
- remove or invert the `verify-github-latest` job in `dev`.

## Caveats

- **Homebrew Core already ships OpenCode 2.** `formulae.brew.sh` reports `opencode` 2.0.25, so
  OpenCode 1.19.0 and earlier, installed from Homebrew Core, show it as a normal update. From 1.19.1,
  OpenCode 1 ignores it and offers OpenCode 2 through the major upgrade instead. `brew upgrade` still
  installs whatever Homebrew Core ships, independently of OpenCode.
- **Chocolatey** is community maintained. If its maintainer tracks GitHub Latest it stays on 1.x until
  the flip; OpenCode 1.19.1 and later ignore 2.x versions from its feed either way.
- **Clients before 1.0.204** use the `opencode-ai` npm dist-tags for every install method except
  Homebrew Core. Those dist-tags stay on 1.x because OpenCode 2 is published as `@opencode/cli`.

## Rollback

- **OpenCode 2 GitHub Releases:** `gh variable delete OPENCODE_V2_GITHUB_RELEASES --repo anomalyco/opencode`
  stops new releases. Existing releases can stay, since they are not Latest. If Latest ever moves,
  `./script/check-github-latest.ts` prints the exact `gh release edit <v1 tag> --latest` command.
- **Update service:** OpenCode 1 clients fall back to npm when the `v1` channel fails, and the installer
  falls back to GitHub. To withdraw a bad `v1` release, activate the previous one on the admin page
  (`opencode.ai/update/admin`).
- **OpenCode 1 client:** revert the PR on `v1`, which also restores the previous `opencode.ai/install`,
  and release a new patch.
