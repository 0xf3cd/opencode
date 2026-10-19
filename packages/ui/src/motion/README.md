# Motion

Springs, a shared frame loop and DOM animation controllers for the UI packages.

- `@opencode/ui/motion`: physics and DOM controllers. No Solid imports.
- `@opencode/ui/motion/solid`: Solid primitives (`springStyle`, `slidingHighlight`, `widthMorph`, `numberTween`), plus re-exports of `keyedPresence` and `steppedSlider`.

## Provenance

Vendored from Kit Langton's `@problems/motion` (`team-board` repo, `packages/motion`, commit `873f5d5`). Behaviour is unchanged. The port applies this repo's formatting and lint rules, removes `else` branches, and moves tests to Bun: pure tests in `core.test.ts`, DOM and Solid tests in `packages/app/test-browser/motion-dom.test.ts` (happy-dom with Solid's browser build). The playground and the SwiftUI comparison script were not carried over. To re-sync, diff the upstream package against `873f5d5` and apply the changes here.

Hot paths deliberately use indexed `for` loops and an intrusive linked list, so the loop allocates no arrays, closures or job snapshots per frame. V8 still boxes some doubles at call boundaries: in headless Chromium, 1,000 `springStyle` values allocate about 80–130 bytes each per frame, a quarter of what `motion`'s `useSpring` path allocates.

## API

```ts
// Unit-mass spring, integrated with semi-implicit Euler at a fixed 480 Hz substep.
class Spring {
  constructor(value: number, options?: { omega?: number; zeta?: number }) // defaults omega 26, zeta 0.86
  static fromDuration(value: number, options: { duration: number; bounce: number }): Spring // SwiftUI parameters
  value: number
  target: number
  velocity: number
  set(target: number, options?: { velocity?: number }): this
  snap(value: number): this
  step(dt: number): number // seconds; clamps dt to 0.1; returns value
  readonly resting: boolean
}

// One shared requestAnimationFrame loop. A job returns true while it still needs frames.
const frameLoop: {
  add(job: (dt: number) => boolean): () => void
  addMeasured(read: () => void, write: (dt: number) => boolean): () => void
}
function createFrameLoop(scheduler?: { request(callback: (time: number) => void): number; cancel(id: number): void })

const prefersReducedMotion: () => boolean // live matchMedia
function observeReducedMotion(listener: () => void): () => void

class VelocityTracker {
  push(x: number, y: number, t: number): void
  velocity(): { x: number; y: number } // px/s over the last ~90 ms
  reset(): void
}

// Short WAAPI entrances for elements that genuinely appear; no-ops under reduced motion.
function enter(el: Element, options?: { x?; y?; scale?; duration?; delay?; easing?; restart? }): void
// Single-node FLIP from a previous rect to the element's current box.
function slideFrom(el: HTMLElement, previous: DOMRect, options?: { duration?: number }): void
const ease: { out: string; pop: string }

function keyedPresence<T, K>(options): { update; keys; get; dispose }
function steppedSlider(options): { set; configure; value; displayed; dispose }
function sliderStops(spec)
function sliderValue(spec, value)
function sliderStep(spec, value, direction, count?)
function sliderFraction(spec, value)
```

## Springs match SwiftUI's nonnegative bounce mapping

```ts
const open = Spring.fromDuration(0, { duration: 0.42, bounce: 0.18 })
const close = Spring.fromDuration(0, { duration: 0.36, bounce: 0.08 })
```

For mass `m = 1`, duration `d` in seconds and bounce `b`:

```
ω = 2π / d
ζ = 1 − b
stiffness k = ω²
damping c = 2ζω
acceleration = −k(value − target) − c·velocity
```

`step()` uses semi-implicit Euler at 480 Hz, with a fractional last substep and a 100 ms frame clamp. Retargeting preserves velocity unless you supply a new velocity. Rest snaps exactly when displacement is below `0.005` and speed is below `0.02` units/s.

The mapping was checked against native `SwiftUI.Spring` on macOS. At `d = 0.42, b = 0.18`, SwiftUI returns `k = 223.80055331268386` and `c = 24.534342628034576`; `core.test.ts` pins these values.

Apple calls duration an approximate settling duration. It is a pace parameter, not a timeout. A critically damped spring reaches 98% around `0.93d`. Bounce `0.3` corresponds to `ζ = 0.7` and about 4.6% overshoot, not 30%.

`fromDuration` accepts `d >= 2π/240` and `0 <= b < 1`. Negative Apple bounce has a different mapping and is unsupported; bounce `1` never settles. The constructor accepts `omega` in `(0, 240]` and `zeta` in `[0, 2]`, and rejects combinations that are unstable for the 480 Hz integrator.

## Measure before writing

`frameLoop.addMeasured(read, write)` runs every registered read before any write, so layout reads never interleave with style writes. New jobs join the next frame; removing a job during either phase prevents its remaining work. The loop cancels rAF when its last job is removed. The first frame after sleep uses `1/60` s; later frames use clamped elapsed time.

`createFrameLoop(scheduler?)` provides the same API with an injectable scheduler for tests. Core springs do not consult accessibility settings; DOM primitives do, and settle when the preference changes, including pending WAAPI exits.

## Solid owns targets; motion owns displayed values

```ts
springStyle(
  () => button,
  () => ({ width: selected() ? 84 : 22 }),
  (el, v) => {
    el.style.width = `${v.width}px`
  },
)
```

Call Solid helpers inside an owner; they release jobs and observers on cleanup. Signals supply targets only. Paint callbacks must write directly to the DOM, not to signals. `springStyle` reuses its value record; do not retain it. New refs and the first target snap; later targets preserve velocity.

`slidingHighlight` expects the positioned container to be the selected row's offset parent. The highlight owns `transform` and the active axis's width/height. It measures for 420 ms after changes and observes container and selected-row resizes. `spring(distance)` may choose each trip's curve; `paint(box)` receives each written box.

`widthMorph({ ref, content, watch, spring, inset })` clones content once per target change, measures its hidden `max-content` width in the shared read phase, and removes the clone in the write phase. It writes outer width and gives content `width: 100%`. `watch` must include any state that changes natural content width. The default spring is `0.42 / 0.18`, with `inset: 4`. Give the pill `box-sizing: border-box; padding: 4px`, content `display: flex; min-width: 0`, and keep width and opacity on separate nodes.

`numberTween({ ref, value, format })` springs a number and updates `textContent` only when the formatted text changes.

## Keyed rows retain nodes through exits

```ts
const rows = keyedPresence({
  container,
  key: (spec: ParamSpec) => spec.key,
  create: (spec) => makeRow(spec),
  update: (el, spec) => updateRow(el, spec),
  destroy: (el, spec) => disposeRow(el, spec),
})
rows.update(params, { snap: firstRun })
onCleanup(rows.dispose)
```

Shared keys retain the same node. Live rows follow input order; outgoing rows stay mounted and inert until their height/opacity animation finishes (entrance 260 ms, exit 220 ms by default). Returning keys reuse their exiting node and start from its measured pose. `destroy` runs only on actual removal or disposal. Duplicate keys throw before mutation. Without WAAPI, or under reduced motion, rows are removed immediately. The container should contain only these rows, and each row wrapper should have no vertical margin or padding so height zero fully collapses it.

## Slider input and paint are separate

```ts
const slider = steppedSlider({
  el,
  spec: { min: 1, max: 5, step: 1 },
  value: 2,
  onChange: setLevel, // input only; may write a signal
  paint: (value, fraction) => {
    // rAF only; never write a signal
    fill.style.transform = `scaleX(${fraction})`
  },
  resetValue: 2,
  onCommit: (value) => save(value),
})
```

The controller measures its track on pointer down, captures the pointer, and handles release, cancellation and lost capture. Sliders with at most 10 stops spring between stops while dragging; denser sliders follow the pointer exactly. Programmatic values and arrow keys spring unless `snap` or reduced motion applies. Double-click and Backspace reset. Supply an accessible name on `el`; the controller supplies role, range attributes and a tabindex.

## Verify

- `bun test src/motion` from `packages/ui`
- `bun test --conditions=browser --isolate --preload ./happydom.ts ./test-browser/motion-dom.test.ts` from `packages/app`
- `bun run bench:motion` from `packages/ui`: retargets 1,000 springs every frame and reports per-frame integration time
