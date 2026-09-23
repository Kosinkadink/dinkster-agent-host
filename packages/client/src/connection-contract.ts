import type {
  ComfyAliasCatalog,
  ComfyGroupCatalog,
  ConnectionId,
  Diagnostic,
  ExecutionRef,
  NodeSchema,
  PackInfo,
  SchemaResolver,
} from '@dinkster/core'

export interface SchemaRegistry {
  readonly connection: ConnectionId
  /** Content hash of the raw schema payload; compiles record it. */
  readonly hash: string
  readonly schemas: ReadonlyMap<string, NodeSchema>
  readonly diagnostics: readonly Diagnostic[]
  readonly resolve: SchemaResolver
  /** Maintained import-only ComfyUI class translations from installed packs. */
  readonly comfyAliases?: ComfyAliasCatalog
  /** Maintained exact ComfyUI node-group translations from installed packs. */
  readonly comfyGroups?: ComfyGroupCatalog
  /**
   * Pack presentation table (Dinkster native only; ComfyUI V1 has no pack
   * provenance). Keys are the pack ids NodeSchema.pack refers to.
   */
  readonly packs?: ReadonlyMap<string, PackInfo>
  /**
   * Server identity from the /api/nodes "dinkster" header (Dinkster native
   * only). Feeds environment stamps. `schemaWire` also tells UI
   * affordances whether the backend declares schema capabilities such as
   * `emitsPreviews` (wire 24+); it never gates decoding.
   */
  readonly server?: { readonly version: string; readonly schemaWire: number }
  /**
   * Graph document wire feature flags from /api/nodes "dinkster.graphFeatures"
   * (Dinkster native only; additive, absent on older backends). LOAD-BEARING,
   * unlike `server`: compile gates capability-negotiated lowering forms on
   * membership (e.g. 'typedLiteral' -> $typed markers). Absent = emit none.
   */
  readonly graphFeatures?: readonly string[]
  /**
   * Atom type ids with a registered batch-merge provider (list<T> -> one
   * batched T), from /api/nodes "dinkster.mergeableTypes" (Dinkster native only;
   * additive, absent on older backends). ADVISORY, unlike graphFeatures:
   * it gates the ASSET widget's multi-select merge arm (typed-assets pin
   * (5)); the backend coercion planner enforces regardless, so staleness
   * only under/over-offers multi-select until refetch.
   */
  readonly mergeableTypes?: readonly string[]
  /** Native extension generation atomically paired with this schema table. */
  readonly extensionSnapshotPair?: {
    readonly digest: string
    readonly snapshot: import('@dinkster/core').EffectiveExtensionSnapshot
  }
  /**
   * Schema surface generation from /api/nodes "epoch" (Dinkster native only;
   * monotonic per engine process). Gates schema_changed invalidation pings:
   * a held epoch >= the ping's epoch means the refetch can be skipped.
   */
  readonly epoch?: number
  /**
   * Present exactly while the backend was still announcing packs at fetch
   * time: this registry is real but not final (expect more epochs).
   */
  readonly composing?: true
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export type SubmitResult =
  | {
      readonly ok: true
      readonly execution: ExecutionRef
      /**
       * Server-assigned globally unique job identity (Dinkster 258382e).
       * Opaque; lexical order approximates submission order but must not be
       * relied on. Absent on V1 connections and on pre-jobRef Dinkster servers.
       * ExecutionRef stays the local handle; jobRef is the server identity.
       */
      readonly jobRef?: string
    }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] }
