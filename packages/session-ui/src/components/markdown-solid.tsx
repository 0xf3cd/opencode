import { For, onMount } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Dynamic, render } from "solid-js/web"

type MarkdownNode =
  | {
      key: string
      type: "element"
      tag: string
      attributes: Record<string, string>
      children: MarkdownNode[]
      animate?: true
    }
  | { key: string; type: "text"; text: string }
  | { key: string; type: "word"; text: string; animate?: true }

export function createMarkdownRenderer(root: HTMLDivElement, html: string, words: boolean) {
  const [nodes, setNodes] = createStore(parseMarkdownNodes(html, words))
  let ready = false

  const dispose = render(
    () => <For each={nodes}>{(node) => <MarkdownDomNode node={node} animate={() => ready} />}</For>,
    root,
  )

  ready = true

  return {
    update(next: string, nextWords: boolean, animate = true) {
      setNodes(reconcile(parseMarkdownNodes(next, nextWords, animate), { key: "key" }))
    },
    dispose,
  }
}

function MarkdownDomNode(props: { node: MarkdownNode; animate: () => boolean }) {
  const node = props.node

  if (node.type === "text") return node.text

  if (node.type === "word") {
    let ref: HTMLSpanElement | undefined
    onMount(() => {
      if (props.animate() && node.animate) ref?.setAttribute("data-markdown-enter", "")
    })

    return (
      <span ref={ref} data-markdown-word="">
        {node.text}
      </span>
    )
  }

  let ref: HTMLElement | undefined
  onMount(() => {
    if (props.animate() && node.animate) ref?.setAttribute("data-markdown-enter", "")
  })

  return (
    <Dynamic component={node.tag} ref={ref} {...node.attributes}>
      <For each={node.children}>{(node) => <MarkdownDomNode node={node} animate={props.animate} />}</For>
    </Dynamic>
  )
}

export function parseMarkdownNodes(html: string, words: boolean, animate = false) {
  const template = document.createElement("template")
  template.innerHTML = html

  return Array.from(template.content.childNodes).flatMap((node, index) => parseNode(node, `${index}`, words, animate))
}

function parseNode(node: Node, key: string, words: boolean, animate: boolean, inlineCode = false): MarkdownNode[] {
  if (node instanceof Text) {
    if (!words) return [{ key, type: "text", text: node.data }]

    return (inlineCode ? Array.from(node.data) : node.data.split(/(\s+)/)).flatMap((text, index): MarkdownNode[] => {
      if (!text) return []

      if (/^\s+$/.test(text)) return [{ key: `${key}:${index}`, type: "text", text }]

      const item: MarkdownNode = { key: `${key}:${index}`, type: "word", text }

      if (animate) item.animate = true

      return [item]
    })
  }

  if (!(node instanceof Element)) return []

  const element: Extract<MarkdownNode, { type: "element" }> = {
    key,
    type: "element",
    tag: node.tagName.toLowerCase(),
    attributes: Object.fromEntries(Array.from(node.attributes).map((attribute) => [attribute.name, attribute.value])),
    children: Array.from(node.childNodes).flatMap((child, index) =>
      parseNode(
        child,
        `${key}.${index}`,
        words,
        animate,
        inlineCode || (node.tagName === "CODE" && node.parentElement?.tagName !== "PRE"),
      ),
    ),
  }

  if (words && animate && node.tagName === "CODE" && node.parentElement?.tagName !== "PRE") {
    element.animate = true
  }

  return [element]
}

type SavedBoundary =
  | { kind: "inside"; offset: number }
  | { kind: "outside"; node: Node; offset: number }

export type SavedMarkdownSelection = {
  start: SavedBoundary
  end: SavedBoundary
}

function isIgnoredSelectionNode(node: Node) {
  return (
    node instanceof Element &&
    (node.getAttribute("data-slot") === "markdown-copy-button" ||
      node.getAttribute("data-component") === "markdown-mermaid")
  )
}

function textNodes(node: Node): Text[] {
  if (isIgnoredSelectionNode(node)) return []

  if (node instanceof Text) return [node]

  return Array.from(node.childNodes).flatMap(textNodes)
}

function charOffset(root: Node, target: Node, offset: number) {
  let total = 0
  let found = false

  const walk = (node: Node) => {
    if (found || isIgnoredSelectionNode(node)) return

    if (node === target) {
      if (node instanceof Text) {
        total += Math.min(offset, node.data.length)
        found = true

        return
      }

      Array.from(node.childNodes).slice(0, offset).forEach(walk)
      found = true

      return
    }

    if (node instanceof Text) {
      total += node.data.length

      return
    }

    Array.from(node.childNodes).forEach(walk)
  }

  walk(root)

  return found ? total : undefined
}

function findTextPosition(root: Node, targetOffset: number, preferEnd: boolean) {
  const nodes = textNodes(root)
  let remaining = targetOffset

  for (const node of nodes) {
    const matches = preferEnd ? remaining <= node.data.length : remaining < node.data.length

    if (matches) return { node, offset: remaining }
    remaining -= node.data.length
  }

  const last = nodes.at(-1)

  return last ? { node: last, offset: last.data.length } : undefined
}

export function captureMarkdownSelection(root: HTMLElement): SavedMarkdownSelection | undefined {
  const selection = window.getSelection()

  if (!selection || selection.rangeCount === 0) return
  const range = selection.getRangeAt(0)

  if (range.collapsed) return
  const startInside = root.contains(range.startContainer)
  const endInside = root.contains(range.endContainer)

  if (!startInside && !endInside) return
  const startOffset = startInside ? charOffset(root, range.startContainer, range.startOffset) : undefined
  const endOffset = endInside ? charOffset(root, range.endContainer, range.endOffset) : undefined

  if ((startInside && startOffset === undefined) || (endInside && endOffset === undefined)) return

  return {
    start: startInside
      ? { kind: "inside", offset: startOffset! }
      : { kind: "outside", node: range.startContainer, offset: range.startOffset },
    end: endInside
      ? { kind: "inside", offset: endOffset! }
      : { kind: "outside", node: range.endContainer, offset: range.endOffset },
  }
}

export function restoreMarkdownSelection(root: HTMLElement, saved: SavedMarkdownSelection) {
  const selection = window.getSelection()

  if (!selection) return
  const start = saved.start.kind === "inside" ? findTextPosition(root, saved.start.offset, false) : saved.start
  const end = saved.end.kind === "inside" ? findTextPosition(root, saved.end.offset, true) : saved.end

  if (!start || !end || !start.node.isConnected || !end.node.isConnected) return
  const range = document.createRange()
  range.setStart(start.node, start.offset)
  range.setEnd(end.node, end.offset)
  selection.removeAllRanges()
  selection.addRange(range)
}
