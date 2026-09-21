import type { JsonObject, WorkflowDocument } from './document.js'

/** Export frontend virtual notes as ComfyUI LiteGraph note records. */
export function exportVirtualNodesToLitegraph(
  document: WorkflowDocument,
  graphId: string = document.root,
): readonly JsonObject[] {
  const graph = document.graphs[graphId]
  const view = document.view.graphs[graphId]
  if (graph === undefined) return []
  return Object.values(graph.nodes).flatMap((node, index): JsonObject[] => {
    if (
      node.virtual !== true ||
      (node.type !== 'dinkster.note' && node.type !== 'dinkster.markdown_note')
    )
      return []
    const state = view?.nodes[node.id]
    const position = state?.position ?? { x: 0, y: 0 }
    const size = state?.size ?? { width: 320, height: 180 }
    return [
      {
        id: index + 1,
        type: node.type === 'dinkster.markdown_note' ? 'MarkdownNote' : 'Note',
        pos: [position.x, position.y],
        size: [size.width, size.height],
        widgets_values: [
          typeof node.values['text'] === 'string' ? node.values['text'] : '',
        ],
        ...(node.title === undefined ? {} : { title: node.title }),
        ...(state?.color === undefined ? {} : { color: state.color }),
      } as JsonObject,
    ]
  }) as readonly JsonObject[]
}
