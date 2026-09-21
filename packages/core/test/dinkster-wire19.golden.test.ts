import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  DINKSTER_ACCEPTED_WIRE_VERSIONS,
  DINKSTER_SCHEMA_WIRE_VERSION,
  parseDinksterNodes,
  type DinksterNodesPayload,
} from '../src/schema/dinkster-wire.js'
import { inputsOf } from '../src/schema/model.js'

const input = (id: string, type: string, widget: Record<string, unknown>) => ({
  role: 'input', id, required: true,
  type: { kind: 'concrete', types: [type] }, widget,
})

const catalog = (schemaVersion = 19): DinksterNodesPayload => ({
  schemaVersion,
  nodes: {
    'fixture.combo-contract': {
      schemaVersion,
      signature: 'sig-with-dynamic-prompts',
      interface: [
        input('choice', 'core.combo', { type: 'COMBO', options: ['alpha', 'beta'], controlAfterGenerate: 'randomize' }),
        input('prompt', 'core.string', { type: 'STRING', multiline: true, placeholder: '', dynamicPrompts: true }),
        input('scale', 'core.float', { type: 'NUMBER', round: 0.001 }),
        input('color', 'core.string', { type: 'COLOR' }),
      ],
    },
  },
})

const backendComboGolden = JSON.parse(readFileSync(
  new URL('../fixtures/replacements/combo.json', import.meta.url),
  'utf8',
)) as { schemas: Array<Record<string, any> & { nodeType: string }> }

