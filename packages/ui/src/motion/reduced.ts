const query = "(prefers-reduced-motion: reduce)"

let source: typeof matchMedia | undefined

let result: MediaQueryList | undefined

const listeners = new Set<() => void>()

const notify = () => {
  for (const listener of listeners) listener()
}

function media(): MediaQueryList | undefined {
  const match = globalThis.matchMedia

  if (!match) return undefined

  if (source !== match) {
    result?.removeEventListener("change", notify)
    source = match
    result = match(query)

    if (listeners.size > 0) result.addEventListener("change", notify)
  }

  return result
}

export const prefersReducedMotion = (): boolean => media()?.matches ?? false

/** Also settle active WAAPI jobs when the preference changes mid-animation. SSR-safe. */
export function observeReducedMotion(listener: () => void): () => void {
  const preference = media()

  if (!preference) return () => {}

  if (listeners.size === 0) preference.addEventListener("change", notify)
  listeners.add(listener)

  return () => {
    if (!listeners.delete(listener) || listeners.size > 0) return
    result?.removeEventListener("change", notify)
  }
}
