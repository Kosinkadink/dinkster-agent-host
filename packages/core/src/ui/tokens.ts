export interface TypeToken {
  readonly fontSize: number
  readonly lineHeight: number
  readonly fontWeight: 400 | 500 | 600
}

export interface MeaningToken {
  readonly foreground: string
  readonly background: string
  readonly border: string
}

const deepFreeze = <T>(value: T): T => {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
  Object.freeze(value)
  return value
}

export interface SemanticDesignTokens {
  readonly space: {
    readonly 4: number
    readonly 8: number
    readonly 12: number
    readonly 16: number
    readonly 24: number
    readonly 32: number
  }
  readonly type: {
    readonly fontFamily: string
    readonly metadata: TypeToken
    readonly body: TypeToken
    readonly section: TypeToken
    readonly title: TypeToken
    readonly weight: {
      readonly regular: 400
      readonly medium: 500
      readonly semibold: 600
    }
  }
  readonly surface: {
    readonly canvas: string
    readonly panel: string
    readonly inset: string
    readonly raised: string
    readonly selected: string
  }
  readonly text: {
    readonly primary: string
    readonly secondary: string
    readonly muted: string
    readonly disabled: string
    readonly inverse: string
    readonly onSelected: string
  }
  readonly border: {
    readonly subtle: string
    readonly strong: string
    readonly focus: string
    readonly selected: string
  }
  readonly meaning: {
    readonly accent: MeaningToken
    readonly success: MeaningToken
    readonly warning: MeaningToken
    readonly danger: MeaningToken
    readonly info: MeaningToken
  }
  readonly shape: {
    readonly small: number
    readonly control: number
    readonly card: number
    readonly capsule: number
  }
  readonly interaction: {
    readonly compactControlHeight: number
    readonly primaryInputHeight: number
    readonly focusRingWidth: number
    readonly hoverOverlay: string
    readonly pressedOverlay: string
    readonly selectedOverlay: string
    readonly disabledOpacity: number
  }
  readonly motion: {
    readonly fast: number
    readonly standard: number
    readonly reduced: number
    readonly easing: string
  }
  readonly elevation: {
    readonly low: string
    readonly high: string
  }
}

export const semanticDesignTokens = deepFreeze({
  space: {
    4: 4,
    8: 8,
    12: 12,
    16: 16,
    24: 24,
    32: 32,
  },
  type: {
    fontFamily: 'system-ui, sans-serif',
    metadata: { fontSize: 11, lineHeight: 16, fontWeight: 400 },
    body: { fontSize: 13, lineHeight: 20, fontWeight: 400 },
    section: { fontSize: 15, lineHeight: 20, fontWeight: 500 },
    title: { fontSize: 18, lineHeight: 24, fontWeight: 600 },
    weight: { regular: 400, medium: 500, semibold: 600 },
  },
  surface: {
    canvas: '#181818',
    panel: '#202020',
    inset: '#1c1c1c',
    raised: '#262626',
    selected: '#315a84',
  },
  text: {
    primary: '#e0e0e0',
    secondary: '#b8b8b8',
    muted: '#8d9aa5',
    disabled: '#777777',
    inverse: '#181818',
    onSelected: '#ffffff',
  },
  border: {
    subtle: '#303030',
    strong: '#555555',
    focus: '#78aee5',
    selected: '#ffffff',
  },
  meaning: {
    accent: { foreground: '#d6ebff', background: '#234d75', border: '#78aee5' },
    success: { foreground: '#d7f5dc', background: '#1f4428', border: '#66bb6a' },
    warning: { foreground: '#ffe3b0', background: '#513612', border: '#e0b45a' },
    danger: { foreground: '#ffd7d5', background: '#51211f', border: '#ef5350' },
    info: { foreground: '#d6efff', background: '#173e52', border: '#4fc3f7' },
  },
  shape: {
    small: 4,
    control: 6,
    card: 8,
    capsule: 999,
  },
  interaction: {
    compactControlHeight: 32,
    primaryInputHeight: 40,
    focusRingWidth: 2,
    hoverOverlay: 'rgba(255, 255, 255, 0.06)',
    pressedOverlay: 'rgba(255, 255, 255, 0.1)',
    selectedOverlay: 'rgba(120, 174, 229, 0.18)',
    disabledOpacity: 0.45,
  },
  motion: {
    fast: 120,
    standard: 180,
    reduced: 0,
    easing: 'cubic-bezier(0.2, 0, 0, 1)',
  },
  elevation: {
    low: '0 4px 12px rgba(0, 0, 0, 0.28)',
    high: '0 12px 32px rgba(0, 0, 0, 0.42)',
  },
} as const satisfies SemanticDesignTokens)

