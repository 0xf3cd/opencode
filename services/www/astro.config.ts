import cloudflare from "@astrojs/cloudflare"
import mdx from "@astrojs/mdx"
import { unified } from "@astrojs/markdown-remark"
import { defineConfig } from "astro/config"
import { fileURLToPath } from "node:url"
import { defaultLocale, docsLocaleKeys } from "./src/docs/lib/language"
import remarkDocsLinks from "./src/docs/remark-links"
import remarkTranslatedHeadings from "./src/docs/remark-translated-headings"

const base = "/v2/"

export default defineConfig({
  site: process.env.CLOUDFLARE_ENV === "production" ? "https://opencode.ai" : "https://dev.opencode.ai",
  base,
  output: "server",
  adapter: cloudflare({ imageService: "passthrough" }),
  integrations: [mdx()],
  markdown: {
    processor: unified({
      remarkPlugins: [
        [remarkDocsLinks, { base }],
        [
          remarkTranslatedHeadings,
          {
            content: fileURLToPath(new URL("./src/docs/content", import.meta.url)),
            locales: docsLocaleKeys.filter((locale) => locale !== defaultLocale),
          },
        ],
      ],
    }),
    shikiConfig: {
      themes: {
        light: "github-light",
        dark: "github-dark",
      },
      transformers: [
        {
          name: "code-block-title",
          root(root) {
            const title = this.options.meta?.__raw?.match(/title="([^"]+)"/)?.[1]
            if (!title) return
            const pre = root.children[0]
            if (!pre || pre.type !== "element") return
            root.children = [
              {
                type: "element",
                tagName: "figure",
                properties: { className: ["astro-code-figure"] },
                children: [
                  {
                    type: "element",
                    tagName: "figcaption",
                    properties: { className: ["astro-code-title"] },
                    children: [{ type: "text", value: title }],
                  },
                  pre,
                ],
              },
            ]
          },
        },
      ],
    },
  },
  vite: {
    server: {
      allowedHosts: true,
    },
  },
})
