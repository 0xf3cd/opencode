# Documentation feature guide

## Structure

- This folder owns the documentation data model, content, frontend, and styling.
- Documentation content lives in `content/` and is loaded by `../content.config.ts`.
- `lib/navigation.ts` is the source of truth for header sections and sidebar ordering.
- The thin route entrypoints live in `../pages/docs/`; keep docs implementation details here.
- Do not add a documentation frontend framework; this folder owns the UI directly.
- Keep internal Markdown links docs-root-relative, for example `/config`; `remark-links.ts` applies the site and docs base paths.

## Translations

- Locales are registered in `lib/language.ts` and use the opencode.ai website codes, such as `zh`. The code is the URL segment, the `content/<code>/` folder, and the `i18n/<code>.ts` file name. English is the default locale and has no URL segment.
- Translate a page by mirroring its English path under `content/<code>/`, for example `content/config.mdx` becomes `content/zh/config.mdx`. Untranslated pages fall back to English under the locale URL.
- Keep links in translated pages identical to the English page, for example `/config`; the locale segment is added at render time.
- Keep the English heading structure in translations: the same headings at the same levels, in the same order. `remark-translated-headings.ts` reuses the English heading IDs so `#anchor` links work in every locale.
- Removing or moving an English page leaves its translations unused but does not break the build; delete or move them in the same change when convenient.
- English changes may ship before translations. When an English page's heading structure changes, its translations are treated as outdated: the build warns, and the locale URL serves the English page until the translation is updated.
- UI strings follow the website dictionaries: `i18n/en.ts` defines every key, and each locale spreads English and overrides its strings with `satisfies Dict`. Register new locales in `i18n/index.ts`. A locale's `<code>Nav` map translates header and sidebar labels by their English text from `lib/navigation.ts`.
- Build all docs links with `docsHref(slug, locale)` or `localizeDocsHref` so readers stay in their language.
- MDX pitfalls in translated prose: a paragraph that starts with the word `import` or `export` is parsed as JavaScript and breaks the build, and bold text that ends in punctuation directly before a letter (`**Remove…**를`) does not render. Reword the sentence, or use `<strong>…</strong>` for the bold case.
- Language detection follows the website's `/data` proxy and runs in `../middleware.ts` on every request: URL prefix, then the shared `oc_locale` cookie, then `Accept-Language`. Unprefixed pages redirect to the preferred locale before the cache lookup, and the cache is keyed by the locale-specific URL. Do not re-enable Workers Cache in `wrangler.jsonc`; it would serve cached pages before the locale redirect runs.

## Writing Style

- Keep prose sections brief and focused on one idea. Prefer one to three sentences over large paragraphs.
- Interleave explanations with concrete code, configuration, command, or output examples so pages do not become walls of text.
- Put the relevant example immediately after the text that introduces it, following `content/build/plugins/cli.mdx` as the reference pattern.
- Every subsection that explains syntax, fields, or an API concept must include its own minimal example. A larger example earlier on the page does not count.
- Split long explanations with meaningful headings and examples rather than accumulating caveats in one paragraph.
- Lead with the common task and working example; place edge cases and supporting details afterward.
- Do not stack several prose paragraphs without a visual break. After introducing a concept, use an example, list, table, or task-oriented subheading before covering the next concern.
- Use bullets or tables for independent rules, options, and constraints. Do not hide reference material in narrative paragraphs.
- Organize workflow documentation in the order readers perform it, with a working example at each major step.

## Validation

- Run `bun typecheck` and `bun run build` from `services/www` after changes.
- Check desktop and mobile layouts when changing navigation or shared styles.