export interface CanvasSemanticTokenProjection {
  readonly space: SemanticDesignTokens['space']
  readonly type: Pick<SemanticDesignTokens['type'], 'fontFamily' | 'metadata' | 'body' | 'weight'>
  readonly surface: SemanticDesignTokens['surface']
  readonly text: SemanticDesignTokens['text']
  readonly border: SemanticDesignTokens['border']
  readonly meaning: SemanticDesignTokens['meaning']
  readonly shape: SemanticDesignTokens['shape']
  readonly interaction: Pick<SemanticDesignTokens['interaction'], 'focusRingWidth' | 'selectedOverlay' | 'disabledOpacity'>
}

export const canvasSemanticTokens: CanvasSemanticTokenProjection = deepFreeze({
  space: semanticDesignTokens.space,
  type: {
    fontFamily: semanticDesignTokens.type.fontFamily,
    metadata: semanticDesignTokens.type.metadata,
    body: semanticDesignTokens.type.body,
    weight: semanticDesignTokens.type.weight,
  },
  surface: semanticDesignTokens.surface,
  text: semanticDesignTokens.text,
  border: semanticDesignTokens.border,
  meaning: semanticDesignTokens.meaning,
  shape: semanticDesignTokens.shape,
  interaction: {
    focusRingWidth: semanticDesignTokens.interaction.focusRingWidth,
    selectedOverlay: semanticDesignTokens.interaction.selectedOverlay,
    disabledOpacity: semanticDesignTokens.interaction.disabledOpacity,
  },
})

const px = (value: number): string => `${value}px`
const ms = (value: number): string => `${value}ms`

export type SemanticCssVariableName = `--dinkster-${string}`

