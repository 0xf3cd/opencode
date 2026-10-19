import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { captureMarkdownSelection, parseMarkdownNodes, restoreMarkdownSelection } from "./markdown-solid"

beforeAll(() => GlobalRegistrator.register())

afterAll(() => GlobalRegistrator.unregister())

test("assigns stable paths to elements and individual words", () => {
  expect(parseMarkdownNodes('<p class="lead">Hello <strong>streaming</strong> world</p>', true)).toEqual([
    {
      key: "0",
      type: "element",
      tag: "p",
      attributes: { class: "lead" },
      children: [
        { key: "0.0:0", type: "word", text: "Hello" },
        { key: "0.0:1", type: "text", text: " " },
        {
          key: "0.1",
          type: "element",
          tag: "strong",
          attributes: {},
          children: [{ key: "0.1.0:0", type: "word", text: "streaming" }],
        },
        { key: "0.2:1", type: "text", text: " " },
        { key: "0.2:2", type: "word", text: "world" },
      ],
    },
  ])
})

test("keeps completed block text compact", () => {
  expect(parseMarkdownNodes("<p>Hello world</p>", false)).toEqual([
    {
      key: "0",
      type: "element",
      tag: "p",
      attributes: {},
      children: [{ key: "0.0", type: "text", text: "Hello world" }],
    },
  ])
})

test("marks streamed inline code for animation", () => {
  expect(parseMarkdownNodes("<p><code>file.ts:29-43</code></p>", true, true)).toEqual([
    {
      key: "0",
      type: "element",
      tag: "p",
      attributes: {},
      children: [
        {
          key: "0.0",
          type: "element",
          tag: "code",
          attributes: {},
          children: Array.from("file.ts:29-43", (text, index) => ({
            key: `0.0.0:${index}`,
            type: "word",
            text,
            animate: true,
          })),
          animate: true,
        },
      ],
    },
  ])
})

test("marks words for animation only when requested", () => {
  expect(
    parseMarkdownNodes("<p>Hello</p>", true).flatMap((node) => (node.type === "element" ? node.children : [node]))[0],
  ).toEqual({
    key: "0.0:0",
    type: "word",
    text: "Hello",
  })
  expect(
    parseMarkdownNodes("<p>Hello</p>", true, true).flatMap((node) =>
      node.type === "element" ? node.children : [node],
    )[0],
  ).toEqual({
    key: "0.0:0",
    type: "word",
    text: "Hello",
    animate: true,
  })
})

test("preserves text selection when replacing word-wrapped live DOM with settled HTML", () => {
  const block = document.createElement("div")
  block.innerHTML =
    '<p><span data-markdown-word="">Hello</span> <strong><span data-markdown-word="">world</span></strong> <span data-markdown-word="">again</span></p>'
  document.body.appendChild(block)

  const range = document.createRange()
  range.selectNodeContents(block.querySelector("strong")!)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  expect(selection.toString()).toBe("world")

  const saved = captureMarkdownSelection(block)
  expect(saved).toEqual({
    start: { kind: "inside", offset: 6 },
    end: { kind: "inside", offset: 11 },
  })

  block.innerHTML = "<p>Hello <strong>world</strong> again</p>"
  expect(block.querySelectorAll("[data-markdown-word]").length).toBe(0)
  restoreMarkdownSelection(block, saved!)
  expect(window.getSelection()?.toString()).toBe("world")
  block.remove()
})
