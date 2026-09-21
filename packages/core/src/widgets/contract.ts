/**
 * WidgetKind / WidgetView / PreviewRenderer contracts v1.
 *
 * The split: WidgetKind owns SEMANTICS (value schema, validation, defaults);
 * WidgetView owns PRESENTATION (compact canvas drawing + declarative host UI).
 * One kind may have many views; views are user-switchable; the stored value
 * never changes shape when the view changes.
 *
 * Core widgets register through this exact public API - zero private hooks.
 */

import type { Diagnostic } from '../diagnostics.js'
import type { Json } from '../format/document.js'
import type { WidgetSpec } from '../schema/model.js'
import type { HostUiProviderV1 } from '../ui/contribution.js'

// ---------------------------------------------------------------------------
// Scoped services handed to widget/preview code (NO ambient fetch/DOM access)
// ---------------------------------------------------------------------------

/** The only network access widget/preview code gets. Same-origin, cached, deduped. */
export interface ScopedClient {
  query(route: string, params: Readonly<Record<string, Json>>): Promise<unknown>
  /** Resolve a media resource template to a streamable URL. */
  mediaUrl(route: string, params: Readonly<Record<string, string>>): string
}

export interface WidgetEnv {
  readonly client: ScopedClient
}

// ---------------------------------------------------------------------------
// WidgetKind (semantics)
// ---------------------------------------------------------------------------

export interface ValueSchema<V extends Json = Json> {
  /** Version of the value shape; bump + provide migrate on change. */
  readonly version: number
  validate(value: unknown): value is V
  migrate?(value: Json, fromVersion: number): V
}

export interface WidgetKind<V extends Json = Json> {
  /** Matches widgetType from the node schema. Namespaced for packs ('vhs.timeline'). */
  readonly type: string
  readonly valueSchema: ValueSchema<V>
  defaultValue(spec: WidgetSpec): V
  validate(value: V, spec: WidgetSpec): readonly Diagnostic[]
  /** Default view chosen from schema hints (multiline, display: slider, ...). */
  defaultView(spec: WidgetSpec): string
}

// ---------------------------------------------------------------------------
// WidgetView (presentation)
// ---------------------------------------------------------------------------

/** Renderer-neutral scene primitives; the real SceneBuilder lands with the renderer. */
export interface SceneBuilder {
  rect(x: number, y: number, w: number, h: number, style: Readonly<Record<string, unknown>>): void
  text(x: number, y: number, run: string, style: Readonly<Record<string, unknown>>): void
  hitRegion(x: number, y: number, w: number, h: number, action: string): void
}

export interface CompactState {
  readonly focused: boolean
  readonly connected: boolean
  readonly readonly: boolean
  /** Content is truncated: view MUST render the truncation affordance. */
  readonly truncated?: boolean
}

export interface EditorSizing {
  readonly preferred: { readonly width: number; readonly height: number }
  readonly min?: { readonly width: number; readonly height: number }
  readonly max?: { readonly width: number; readonly height: number }
  readonly resizable?: boolean
}

export interface WidgetView<V extends Json = Json> {
  readonly id: string
  /** Which WidgetKind this view presents. */
  readonly kind: string
  isCompatible(spec: WidgetSpec): boolean
  /** Height of the compact row(s), in row units. */
  measure(spec: WidgetSpec): { readonly rows: number }
  drawCompact(ctx: SceneBuilder, value: V, spec: WidgetSpec, state: CompactState): void
  /** Declarative expanded editing rendered by the host. */
  readonly editorUi?: HostUiProviderV1
  editorSizing?(spec: WidgetSpec): EditorSizing
}

// ---------------------------------------------------------------------------
// PreviewRenderer (execution preview channels)
// ---------------------------------------------------------------------------

export interface PreviewFrame {
  readonly channel: string
  readonly payload: Blob | ArrayBuffer | Readonly<Record<string, unknown>>
}

export interface PreviewRenderer {
  readonly id: string
  /** Optional host presentation for URL-backed previews. */
  readonly mediaKind?: 'image' | 'video' | 'audio' | 'model3d'
  /** Broad built-ins yield to matching non-fallback renderers. */
  readonly fallback?: boolean
  /** Channels this renderer accepts ('image/jpeg', 'vhs/video', ...). */
  canRender(channel: string): boolean
  /** Draw the compact in-node preview row. */
  drawCompact(ctx: SceneBuilder, frame: PreviewFrame, env: WidgetEnv): void
  /** Declarative expanded presentation rendered by the host. */
  readonly viewerUi?: HostUiProviderV1
}

// ---------------------------------------------------------------------------
// Registries (open to core and packs identically)
// ---------------------------------------------------------------------------

export interface WidgetRegistry {
  /** Register; returns an unregister function (gating/multi-window need clean removal). */
  registerKind(kind: WidgetKind): () => void
  registerView(view: WidgetView): () => void
  registerEditor(widgetType: string, editor: unknown): () => void
  registerPreviewRenderer(r: PreviewRenderer): () => void
  kind(type: string): WidgetKind | undefined
  viewsFor(kindType: string): readonly WidgetView[]
  editorFor(widgetType: string): unknown
  previewRendererFor(channel: string): PreviewRenderer | undefined
}
