/**
 * Minimal signal store. Plain-TS reactivity the core OWNS: the canvas
 * and shell subscribe to these directly; no framework refs in the hot path
 * (architecture section 14). Deliberately tiny - get/set/subscribe - because
 * derived state is computed at use sites.
 */

export interface ReadonlySignal<T> {
  get(): T
  /** Subscribe to changes. Returns an unsubscribe function. Not called on subscribe. */
  subscribe(listener: (value: T) => void): () => void
}

export interface Signal<T> extends ReadonlySignal<T> {
  set(value: T): void
  update(fn: (value: T) => T): void
}

export function createSignal<T>(
  initial: T,
  equals: (a: T, b: T) => boolean = Object.is,
  /**
   * Isolation sink (CO10): a throwing subscriber must not starve later
   * subscribers or unwind into the code that set the value. Defaults to
   * console.error so failures stay diagnosable.
   */
  onListenerError: (error: unknown) => void = (error) => {
    // eslint-disable-next-line no-console
    console.error('[signal] subscriber threw:', error)
  },
): Signal<T> {
  let value = initial
  const listeners = new Set<(v: T) => void>()
  return {
    get: () => value,
    set(next: T) {
      if (equals(value, next)) return
      value = next
      // Snapshot so a listener unsubscribing mid-notify cannot skip others.
      for (const l of [...listeners]) {
        try {
          l(next)
        } catch (e) {
          // The sink is caller-injected and therefore just as capable of
          // throwing as the listener; a throwing sink must not unwind
          // into set() after the value has already changed.
          try {
            onListenerError(e)
          } catch (sinkError) {
            // eslint-disable-next-line no-console
            console.error('[signal] error sink threw:', sinkError)
          }
        }
      }
    },
    update(fn: (v: T) => T) {
      this.set(fn(value))
    },
    subscribe(listener: (v: T) => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