describe('schema wire 19 widget adjuncts', () => {
  it.each(DINKSTER_ACCEPTED_WIRE_VERSIONS.filter((version) => version >= 19))(
    'preserves the real VHS path placeholder without multiline at wire %s', (schemaVersion) => {
      const result = parseDinksterNodes({ schemaVersion, nodes: {
        'comfy.VHS_LoadVideoPath': { schemaVersion, interface: [
          input('video', 'core.string', { type: 'STRING', placeholder: 'X://insert/path/here.mp4' }),
        ] },
      } })
      expect(result.diagnostics).toEqual([])
      expect([...result.schemas.keys()]).toEqual(['comfy.VHS_LoadVideoPath'])
      expect(inputsOf(result.schemas.get('comfy.VHS_LoadVideoPath')!)[0]).toMatchObject({
        id: 'video', type: { kind: 'concrete', name: 'core.string' },
        widget: { widgetType: 'STRING', options: { placeholder: 'X://insert/path/here.mp4' } },
      })
      expect(inputsOf(result.schemas.get('comfy.VHS_LoadVideoPath')!)[0]!.widget?.options)
        .not.toHaveProperty('multiline')
    },
  )

  it.each([19, 20, 38, 39, 40, 41])('retains STRING descriptor refusals at wire %s', (schemaVersion) => {
    for (const widget of [
      { type: 'STRING' },
      { type: 'STRING', multiline: 'false' },
      { type: 'STRING', dynamicPrompts: 'true' },
      { type: 'STRING', placeholder: 'path', unknown: true },
    ]) {
      const result = parseDinksterNodes({ schemaVersion, nodes: { Invalid: {
        schemaVersion, interface: [input('text', 'core.string', widget)],
      } } })
      expect(result.schemas.size).toBe(0)
      expect(result.diagnostics).toEqual([expect.objectContaining({ severity: 'error', code: 'schema.parse.threw' })])
    }
  })

  it('continues accepting 19 and decodes the backend combo golden facts exactly', () => {
    expect(DINKSTER_SCHEMA_WIRE_VERSION).toBe(44)
    expect(DINKSTER_ACCEPTED_WIRE_VERSIONS).toContain(19)
    const result = parseDinksterNodes(catalog())
    expect(result.diagnostics).toEqual([])
    expect(inputsOf(result.schemas.get('fixture.combo-contract')!).map((entry) => entry.widget)).toEqual([
      { widgetType: 'COMBO', options: { options: ['alpha', 'beta'] }, controller: 'after_generate', controllerInitial: 'randomize' },
      { widgetType: 'STRING', options: { multiline: true, placeholder: '', dynamicPrompts: true } },
      { widgetType: 'FLOAT', options: { round: 0.001 } },
      { widgetType: 'COLOR', options: {} },
    ])
  })

  it('decodes the exact e905bd1 combo golden and its recursive v18 downgrade', () => {
    const wire19 = structuredClone(backendComboGolden.schemas[0]!)
    wire19.schemaVersion = 19
    wire19.interface = (wire19.interface as any[]).filter((entry) => entry.id !== 'providers')
    const remote = (wire19.interface as any[])[0].widget.remote
    delete remote.controlAfterRefresh
    delete remote.timeoutMs
    delete remote.maxRetries
    delete remote.refreshMs
    const decoded19 = parseDinksterNodes({ schemaVersion: 19, nodes: { [wire19.nodeType]: wire19 } })
    expect(decoded19.diagnostics).toEqual([])
    expect(decoded19.schemas.size).toBe(1)

    const wire18 = structuredClone(wire19)
    wire18.schemaVersion = 18
    const entries = wire18.interface as any[]
    delete entries[0].widget.controlAfterGenerate
    for (const representation of entries[1].widget.representations) {
      delete representation.widget.placeholder
      delete representation.widget.dynamicPrompts
    }
    delete entries[2].widget
    delete entries[3].widget
    const decoded18 = parseDinksterNodes({ schemaVersion: 18, nodes: { [wire18.nodeType]: wire18 } })
    expect(decoded18.diagnostics).toEqual([])
    const widgets = inputsOf(decoded18.schemas.get('fixture.combo-contract')!).map((entry) => entry.widget)
    expect(widgets[0]).toMatchObject({ widgetType: 'COMBO', options: { options: ['alpha', 'beta'] } })
    expect(widgets[0]).not.toHaveProperty('controller')
    expect(widgets[1]).toMatchObject({ widgetType: 'STRING', options: { multiline: true } })
    expect(widgets[2]).toMatchObject({ widgetType: 'FLOAT', options: {} })
    expect(widgets[2]?.options).not.toHaveProperty('round')
    expect(widgets[3]).toMatchObject({ widgetType: 'STRING', options: {} })
    expect(widgets[3]?.widgetType).not.toBe('COLOR')
  })

  it.each([false, true])('preserves explicit dynamicPrompts=%s', (dynamicPrompts) => {
    const payload = catalog()
    const entry = ((payload.nodes as Record<string, any>)['fixture.combo-contract'].interface as any[])[1]
    entry.widget = { type: 'STRING', dynamicPrompts }
    expect(inputsOf(parseDinksterNodes(payload).schemas.get('fixture.combo-contract')!)[1]!.widget?.options)
      .toEqual({ dynamicPrompts })
  })

  it('rejects malformed schema-significant dynamicPrompts loudly', () => {
    const payload = catalog()
    const entry = ((payload.nodes as Record<string, any>)['fixture.combo-contract'].interface as any[])[1]
    entry.widget.dynamicPrompts = 'true'
    const result = parseDinksterNodes(payload)
    expect(result.schemas.size).toBe(0)
    expect(result.diagnostics).toEqual([expect.objectContaining({ severity: 'error', code: 'schema.parse.threw' })])
  })

  it.each([
    ['round', -1, 'schema.dinkster.badNumberRound'],
    ['controlAfterGenerate', 'shuffle', 'schema.dinkster.badComboControlAfterGenerate'],
  ])('drops malformed presentation field %s alone', (field, value, code) => {
    const payload = catalog()
    const entries = (payload.nodes as Record<string, any>)['fixture.combo-contract'].interface as any[]
    const entry = field === 'round' ? entries[2] : entries[0]
    entry.widget[field] = value
    const result = parseDinksterNodes(payload)
    expect(result.schemas.size).toBe(1)
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ severity: 'warning', code }))
  })

  it.each([
    ['round', 2],
    ['placeholder', 1],
    ['dynamicPrompts', 1],
    ['controlAfterGenerate', 0],
    ['COLOR', 3],
  ])('keeps wire 18 frozen and rejects v19 fact %s', (fact, entryIndex) => {
    const source = catalog()
    const sourceEntries = (source.nodes as Record<string, any>)['fixture.combo-contract'].interface as any[]
    const payload = catalog(18)
    const entries = (payload.nodes as Record<string, any>)['fixture.combo-contract'].interface as any[]
    for (const entry of entries) delete entry.widget
    entries[entryIndex].widget = structuredClone(sourceEntries[entryIndex].widget)
    if (fact !== 'COLOR') {
      const widget = entries[entryIndex].widget
      for (const key of Object.keys(widget)) if (key !== 'type' && key !== fact) delete widget[key]
      if (widget.type === 'COMBO') widget.options = ['alpha']
      if (widget.type === 'STRING' && fact !== 'dynamicPrompts' && fact !== 'placeholder') widget.multiline = false
    }
    const result = parseDinksterNodes(payload)
    expect(result.schemas.size).toBe(0)
    expect(result.diagnostics).toEqual([expect.objectContaining({ severity: 'error', code: 'schema.parse.threw' })])
  })

  it('passes through the backend signature when dynamicPrompts is absent', () => {
    const payload = catalog()
    const node = (payload.nodes as Record<string, any>)['fixture.combo-contract']
    node.signature = 'same-as-wire16'
    delete node.interface[1].widget.dynamicPrompts
    expect(parseDinksterNodes(payload).schemas.get('fixture.combo-contract')?.signature).toBe('same-as-wire16')
  })
})
