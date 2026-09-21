import { describe, expect, it } from 'vitest'
import { parseDinksterSchemaWire40 } from '../src/schema/dinkster-wire.js'
import { inputsOf } from '../src/schema/model.js'

describe('native VIDEO_EDIT editor derivation', () => {
  it.each([
    ['dinkster.video.trim', ['trim']],
    ['dinkster.video.crop', ['crop']],
    ['extension.video_edit', ['trim', 'crop']],
  ])('derives %s from the published typed optional input without a widget wire extension', (type, features) => {
    const parsed = parseDinksterSchemaWire40(type as string, {
      schemaVersion: 40, signature: 'backend-signature',
      interface: [{ role: 'input', id: 'video_edit', type: { kind: 'concrete', types: ['comfy.VIDEO_EDIT'] }, required: false }],
    })
    expect(parsed.diagnostics).toEqual([])
    expect(inputsOf(parsed.schema!)[0]).toMatchObject({
      id: 'video_edit', optional: true, widget: { widgetType: 'VIDEO_EDIT', options: { features } },
    })
  })
})
