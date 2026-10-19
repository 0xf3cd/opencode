const query = "(prefers-reduced-motion: reduce)"

let source: typeof matchMedia | undefined

let result: MediaQueryList | undefined

function media(): MediaQueryList | undefined {
  if (!("matchMedia" in globalThis)) return undefined

  if (source !== matchMedia) {
    source = matchMedia
    result = matchMedia(query)
  }

  return result
}

export const prefersReducedMotion = (): boolean => media()?.matches ?? false

/** Also settle active WAAPI jobs when the preference changes mid-animation. SSR-safe. */
export function observeReducedMotion(listener: () => void): () => void {
  const preference = media()

  if (!preference) return () => {}

  preference.addEventListener("change", listener)

  return () => preference.removeEventListener("change", listener)
}
