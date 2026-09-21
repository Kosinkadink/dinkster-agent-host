import type { Json, NodeData } from './format/document.js'
import type { NodeSchema } from './schema/model.js'

export interface VirtualNodeRenderModel {
  readonly text: string
  readonly format: 'plain' | 'markdown'
}

/** A frontend-owned, serializable node kind with no execution ports. */
export interface VirtualNodeKind {
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly schema: NodeSchema
  readonly defaultValues: Readonly<Record<string, Json>>
  readonly render: (node: NodeData) => VirtualNodeRenderModel
}

const noteSchema = (
  type: string,
  displayName: string,
  description: string,
): NodeSchema => ({
  type,
  virtual: true,
  displayName,
  category: 'Notes',
  description,
  source: 'v3',
  isOutputNode: false,
  items: [
    {
      kind: 'input',
      id: 'text',
      type: { kind: 'concrete', name: 'core.string' },
      optional: true,
      widget: {
        widgetType: 'STRING',
        options: { multiline: true },
        default: '',
      },
    },
  ],
})

export const CORE_VIRTUAL_NODE_KINDS: readonly VirtualNodeKind[] = [
  {
    id: 'dinkster.note',
    title: 'Note',
    description: 'A colored plain-text note saved with the workflow.',
    schema: noteSchema(
      'dinkster.note',
      'Note',
      'A colored plain-text note saved with the workflow.',
    ),
    defaultValues: { text: '' },
    render: (node) => ({
      text: typeof node.values['text'] === 'string' ? node.values['text'] : '',
      format: 'plain',
    }),
  },
  {
    id: 'dinkster.markdown_note',
    title: 'Markdown Note',
    description:
      'A Markdown note that renders on the canvas and edits as text.',
    schema: noteSchema(
      'dinkster.markdown_note',
      'Markdown Note',
      'A Markdown note that renders on the canvas and edits as text.',
    ),
    defaultValues: { text: '' },
    render: (node) => ({
      text: typeof node.values['text'] === 'string' ? node.values['text'] : '',
      format: 'markdown',
    }),
  },
]

export const coreVirtualNodeKind = (id: string): VirtualNodeKind | undefined =>
  CORE_VIRTUAL_NODE_KINDS.find((kind) => kind.id === id)
