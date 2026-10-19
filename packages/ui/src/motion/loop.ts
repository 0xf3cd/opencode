export type FrameJob = (dt: number) => boolean

export interface FrameScheduler {
  request(callback: (time: number) => void): number
  cancel(id: number): void
}

interface Entry {
  job: FrameJob
  read: (() => void) | undefined
  active: boolean
  next: Entry | undefined
}

/** Intrusive list: no arrays, iterators, closures or job snapshots allocated per frame. */
export function createFrameLoop(
  scheduler: FrameScheduler = {
    request: (callback) => requestAnimationFrame(callback),
    cancel: (id) => cancelAnimationFrame(id),
  },
) {
  let head: Entry | undefined
  let tail: Entry | undefined
  let pending: number | undefined
  let previous: number | undefined
  let running = false

  function compact() {
    let node = head
    let last: Entry | undefined
    head = undefined

    while (node) {
      if (node.active) {
        if (last) last.next = node
        head ??= node
        last = node
      }

      node = node.next
    }

    if (last) last.next = undefined
    tail = last
  }

  function wake() {
    if (pending === undefined && !running && head) pending = scheduler.request(tick)
  }

  function tick(now: number) {
    pending = undefined
    running = true
    const dt = previous === undefined ? 1 / 60 : Math.max(0, Math.min(0.1, (now - previous) / 1000))
    previous = now
    // New jobs join the next frame. Removal only marks nodes, preserving traversal.
    const end = tail

    try {
      for (let node = head; node; node = node.next) {
        if (node.active && node.read) {
          try {
            node.read()
          } catch (error) {
            node.active = false
            throw error
          }
        }

        if (node === end) break
      }

      for (let node = head; node; node = node.next) {
        if (node.active) {
          try {
            if (!node.job(dt)) node.active = false
          } catch (error) {
            node.active = false
            throw error
          }
        }

        if (node === end) break
      }
    } finally {
      running = false
      compact()

      if (!head) previous = undefined
      wake()
    }
  }

  function add(job: FrameJob, read?: () => void): () => void {
    const entry: Entry = { job, read, active: true, next: undefined }

    if (tail) tail.next = entry
    head ??= entry
    tail = entry
    wake()

    return () => {
      entry.active = false

      if (running) return
      compact()

      if (!head) {
        if (pending !== undefined) scheduler.cancel(pending)
        pending = previous = undefined
      }
    }
  }

  return { add, addMeasured: (read: () => void, write: FrameJob) => add(write, read) }
}

export const frameLoop = createFrameLoop()
