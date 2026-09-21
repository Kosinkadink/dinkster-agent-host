export interface TextSplice {
  readonly offset: number
  readonly deleteCount: number
  readonly insert: string
}

export function spliceDiff(before: string, after: string): TextSplice | undefined {
  if (before === after) return undefined

  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1
  }

  let suffix = 0
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1
  }

  return {
    offset: prefix,
    deleteCount: before.length - prefix - suffix,
    insert: after.slice(prefix, after.length - suffix),
  }
}

export function transformSplice(own: TextSplice, foreign: TextSplice): TextSplice {
  const ownOffset = Math.max(0, own.offset)
  const ownDeleteCount = Math.max(0, own.deleteCount)
  const foreignOffset = Math.max(0, foreign.offset)
  const foreignDeleteCount = Math.max(0, foreign.deleteCount)
  const ownEnd = ownOffset + ownDeleteCount
  const foreignEnd = foreignOffset + foreignDeleteCount

  if (foreignEnd <= ownOffset) {
    return {
      ...own,
      offset: Math.max(0, ownOffset + foreign.insert.length - foreignDeleteCount),
      deleteCount: ownDeleteCount,
    }
  }
  if (foreignOffset >= ownEnd) return { ...own, offset: ownOffset, deleteCount: ownDeleteCount }

  const overlap = Math.max(0, Math.min(ownEnd, foreignEnd) - Math.max(ownOffset, foreignOffset))
  const startsInsideForeignDelete = ownOffset >= foreignOffset && ownOffset < foreignEnd
  const offset = startsInsideForeignDelete ? foreignOffset + foreign.insert.length : ownOffset
  // Deleting a range deletes what lands inside it.
  const insertedInsideOwnDelete = foreignOffset > ownOffset && foreignOffset < ownEnd
  const deleteCount = ownDeleteCount - overlap + (insertedInsideOwnDelete ? foreign.insert.length : 0)

  return { ...own, offset: Math.max(0, offset), deleteCount: Math.max(0, deleteCount) }
}
