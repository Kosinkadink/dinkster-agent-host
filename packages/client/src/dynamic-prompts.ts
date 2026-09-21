/** ComfyUI_frontend bdc0345d dynamic prompt grammar with injectable randomness. */
export function expandDynamicPrompt(input: string, random: () => number = Math.random): string {
  input = input.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '')
  let index = 0
  let result = ''

  const escape = (): string => `\\${input[index++]}`
  const choiceBlock = (): string => {
    const options: string[] = []
    let choice = ''
    let depth = 0
    while (index < input.length) {
      const character = input[index++]
      if (character === '\\') {
        choice += escape()
        continue
      }
      if (character === '{') depth++
      else if (character === '}') {
        if (depth === 0) break
        depth--
      } else if (character === '|' && depth === 0) {
        options.push(choice)
        choice = ''
        continue
      }
      choice += character
    }
    options.push(choice)
    const selected = options[Math.floor(random() * options.length)] ?? options[options.length - 1]!
    return expandDynamicPrompt(selected, random)
  }

  while (index < input.length) {
    const character = input[index++]
    if (character === '\\') result += escape()
    else if (character === '{') result += choiceBlock()
    else result += character
  }
  return result.replace(/\\([{}|])/g, '$1')
}
