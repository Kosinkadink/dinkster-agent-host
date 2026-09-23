import { describe, expect, it } from 'vitest'
import { parseDinksterSchema } from '../src/schema/dinkster-wire.js'
import { inputsOf } from '../src/schema/model.js'

describe('native VIDEO_EDIT editor derivation', () => {
  it.each([
    ['dinkster.video.trim', ['trim']],
    ['dinkster.video.crop', ['crop']],
    ['extension.video_edit', ['trim', 'crop']],
  ])('decodes the explicit VIDEO_EDIT descriptor for %s', (type, features) => {
    const parsed = parseDinksterSchema(type as string, {
      schemaVersion: 1, signature: 'backend-signature',
      interface: [{ role: 'input', id: 'video_edit', type: { kind: 'concrete', types: ['comfy.VIDEO_EDIT'] }, required: false, widget: { type: 'VIDEO_EDIT', features } }],
    })
    expect(parsed.diagnostics).toEqual([])
    expect(inputsOf(parsed.schema!)[0]).toMatchObject({
      id: 'video_edit', optional: true, widget: { widgetType: 'VIDEO_EDIT', options: { features } },
    })
  })

  it('does not infer a VIDEO_EDIT widget from node or input identity', () => {
    const parsed = parseDinksterSchema('dinkster.video.trim', {
      schemaVersion: 1, signature: 'backend-signature',
      interface: [{ role: 'input', id: 'video_edit', type: { kind: 'concrete', types: ['comfy.VIDEO_EDIT'] }, required: false }],
    })
    expect(parsed.diagnostics).toEqual([])
    expect(inputsOf(parsed.schema!)[0]?.widget).toBeUndefined()
  })
})
