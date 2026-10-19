import { frameLoop } from "./loop"
import { observeReducedMotion, prefersReducedMotion } from "./reduced"
import { ease } from "./waapi"

interface Row<T> {
  item: T
  el: HTMLElement
  exiting: boolean
  fresh: boolean
  animation: Animation | undefined
  revision: number
  height: number
  fromHeight: number
  fromOpacity: string
  opacity: string
  overflow: string
}

/** Owns only its rendered children. Shared keys retain the same DOM node and event handlers. */
export function keyedPresence<T, K>(options: {
  container: HTMLElement
  key: (item: T) => K
  create: (item: T) => HTMLElement
  update?: (el: HTMLElement, item: T) => void
  destroy?: (el: HTMLElement, item: T) => void
  duration?: number
}) {
  const rows = new Map<K, Row<T>>()
  let order: K[] = []
  let cancelFrame: (() => void) | undefined
  let disposed = false
  let animateChanges = false

  const removeRow = (key: K, row: Row<T>) => {
    row.revision++
    row.animation?.cancel()
    rows.delete(key)
    row.el.remove()
    options.destroy?.(row.el, row.item)
  }

  const createRow = (item: T, key: K) => {
    const el = options.create(item)

    const row: Row<T> = {
      item,
      el,
      exiting: false,
      fresh: true,
      animation: undefined,
      revision: 0,
      height: 0,
      fromHeight: 0,
      fromOpacity: "0",
      opacity: "0",
      overflow: el.style.overflow,
    }

    rows.set(key, row)

    return row
  }

  const restore = (row: Row<T>) => {
    row.el.style.height = ""
    row.el.style.opacity = ""
    row.el.style.overflow = row.overflow
    row.el.inert = false
    row.el.removeAttribute("data-exiting")
  }

  const finish = (key: K, row: Row<T>, exit: boolean) => {
    if (exit) {
      removeRow(key, row)

      return
    }

    row.fresh = false
    restore(row)
  }

  const settle = () => {
    for (const [key, row] of rows) {
      row.revision++
      row.animation?.cancel()
      row.animation = undefined
      finish(key, row, row.exiting)
    }
  }

  const unsubscribe = observeReducedMotion(() => {
    if (prefersReducedMotion()) {
      cancelFrame?.()
      cancelFrame = undefined
      settle()
    }
  })

  function update(items: readonly T[], { snap = false }: { snap?: boolean } = {}) {
    if (disposed) return
    const keys = items.map(options.key)

    if (new Set(keys).size !== keys.length) throw new Error("Duplicate presence key")
    order = keys
    const wanted = new Set(keys)

    // Batch geometry reads before any reordering or DOM writes.
    for (const row of rows.values()) {
      row.height = row.el.getBoundingClientRect().height
      row.opacity = getComputedStyle(row.el).opacity
    }

    for (const [key, row] of rows) {
      if (wanted.has(key)) continue

      if (!row.exiting) {
        row.revision++
        row.animation?.cancel()
        row.animation = undefined
        row.exiting = true
        row.el.inert = true
        row.el.setAttribute("data-exiting", "")
      }
    }

    let anchor: ChildNode | null = options.container.firstChild

    for (let i = 0; i < items.length; i++) {
      const item = items[i]!
      const key = keys[i]!
      const existing = rows.get(key)

      if (existing?.exiting) {
        existing.revision++
        existing.animation?.cancel()
        existing.animation = undefined
        existing.exiting = false
        existing.fresh = true
        existing.fromHeight = existing.height
        existing.fromOpacity = existing.opacity
        restore(existing)
        existing.el.style.height = `${existing.fromHeight}px`
        existing.el.style.opacity = existing.fromOpacity
      }

      const row = existing ?? createRow(item, key)

      row.item = item
      options.update?.(row.el, item)

      if (row.el !== anchor) options.container.insertBefore(row.el, anchor)
      anchor = row.el.nextSibling
    }

    animateChanges = !snap && !prefersReducedMotion()
    cancelFrame?.()
    cancelFrame = undefined

    if (!animateChanges) {
      settle()

      return
    }

    cancelFrame = frameLoop.addMeasured(
      () => {
        for (const row of rows.values()) {
          if (row.fresh && !row.exiting) row.height = row.el.scrollHeight
        }
      },
      () => {
        cancelFrame = undefined

        for (const [key, row] of rows) {
          if ((!row.fresh && !row.exiting) || row.animation) continue

          if (!row.el.animate) {
            finish(key, row, row.exiting)
            continue
          }

          const revision = ++row.revision
          const exit = row.exiting
          row.el.style.overflow = "hidden"

          const animation = row.el.animate(
            exit
              ? [
                  { height: `${row.height}px`, opacity: row.opacity },
                  { height: "0px", opacity: 0 },
                ]
              : [
                  { height: `${row.fromHeight}px`, opacity: row.fromOpacity },
                  { height: `${row.height}px`, opacity: 1 },
                ],
            { duration: options.duration ?? (exit ? 220 : 260), easing: ease.out, fill: "both" },
          )

          row.animation = animation

          const done = () => {
            if (disposed || revision !== row.revision) return
            row.animation = undefined
            animation.cancel()
            finish(key, row, exit)
          }

          void animation.finished.then(done, done)
        }

        return false
      },
    )
  }

  return {
    update,
    keys: (): readonly K[] => order,
    get: (key: K): HTMLElement | undefined => rows.get(key)?.el,
    dispose: () => {
      disposed = true
      cancelFrame?.()
      unsubscribe()

      for (const [key, row] of rows) removeRow(key, row)
    },
  }
}
