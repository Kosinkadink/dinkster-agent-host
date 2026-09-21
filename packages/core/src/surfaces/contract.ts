/**
 * Control-surface type contract (architecture section 6).
 *
 * Control surfaces are canvas-resident panels that are NOT nodes: no ports,
 * no types, no presence in compilation. The document stores them generically
 * (ControlSurfaceData: type tag + JSON config); this registry is where each
 * surface TYPE declares its typed shape. Same rule as widgets, commands, and
 * menus: ONE typed registry that core and extensions use identically - no
 * monkey patching, no private hooks.
 *
 * A definition owns exactly one job here: decoding the stored JSON config
 * into its typed form, with malformed input yielding DIAGNOSTICS - never a
 * crash, never a silent rewrite of the document. Everything downstream
 * (rendering the panel, resolving bindings, dispatching commands) consumes
 * the decoded config; nothing re-reads raw JSON ad hoc.
 *
 * Commands stay registry-blind by design (the same way they are
 * schema-blind): surface.add/update accept any structurally-valid config, so
 * a document written by a newer client or an absent extension remains
 * editable. Typed validation is advisory - a surface whose type has no
 * registered definition renders as a "unknown surface type" shell, not an
 * error state that blocks the document.
 */

import { diag, type Diagnostic } from '../diagnostics.js'
import type { JsonObject } from '../format/document.js'

/** Outcome of decoding a stored surface config into its typed form. */
export type SurfaceDecodeResult<C> =
  | {
      readonly ok: true
      readonly config: C
      /** Non-fatal oddities (e.g. bindings of an unknown future kind). */
      readonly diagnostics: readonly Diagnostic[]
    }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] }

export interface SurfaceTypeDefinition<C = unknown> {
  /** Registered surface type tag (e.g. 'core.modePanel'). */
  readonly type: string
  /** Human label for creation UIs. */
  readonly title: string
  decode(config: JsonObject): SurfaceDecodeResult<C>
}

export interface SurfaceRegistry {
  /** Throws on duplicate type (registration bugs fail loudly, like commands). */
  register(def: SurfaceTypeDefinition): () => void
  get(type: string): SurfaceTypeDefinition | undefined
  types(): readonly SurfaceTypeDefinition[]
}

export function createSurfaceRegistry(
  defs: readonly SurfaceTypeDefinition[] = [],
): SurfaceRegistry {
  const map = new Map<string, SurfaceTypeDefinition>()
  const register = (def: SurfaceTypeDefinition): (() => void) => {
    if (map.has(def.type)) throw new Error(`surface type '${def.type}' already registered`)
    map.set(def.type, def)
    return () => {
      map.delete(def.type)
    }
  }
  for (const def of defs) register(def)
  return {
    register,
    get: (type) => map.get(type),
    types: () => [...map.values()],
  }
}

/** Shared helper for decoders: one malformed-config error diagnostic. */
export const surfaceConfigError = (type: string, message: string): Diagnostic =>
  diag('error', 'schema', 'surface.config.invalid', `${type}: ${message}`)
