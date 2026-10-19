export interface SpringOptions {
  omega?: number
  zeta?: number
}

export interface DurationOptions {
  duration: number
  bounce: number
}

/** Unit-mass spring. Semi-implicit Euler, matching the hosted 480 Hz integrator. */
export class Spring {
  value: number
  target: number
  velocity = 0
  omega: number
  zeta: number

  constructor(value: number, { omega = 26, zeta = 0.86 }: SpringOptions = {}) {
    if (
      !Number.isFinite(value) ||
      !Number.isFinite(omega) ||
      omega <= 0 ||
      omega > 240 ||
      !Number.isFinite(zeta) ||
      zeta < 0 ||
      zeta > 2 ||
      omega / 480 >= 2 * (Math.sqrt(1 + zeta * zeta) - zeta)
    ) {
      throw new RangeError(
        "Spring requires a finite value, omega in (0, 240], zeta in [0, 2], and stable 480 Hz coefficients",
      )
    }

    this.value = this.target = value
    this.omega = omega
    this.zeta = zeta
  }

  /** SwiftUI's nonnegative bounce mapping: omega = 2π / duration; zeta = 1 − bounce. */
  static fromDuration(value: number, { duration, bounce }: DurationOptions): Spring {
    if (
      !Number.isFinite(duration) ||
      duration < (2 * Math.PI) / 240 ||
      !Number.isFinite(bounce) ||
      bounce < 0 ||
      bounce >= 1
    ) {
      throw new RangeError("duration must be >= 2π/240 seconds; bounce must be in [0, 1)")
    }

    return new Spring(value, { omega: (2 * Math.PI) / duration, zeta: 1 - bounce })
  }

  set(target: number, options?: { velocity?: number }): this {
    if (!Number.isFinite(target) || (options?.velocity !== undefined && !Number.isFinite(options.velocity)))
      throw new RangeError("Non-finite spring target or velocity")
    this.target = target

    if (options?.velocity !== undefined) this.velocity = options.velocity

    return this
  }

  snap(value: number): this {
    if (!Number.isFinite(value)) throw new RangeError("Non-finite spring value")
    this.value = this.target = value
    this.velocity = 0

    return this
  }

  step(dt: number): number {
    if (this.value === this.target && this.velocity === 0) return this.value
    const end = Number.isFinite(dt) ? Math.min(0.1, Math.max(0, dt)) : 0
    const stiffness = this.omega * this.omega
    const damping = 2 * this.zeta * this.omega

    for (let t = 0; t < end; t += 1 / 480) {
      const h = Math.min(1 / 480, end - t)
      this.velocity += (-stiffness * (this.value - this.target) - damping * this.velocity) * h
      this.value += this.velocity * h
    }

    if (this.resting) this.snap(this.target)

    return this.value
  }

  get resting(): boolean {
    return Math.abs(this.value - this.target) < 0.005 && Math.abs(this.velocity) < 0.02
  }
}