export const semanticCssVariables = deepFreeze({
  '--dinkster-space-4': px(semanticDesignTokens.space[4]),
  '--dinkster-space-8': px(semanticDesignTokens.space[8]),
  '--dinkster-space-12': px(semanticDesignTokens.space[12]),
  '--dinkster-space-16': px(semanticDesignTokens.space[16]),
  '--dinkster-space-24': px(semanticDesignTokens.space[24]),
  '--dinkster-space-32': px(semanticDesignTokens.space[32]),
  '--dinkster-font-family': semanticDesignTokens.type.fontFamily,
  '--dinkster-type-metadata-size': px(semanticDesignTokens.type.metadata.fontSize),
  '--dinkster-type-metadata-line': px(semanticDesignTokens.type.metadata.lineHeight),
  '--dinkster-type-metadata-weight': String(semanticDesignTokens.type.metadata.fontWeight),
  '--dinkster-type-body-size': px(semanticDesignTokens.type.body.fontSize),
  '--dinkster-type-body-line': px(semanticDesignTokens.type.body.lineHeight),
  '--dinkster-type-body-weight': String(semanticDesignTokens.type.body.fontWeight),
  '--dinkster-type-section-size': px(semanticDesignTokens.type.section.fontSize),
  '--dinkster-type-section-line': px(semanticDesignTokens.type.section.lineHeight),
  '--dinkster-type-section-weight': String(semanticDesignTokens.type.section.fontWeight),
  '--dinkster-type-title-size': px(semanticDesignTokens.type.title.fontSize),
  '--dinkster-type-title-line': px(semanticDesignTokens.type.title.lineHeight),
  '--dinkster-type-title-weight': String(semanticDesignTokens.type.title.fontWeight),
  '--dinkster-weight-regular': String(semanticDesignTokens.type.weight.regular),
  '--dinkster-weight-medium': String(semanticDesignTokens.type.weight.medium),
  '--dinkster-weight-semibold': String(semanticDesignTokens.type.weight.semibold),
  '--dinkster-surface-canvas': semanticDesignTokens.surface.canvas,
  '--dinkster-surface-panel': semanticDesignTokens.surface.panel,
  '--dinkster-surface-inset': semanticDesignTokens.surface.inset,
  '--dinkster-surface-raised': semanticDesignTokens.surface.raised,
  '--dinkster-surface-selected': semanticDesignTokens.surface.selected,
  '--dinkster-text-primary': semanticDesignTokens.text.primary,
  '--dinkster-text-secondary': semanticDesignTokens.text.secondary,
  '--dinkster-text-muted': semanticDesignTokens.text.muted,
  '--dinkster-text-disabled': semanticDesignTokens.text.disabled,
  '--dinkster-text-inverse': semanticDesignTokens.text.inverse,
  '--dinkster-text-on-selected': semanticDesignTokens.text.onSelected,
  '--dinkster-border-subtle': semanticDesignTokens.border.subtle,
  '--dinkster-border-strong': semanticDesignTokens.border.strong,
  '--dinkster-border-focus': semanticDesignTokens.border.focus,
  '--dinkster-border-selected': semanticDesignTokens.border.selected,
  '--dinkster-accent-foreground': semanticDesignTokens.meaning.accent.foreground,
  '--dinkster-accent-background': semanticDesignTokens.meaning.accent.background,
  '--dinkster-accent-border': semanticDesignTokens.meaning.accent.border,
  '--dinkster-success-foreground': semanticDesignTokens.meaning.success.foreground,
  '--dinkster-success-background': semanticDesignTokens.meaning.success.background,
  '--dinkster-success-border': semanticDesignTokens.meaning.success.border,
  '--dinkster-warning-foreground': semanticDesignTokens.meaning.warning.foreground,
  '--dinkster-warning-background': semanticDesignTokens.meaning.warning.background,
  '--dinkster-warning-border': semanticDesignTokens.meaning.warning.border,
  '--dinkster-danger-foreground': semanticDesignTokens.meaning.danger.foreground,
  '--dinkster-danger-background': semanticDesignTokens.meaning.danger.background,
  '--dinkster-danger-border': semanticDesignTokens.meaning.danger.border,
  '--dinkster-info-foreground': semanticDesignTokens.meaning.info.foreground,
  '--dinkster-info-background': semanticDesignTokens.meaning.info.background,
  '--dinkster-info-border': semanticDesignTokens.meaning.info.border,
  '--dinkster-radius-small': px(semanticDesignTokens.shape.small),
  '--dinkster-radius-control': px(semanticDesignTokens.shape.control),
  '--dinkster-radius-card': px(semanticDesignTokens.shape.card),
  '--dinkster-radius-capsule': px(semanticDesignTokens.shape.capsule),
  '--dinkster-control-compact-height': px(semanticDesignTokens.interaction.compactControlHeight),
  '--dinkster-input-primary-height': px(semanticDesignTokens.interaction.primaryInputHeight),
  '--dinkster-focus-ring-width': px(semanticDesignTokens.interaction.focusRingWidth),
  '--dinkster-interaction-hover': semanticDesignTokens.interaction.hoverOverlay,
  '--dinkster-interaction-pressed': semanticDesignTokens.interaction.pressedOverlay,
  '--dinkster-interaction-selected': semanticDesignTokens.interaction.selectedOverlay,
  '--dinkster-interaction-disabled-opacity': String(semanticDesignTokens.interaction.disabledOpacity),
  '--dinkster-motion-fast': ms(semanticDesignTokens.motion.fast),
  '--dinkster-motion-standard': ms(semanticDesignTokens.motion.standard),
  '--dinkster-motion-reduced': ms(semanticDesignTokens.motion.reduced),
  '--dinkster-motion-easing': semanticDesignTokens.motion.easing,
  '--dinkster-elevation-low': semanticDesignTokens.elevation.low,
  '--dinkster-elevation-high': semanticDesignTokens.elevation.high,
} as const satisfies Readonly<Record<SemanticCssVariableName, string>>)

export const semanticCssRoot = `:root {\n${Object.entries(semanticCssVariables)
  .map(([name, value]) => `  ${name}: ${value};`)
  .join('\n')}\n}`
