/** Fades a copy of `element` out where it is on screen, for an element that is about to unmount without an exit. */
export function leaveInPlace(element: HTMLElement, duration = 110) {
  const box = element.getBoundingClientRect()

  if (box.width < 1 || box.height < 1) return
  const style = getComputedStyle(element)
  const copy = element.cloneNode(true) as HTMLElement
  copy.removeAttribute("data-component")
  copy.removeAttribute("role")
  copy.setAttribute("aria-hidden", "true")
  Object.assign(copy.style, {
    position: "fixed",
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
    margin: "0",
    pointerEvents: "none",
    zIndex: "1000",
    font: style.font,
    letterSpacing: style.letterSpacing,
    color: style.color,
    opacity: style.opacity,
  })
  document.body.append(copy)
  copy
    .animate([{ opacity: style.opacity }, { opacity: 0 }], { duration, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" })
    .finished.finally(() => copy.remove())
}
