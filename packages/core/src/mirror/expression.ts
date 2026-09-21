/**
 * Frontend mirror of the backend math expression grammar v1
 * (dinkster_nodes_foundation.expression). Evaluates the same Python-expression
 * subset with Python numeric semantics so scalar estimates can render before
 * backend results arrive: arbitrary-precision integers (bigint), IEEE-754
 * doubles (number), bools that participate in arithmetic as 0/1, floor
 * division and modulo following the divisor's sign, banker's rounding,
 * chained comparisons, and `and`/`or` returning operands.
 *
 * Every divergence from the backend collapses to a thrown
 * ExpressionMirrorError; callers can show its canonical preview message.
 * Bounded precision (relative tolerance declared by the schema mirror) covers
 * transcendental functions, whose libm and JS-engine implementations differ
 * by ulps. The vendored parity corpus in
 * test/fixtures/math_expression_v1.json bit-compares the exact cases.
 */

export const EXPRESSION_GRAMMAR_VERSION = 1
export const MAX_EXPRESSION_LENGTH = 4096
export const MAX_EXPRESSION_NODES = 256
export const MAX_VECTOR_LENGTH = 4096
export const MAX_EXPONENT = 4000
export const MAX_SHIFT = 1000
export const MAX_INTEGER_BITS = 16384
/** CPython's tokenizer rejects more than 200 nested parentheses/brackets. */
export const MAX_BRACKET_DEPTH = 200

/** Python int -> bigint, float -> number, bool -> boolean. */
export type ExpressionScalar = bigint | number | boolean
export type ExpressionValue = ExpressionScalar | readonly ExpressionScalar[]

export interface ExpressionScalarResult {
  readonly kind: 'scalar'
  readonly float: number
  readonly int: bigint
  readonly boolean: boolean
}

export interface ExpressionVectorResult {
  readonly kind: 'vector'
  readonly floats: readonly number[]
  readonly ints: readonly bigint[]
  readonly booleans: readonly boolean[]
}

export type ExpressionResult = ExpressionScalarResult | ExpressionVectorResult

export class ExpressionMirrorError extends Error {}

export type ExpressionTextValidation =
  | { readonly kind: 'valid' }
  | { readonly kind: 'unresolved'; readonly message: string }
  | { readonly kind: 'invalid'; readonly message: string }

function fail(message: string): never {
  throw new ExpressionMirrorError(message)
}

const expressionMirrorStructuralMessage = (message: string): boolean =>
  message.startsWith('invalid expression') ||
  message.startsWith('expression syntax') ||
  message.startsWith('expression cannot') ||
  message.startsWith('expression exceeds') ||
  message.startsWith('expression values must') ||
  message.startsWith('only direct function') ||
  message.startsWith('function ')

/** Human-readable evaluator failure for preview and structural classification. */
export function expressionMirrorErrorMessage(error: ExpressionMirrorError): string {
  if (error.message.startsWith('unknown expression name') || error.message.startsWith('unknown expression function')) {
    return `Unknown ${error.message.slice('unknown expression '.length)}`
  }
  if (error.message.startsWith('invalid expression: ')) {
    return `Invalid expression: ${error.message.slice('invalid expression: '.length)}`
  }
  if (expressionMirrorStructuralMessage(error.message)) {
    return `Invalid expression: ${error.message}`
  }
  return error.message.length === 0
    ? 'Unable to evaluate expression'
    : `${error.message[0]!.toUpperCase()}${error.message.slice(1)}`
}

/** Validate expression text with the canonical parser and evaluator grammar. */
export function validateExpressionText(
  expression: string,
  inputNames: readonly string[],
): ExpressionTextValidation {
  const values = new Map<string, ExpressionValue>(inputNames.map((name) => [name, 1n]))
  try {
    evaluateExpression(expression, values)
    return { kind: 'valid' }
  } catch (error) {
    if (!(error instanceof ExpressionMirrorError)) throw error
    if (error.message.startsWith('unknown expression name') || error.message.startsWith('unknown expression function')) {
      return { kind: 'unresolved', message: expressionMirrorErrorMessage(error) }
    }
    const structural = expressionMirrorStructuralMessage(error.message)
    return structural
      ? { kind: 'invalid', message: expressionMirrorErrorMessage(error) }
      : { kind: 'valid' }
  }
}

// ---------------------------------------------------------------------------
// Scalar discipline

type EvalValue = ExpressionScalar | readonly ExpressionScalar[]

function bitLength(value: bigint): number {
  const magnitude = value < 0n ? -value : value
  return magnitude === 0n ? 0 : magnitude.toString(2).length
}

function requireScalar(value: EvalValue | null): ExpressionScalar {
  if (typeof value === 'bigint') {
    if (bitLength(value) > MAX_INTEGER_BITS) {
      fail(`integer magnitude exceeds the limit of ${MAX_INTEGER_BITS} bits`)
    }
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`expression value is non-finite: ${value}`)
    return value
  }
  if (typeof value === 'boolean') return value
  fail('expression values must be int, float, or bool')
}

/** Python float(int) raises OverflowError past ~1.8e308; mirror that. */
function toFloat(value: ExpressionScalar): number {
  if (typeof value === 'number') return value
  const converted = typeof value === 'boolean' ? (value ? 1 : 0) : Number(value)
  if (!Number.isFinite(converted)) fail('integer is too large to represent as a float')
  return converted
}

function isIntLike(value: ExpressionScalar): value is bigint | boolean {
  return typeof value !== 'number'
}

function toBigInt(value: bigint | boolean): bigint {
  return typeof value === 'boolean' ? (value ? 1n : 0n) : value
}

function truthy(value: EvalValue): boolean {
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'bigint') return value !== 0n
  if (typeof value === 'number') return value !== 0
  return value === true
}

function copySignZero(reference: number): number {
  return reference < 0 || Object.is(reference, -0) ? -0 : 0
}

// ---------------------------------------------------------------------------
// Arithmetic with Python semantics

function pyAdd(left: ExpressionScalar, right: ExpressionScalar): ExpressionScalar {
  if (isIntLike(left) && isIntLike(right)) return requireScalar(toBigInt(left) + toBigInt(right))
  return requireScalar(toFloat(left) + toFloat(right))
}

function pySubtract(left: ExpressionScalar, right: ExpressionScalar): ExpressionScalar {
  if (isIntLike(left) && isIntLike(right)) return requireScalar(toBigInt(left) - toBigInt(right))
  return requireScalar(toFloat(left) - toFloat(right))
}

function pyMultiply(left: ExpressionScalar, right: ExpressionScalar): ExpressionScalar {
  if (isIntLike(left) && isIntLike(right)) return requireScalar(toBigInt(left) * toBigInt(right))
  return requireScalar(toFloat(left) * toFloat(right))
}

/** Exact power-of-two scaling. mantissa * 2^exponent must be representable
 * (possibly subnormal) or overflow to Infinity; deep-subnormal scales are
 * split so each multiply is exact. */
function ldexp(mantissa: number, exponent: number): number {
  if (exponent >= -1000) return mantissa * 2 ** exponent
  return mantissa * 2 ** -1000 * 2 ** (exponent + 1000)
}

/**
 * CPython long_true_divide: int / int correctly rounded to a double,
 * including subnormal results, so arbitrarily large operands that mostly
 * cancel (10**400 / 10**400) divide exactly like the backend instead of
 * overflowing during separate float conversions.
 */
function intTrueDivide(numerator: bigint, denominator: bigint): number {
  const negative = numerator < 0n !== denominator < 0n
  const a = numerator < 0n ? -numerator : numerator
  const b = denominator < 0n ? -denominator : denominator
  if (a === 0n) return negative ? -0 : 0
  const diff = bitLength(a) - bitLength(b)
  if (diff > 1024) fail('integer division result too large for a float')
  if (diff < -1075) return negative ? -0 : 0
  // Scale so the truncated quotient keeps 2 or 3 bits beyond the 53 (fewer
  // when subnormal) that survive, then round half-even with the remainder
  // folded in as a sticky bit strictly below the rounding bit.
  const shift = Math.max(diff, -1021) - 55
  let x: bigint
  let inexact: boolean
  if (shift <= 0) {
    const scaled = a << BigInt(-shift)
    x = scaled / b
    inexact = scaled % b !== 0n
  } else {
    const scaled = b << BigInt(shift)
    x = a / scaled
    inexact = a % scaled !== 0n
  }
  const extraBits = Math.max(bitLength(x), -1021 - shift) - 53
  const mask = 1n << BigInt(extraBits - 1)
  if (inexact) x |= 1n
  if ((x & mask) !== 0n && (x & (3n * mask - 1n)) !== 0n) x += mask
  x &= ~(2n * mask - 1n)
  const result = ldexp(Number(x), shift)
  if (!Number.isFinite(result)) fail('integer division result too large for a float')
  return negative ? -result : result
}

function pyDivide(left: ExpressionScalar, right: ExpressionScalar): number {
  if (isIntLike(left) && isIntLike(right)) {
    const denominator = toBigInt(right)
    if (denominator === 0n) fail('division by zero')
    return intTrueDivide(toBigInt(left), denominator)
  }
  const divisor = toFloat(right)
  if (divisor === 0) fail('division by zero')
  return requireScalar(toFloat(left) / divisor) as number
}

/** CPython float_divmod: fmod-derived remainder, then floor with a tie nudge. */
function floatFloorDiv(a: number, b: number): number {
  if (b === 0) fail('float floor division by zero')
  let mod = a % b
  let div = (a - mod) / b
  if (mod !== 0) {
    if (b < 0 !== mod < 0) {
      mod += b
      div -= 1
    }
  }
  if (div !== 0) {
    let floordiv = Math.floor(div)
    if (div - floordiv > 0.5) floordiv += 1
    return floordiv
  }
  return copySignZero(a / b)
}

function floatMod(a: number, b: number): number {
  if (b === 0) fail('float modulo by zero')
  let mod = a % b
  if (mod !== 0) {
    if (b < 0 !== mod < 0) mod += b
  } else {
    mod = copySignZero(b)
  }
  return mod
}

function pyFloorDivide(left: ExpressionScalar, right: ExpressionScalar): ExpressionScalar {
  if (isIntLike(left) && isIntLike(right)) {
    const a = toBigInt(left)
    const b = toBigInt(right)
    if (b === 0n) fail('integer floor division by zero')
    let quotient = a / b
    if (a % b !== 0n && a < 0n !== b < 0n) quotient -= 1n
    return requireScalar(quotient)
  }
  return requireScalar(floatFloorDiv(toFloat(left), toFloat(right)))
}

function pyModulo(left: ExpressionScalar, right: ExpressionScalar): ExpressionScalar {
  if (isIntLike(left) && isIntLike(right)) {
    const a = toBigInt(left)
    const b = toBigInt(right)
    if (b === 0n) fail('integer modulo by zero')
    let remainder = a % b
    if (remainder !== 0n && remainder < 0n !== b < 0n) remainder += b
    return requireScalar(remainder)
  }
  return requireScalar(floatMod(toFloat(left), toFloat(right)))
}

function pyPow(base: ExpressionScalar, exponent: ExpressionScalar): ExpressionScalar {
  const magnitude =
    typeof exponent === 'bigint'
      ? exponent < 0n
        ? -exponent
        : exponent
      : Math.abs(toFloat(exponent))
  if (typeof magnitude === 'bigint' ? magnitude > BigInt(MAX_EXPONENT) : magnitude > MAX_EXPONENT) {
    fail(`exponent ${exponent} exceeds the limit of ${MAX_EXPONENT}`)
  }
  if (
    typeof base === 'bigint' &&
    typeof exponent === 'bigint' &&
    exponent > 0n &&
    (base > 1n || base < -1n) &&
    bitLength(base) * Number(exponent) > MAX_INTEGER_BITS
  ) {
    fail(`integer magnitude exceeds the limit of ${MAX_INTEGER_BITS} bits`)
  }
  if (isIntLike(base) && isIntLike(exponent)) {
    const e = toBigInt(exponent)
    if (e >= 0n) return requireScalar(toBigInt(base) ** e)
  }
  return requireScalar(Math.pow(toFloat(base), toFloat(exponent)))
}

/** Shifts, bitwise operators, and ~ reject bools: type(x) is int, exactly. */
function strictInt(value: ExpressionScalar, message: string): bigint {
  if (typeof value !== 'bigint') fail(message)
  return value
}

function pyShift(
  left: ExpressionScalar,
  right: ExpressionScalar,
  direction: 'left' | 'right',
): bigint {
  const a = strictInt(left, 'bit shifts require integer operands')
  const b = strictInt(right, 'bit shifts require integer operands')
  if (b < 0n || b > BigInt(MAX_SHIFT)) {
    fail(`shift amount must be between 0 and ${MAX_SHIFT}`)
  }
  return direction === 'left' ? a << b : a >> b
}

function pyBitwise(
  left: ExpressionScalar,
  right: ExpressionScalar,
  operation: (a: bigint, b: bigint) => bigint,
): bigint {
  return operation(
    strictInt(left, 'bitwise operators require integer operands'),
    strictInt(right, 'bitwise operators require integer operands'),
  )
}

/**
 * Python-exact mixed comparison: an int compares to a float by value, never
 * by converting the int through a lossy double.
 */
function compareScalars(rawLeft: ExpressionScalar, rawRight: ExpressionScalar): -1 | 0 | 1 {
  const left = typeof rawLeft === 'boolean' ? toBigInt(rawLeft) : rawLeft
  const right = typeof rawRight === 'boolean' ? toBigInt(rawRight) : rawRight
  if (typeof left === 'bigint' && typeof right === 'bigint') {
    return left < right ? -1 : left > right ? 1 : 0
  }
  if (typeof left === 'number' && typeof right === 'number') {
    return left < right ? -1 : left > right ? 1 : 0
  }
  const [integer, float, flip] =
    typeof left === 'bigint'
      ? [left, right as number, 1 as const]
      : [right as bigint, left as number, -1 as const]
  let order: -1 | 0 | 1
  const SAFE = 9007199254740992 // 2**53: every double at or beyond it is integral
  if (integer >= -9007199254740992n && integer <= 9007199254740992n) {
    const approx = Number(integer)
    order = approx < float ? -1 : approx > float ? 1 : 0
  } else if (Math.abs(float) >= SAFE) {
    const exact = BigInt(float)
    order = integer < exact ? -1 : integer > exact ? 1 : 0
  } else {
    order = integer > 0n ? 1 : -1
  }
  return (order * flip) as -1 | 0 | 1
}

const COMPARE_OPERATORS: Record<string, (a: ExpressionScalar, b: ExpressionScalar) => boolean> = {
  '==': (a, b) => compareScalars(a, b) === 0,
  '!=': (a, b) => compareScalars(a, b) !== 0,
  '<': (a, b) => compareScalars(a, b) < 0,
  '<=': (a, b) => compareScalars(a, b) <= 0,
  '>': (a, b) => compareScalars(a, b) > 0,
  '>=': (a, b) => compareScalars(a, b) >= 0,
}

// ---------------------------------------------------------------------------
// Rounding with CPython semantics

/** round(float) with no ndigits: nearest integer, ties to even. */
function roundHalfEvenToInt(x: number): bigint {
  if (Math.abs(x) >= 4503599627370496) return BigInt(x) // 2**52: already integral
  const floor = Math.floor(x)
  const diff = x - floor
  if (diff > 0.5) return BigInt(floor + 1)
  if (diff < 0.5) return BigInt(floor)
  return BigInt(floor % 2 === 0 ? floor : floor + 1)
}

/** Exact mantissa/exponent decomposition: x = mantissa * 2**exponent. */
function decompose(x: number): { mantissa: bigint; exponent: number } {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, x)
  const high = view.getUint32(0)
  const low = view.getUint32(4)
  const sign = high >>> 31 ? -1n : 1n
  const biased = (high >>> 20) & 0x7ff
  const fractionHigh = BigInt(high & 0xfffff)
  const fraction = (fractionHigh << 32n) | BigInt(low)
  if (biased === 0) return { mantissa: sign * fraction, exponent: -1074 }
  return { mantissa: sign * (fraction | (1n << 52n)), exponent: biased - 1075 }
}

/** Round-half-even of numerator/denominator (denominator > 0). */
function divideHalfEven(numerator: bigint, denominator: bigint): bigint {
  let quotient = numerator / denominator
  let remainder = numerator % denominator
  if (remainder < 0n) {
    quotient -= 1n
    remainder += denominator
  }
  const doubled = remainder * 2n
  if (doubled > denominator) return quotient + 1n
  if (doubled < denominator) return quotient
  return quotient % 2n === 0n ? quotient : quotient + 1n
}

/**
 * round(float, ndigits): correctly rounded decimal rounding, half-even,
 * matching CPython's dtoa-based double_round via exact bigint arithmetic.
 */
function roundFloatToDigits(x: number, ndigits: bigint): number {
  if (x === 0) return x
  // CPython short-circuits: far past the representable decimal range the
  // value is unchanged (large ndigits) or rounds to signed zero (small).
  if (ndigits > 1074n) return x
  if (ndigits < -1075n) return copySignZero(x)
  const n = Number(ndigits)
  const { mantissa, exponent } = decompose(x)
  // x * 10**n = mantissa * 2**exponent * 10**n; round to integer half-even.
  let numerator = mantissa
  let denominator = 1n
  if (exponent >= 0) numerator <<= BigInt(exponent)
  else denominator <<= BigInt(-exponent)
  if (n >= 0) numerator *= 10n ** BigInt(n)
  else denominator *= 10n ** BigInt(-n)
  const scaled = divideHalfEven(numerator, denominator)
  if (scaled === 0n) return copySignZero(x)
  // Number() parses decimal exponent notation with correct rounding.
  const result = Number(`${scaled}e${-n}`)
  if (!Number.isFinite(result)) fail('rounded result overflows a float')
  return result
}

/** round(int, ndigits<0): nearest multiple of 10**-ndigits, ties to even. */
function roundIntToDigits(value: bigint, ndigits: bigint): bigint {
  if (ndigits >= 0n) return value
  const magnitude = -ndigits
  const digits = BigInt((value < 0n ? -value : value).toString().length)
  if (magnitude > digits) return 0n
  return divideHalfEven(value, 10n ** magnitude) * 10n ** magnitude
}

// ---------------------------------------------------------------------------
// Function table

function unwrapVariadic(args: readonly EvalValue[]): readonly EvalValue[] {
  if (args.length === 1 && Array.isArray(args[0])) {
    return args[0] as readonly ExpressionScalar[]
  }
  return args
}

function variadicSum(args: readonly EvalValue[]): ExpressionScalar {
  let total: ExpressionScalar = 0n
  for (const value of unwrapVariadic(args)) total = pyAdd(total, requireScalar(value))
  return total
}

function variadicExtreme(args: readonly EvalValue[], keepNew: -1 | 1): ExpressionScalar {
  const items = unwrapVariadic(args)
  if (items.length === 0) fail('min/max of an empty sequence')
  let best = requireScalar(items[0]!)
  for (let index = 1; index < items.length; index += 1) {
    const candidate = requireScalar(items[index]!)
    if (compareScalars(candidate, best) === keepNew) best = candidate
  }
  return best
}

function clamp(value: ExpressionScalar, minimum: ExpressionScalar, maximum: ExpressionScalar): ExpressionScalar {
  if (compareScalars(minimum, maximum) > 0) fail('clamp minimum must be <= maximum')
  const lower = compareScalars(value, minimum) < 0 ? minimum : value
  return compareScalars(maximum, lower) < 0 ? maximum : lower
}

/** math.floor / math.ceil return ints. */
function floorCeil(value: ExpressionScalar, direction: 'floor' | 'ceil'): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'boolean') return toBigInt(value)
  const rounded = direction === 'floor' ? Math.floor(value) : Math.ceil(value)
  return BigInt(rounded)
}

function pyRound(args: readonly EvalValue[]): ExpressionScalar {
  if (args.length < 1 || args.length > 2) fail('round expects one or two arguments')
  const value = requireScalar(args[0]!)
  if (args.length === 1) {
    if (typeof value === 'bigint') return value
    if (typeof value === 'boolean') return toBigInt(value)
    return requireScalar(roundHalfEvenToInt(value))
  }
  const rawDigits = requireScalar(args[1]!)
  if (typeof rawDigits === 'number') fail('round ndigits must be an integer')
  const ndigits = toBigInt(rawDigits)
  if (typeof value === 'number') return requireScalar(roundFloatToDigits(value, ndigits))
  return requireScalar(roundIntToDigits(toBigInt(value), ndigits))
}

function pyAbs(value: ExpressionScalar): ExpressionScalar {
  if (typeof value === 'number') return Math.abs(value)
  const integer = toBigInt(value)
  return integer < 0n ? -integer : integer
}

function sign(value: ExpressionScalar): bigint {
  const positive = compareScalars(value, 0n) > 0 ? 1n : 0n
  const negative = compareScalars(value, 0n) < 0 ? 1n : 0n
  return positive - negative
}

function lerp(start: ExpressionScalar, end: ExpressionScalar, amount: ExpressionScalar): ExpressionScalar {
  return pyAdd(start, pyMultiply(pySubtract(end, start), amount))
}

function pyInt(value: ExpressionScalar): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'boolean') return toBigInt(value)
  return BigInt(Math.trunc(value))
}

function mathUnary(operation: (x: number) => number): (value: ExpressionScalar) => number {
  return (value) => operation(toFloat(value))
}

function pyLog(args: readonly EvalValue[]): number {
  if (args.length < 1 || args.length > 2) fail('log expects one or two arguments')
  const value = toFloat(requireScalar(args[0]!))
  if (args.length === 1) return Math.log(value)
  const base = toFloat(requireScalar(args[1]!))
  return Math.log(value) / Math.log(base)
}

interface FunctionSpec {
  readonly minArgs: number
  readonly maxArgs: number
  readonly apply: (args: readonly EvalValue[]) => EvalValue
}

function fixed(
  arity: number,
  apply: (...scalars: ExpressionScalar[]) => EvalValue,
): FunctionSpec {
  return {
    minArgs: arity,
    maxArgs: arity,
    apply: (args) => apply(...args.map((value) => requireScalar(value))),
  }
}

const FUNCTIONS: Readonly<Record<string, FunctionSpec>> = {
  sum: { minArgs: 0, maxArgs: Infinity, apply: variadicSum },
  min: { minArgs: 0, maxArgs: Infinity, apply: (args) => variadicExtreme(args, -1) },
  max: { minArgs: 0, maxArgs: Infinity, apply: (args) => variadicExtreme(args, 1) },
  clamp: fixed(3, (value, minimum, maximum) => clamp(value, minimum, maximum)),
  floor: fixed(1, (value) => floorCeil(value, 'floor')),
  ceil: fixed(1, (value) => floorCeil(value, 'ceil')),
  round: { minArgs: 1, maxArgs: 2, apply: pyRound },
  abs: fixed(1, pyAbs),
  sign: fixed(1, sign),
  pow: fixed(2, (base, exponent) => pyPow(base, exponent)),
  sqrt: fixed(1, mathUnary(Math.sqrt)),
  exp: fixed(1, mathUnary(Math.exp)),
  log: { minArgs: 1, maxArgs: 2, apply: pyLog },
  log2: fixed(1, mathUnary(Math.log2)),
  log10: fixed(1, mathUnary(Math.log10)),
  sin: fixed(1, mathUnary(Math.sin)),
  cos: fixed(1, mathUnary(Math.cos)),
  tan: fixed(1, mathUnary(Math.tan)),
  asin: fixed(1, mathUnary(Math.asin)),
  acos: fixed(1, mathUnary(Math.acos)),
  atan: fixed(1, mathUnary(Math.atan)),
  atan2: fixed(2, (y, x) => Math.atan2(toFloat(y), toFloat(x))),
  lerp: fixed(3, (start, end, amount) => lerp(start, end, amount)),
  mod: fixed(2, (left, right) => pyModulo(left, right)),
  int: fixed(1, pyInt),
  float: fixed(1, (value) => requireScalar(toFloat(value))),
}

// ---------------------------------------------------------------------------
// Parser: Python expression subset with ast.walk-equivalent node counting

type BinOpKind = '+' | '-' | '*' | '/' | '//' | '%' | '**' | '<<' | '>>' | '|' | '&' | '^'
type UnaryKind = 'uadd' | 'usub' | 'not' | 'invert'
type CompareKind = '==' | '!=' | '<' | '<=' | '>' | '>='

type AstNode =
  | { readonly t: 'const'; readonly v: ExpressionScalar | null }
  | { readonly t: 'name'; readonly id: string }
  | { readonly t: 'bin'; readonly op: BinOpKind; readonly left: AstNode; readonly right: AstNode }
  | { readonly t: 'unary'; readonly op: UnaryKind; readonly operand: AstNode }
  | { readonly t: 'bool'; readonly op: 'and' | 'or'; readonly values: readonly AstNode[] }
  | {
      readonly t: 'cmp'
      readonly left: AstNode
      readonly ops: readonly CompareKind[]
      readonly comparators: readonly AstNode[]
    }
  | { readonly t: 'ifexp'; readonly test: AstNode; readonly body: AstNode; readonly orelse: AstNode }
  | { readonly t: 'call'; readonly func: string; readonly args: readonly AstNode[] }
  | { readonly t: 'sub'; readonly value: AstNode; readonly index: AstNode }

interface Token {
  readonly kind: 'number' | 'name' | 'op' | 'end'
  readonly text: string
  readonly value?: bigint | number
}

const KEYWORDS = new Set(['if', 'else', 'and', 'or', 'not', 'True', 'False', 'None'])
const MULTI_CHAR_OPS = ['**', '//', '<<', '>>', '<=', '>=', '==', '!=']
const SINGLE_CHAR_OPS = new Set(['+', '-', '*', '/', '%', '<', '>', '|', '&', '^', '~', '(', ')', '[', ']', ','])

function tokenize(rawExpression: string): Token[] {
  // Python universal newlines: \r\n and lone \r are line terminators.
  const expression = rawExpression.replace(/\r\n?/g, '\n')
  const tokens: Token[] = []
  let depth = 0
  let index = 0
  // Set once an unbracketed newline ends the top-level logical line: later
  // whitespace, newlines, and comments stay trivia, but any further token
  // is an error (matching ast.parse in eval mode).
  let terminated = false
  // Python's tokenizer applies indentation rules even in eval mode: leading
  // whitespace before the first real token of an unbracketed logical line is
  // an "unexpected indent" error, blank and comment-only lines are exempt,
  // and a whitespace-only final line without a trailing newline is an error.
  // Each physical line's leading scan must end at column zero: form feed
  // resets the current line's column, while a backslash continuation carries
  // a nonzero column forward (`indented`) until a comment or newline shows
  // the logical line is blank. `lineIndent` is the current line's scan.
  let indented = false
  let lineIndent = false
  let logicalLineHasToken = false
  while (index < expression.length) {
    const char = expression[index]!
    if (char === ' ' || char === '\t') {
      if (depth === 0 && !logicalLineHasToken) lineIndent = true
      index += 1
      continue
    }
    if (char === '\f') {
      // Form feed is whitespace that resets the current line's indentation
      // column, so only space or tab after it re-indents the line.
      lineIndent = false
      index += 1
      continue
    }
    if (char === '\n') {
      if (depth === 0 && tokens.length > 0) terminated = true
      indented = false
      lineIndent = false
      logicalLineHasToken = false
      index += 1
      continue
    }
    if (char === '\\') {
      // Explicit line continuation: backslash immediately before a newline
      // joins the lines; anything else after the backslash is an error, and
      // a continuation that reaches end of input leaves nothing to continue
      // (both match ast.parse).
      if (expression[index + 1] !== '\n') fail('invalid expression: unexpected character after line continuation')
      indented = indented || lineIndent
      lineIndent = false
      index += 2
      if (index >= expression.length) fail('invalid expression: unexpected end of input after line continuation')
      continue
    }
    if (char === '#') {
      // Comment runs to end of line; the newline itself is left for the
      // newline rule. A comment-only line is blank, so its indent is forgiven.
      indented = false
      lineIndent = false
      const newline = expression.indexOf('\n', index)
      index = newline === -1 ? expression.length : newline
      continue
    }
    if (indented || lineIndent) fail('invalid expression: unexpected indent')
    if (terminated) fail('invalid expression: unexpected newline')
    logicalLineHasToken = true
    if (char === '"' || char === "'") fail('expression values must be int, float, or bool')
    if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(expression[index + 1] ?? ''))) {
      const rest = expression.slice(index)
      // Python allows one underscore after the base prefix (0x_FF) as well
      // as between digits; consecutive or trailing underscores stay errors.
      let match = /^0[xX](_?[0-9a-fA-F])+/.exec(rest)
      if (match) {
        tokens.push({ kind: 'number', text: match[0], value: BigInt(match[0].replaceAll('_', '')) })
        index += match[0].length
        continue
      }
      match = /^0[oO](_?[0-7])+/.exec(rest)
      if (match) {
        tokens.push({ kind: 'number', text: match[0], value: BigInt(match[0].replaceAll('_', '')) })
        index += match[0].length
        continue
      }
      match = /^0[bB](_?[01])+/.exec(rest)
      if (match) {
        tokens.push({ kind: 'number', text: match[0], value: BigInt(match[0].replaceAll('_', '')) })
        index += match[0].length
        continue
      }
      match = /^(?:[0-9](_?[0-9])*)?\.(?:[0-9](_?[0-9])*)?(?:[eE][+-]?[0-9](_?[0-9])*)?|^[0-9](_?[0-9])*(?:[eE][+-]?[0-9](_?[0-9])*)?/.exec(rest)
      if (!match || match[0] === '' || match[0] === '.') fail('invalid expression: malformed number')
      const text = match[0]
      const normalized = text.replaceAll('_', '')
      if (/[jJ]/.test(expression[index + text.length] ?? '')) {
        fail('expression values must be int, float, or bool')
      }
      if (normalized.includes('.') || normalized.includes('e') || normalized.includes('E')) {
        tokens.push({ kind: 'number', text, value: Number(normalized) })
      } else {
        if (/^0[0-9]*[1-9]/.test(normalized)) fail('invalid expression: leading zeros in integer literal')
        tokens.push({ kind: 'number', text, value: BigInt(normalized) })
      }
      index += text.length
      continue
    }
    if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(expression.slice(index))!
      tokens.push({ kind: 'name', text: match[0] })
      index += match[0].length
      continue
    }
    const pair = expression.slice(index, index + 2)
    if (MULTI_CHAR_OPS.includes(pair)) {
      tokens.push({ kind: 'op', text: pair })
      index += 2
      continue
    }
    if (SINGLE_CHAR_OPS.has(char)) {
      if (char === '(' || char === '[') {
        depth += 1
        if (depth > MAX_BRACKET_DEPTH) fail('invalid expression: too many nested parentheses')
      }
      if (char === ')' || char === ']') depth = Math.max(0, depth - 1)
      tokens.push({ kind: 'op', text: char })
      index += 1
      continue
    }
    fail(`invalid expression: unexpected character ${JSON.stringify(char)}`)
  }
  // A whitespace-only final line with no trailing newline is an indentation
  // error in Python's tokenizer.
  if (indented || lineIndent) fail('invalid expression: unexpected indent')
  tokens.push({ kind: 'end', text: '' })
  return tokens
}

/**
 * Recursive-descent parser. nodeCount mirrors Python's ast.walk total for
 * the same source (operator and Load-context nodes included), so the
 * MAX_EXPRESSION_NODES limit trips exactly where the backend's does.
 */
class Parser {
  private position = 0
  nodeCount = 1 // the ast.Expression wrapper

  constructor(private readonly tokens: readonly Token[]) {}

  private peek(): Token {
    return this.tokens[this.position]!
  }

  private atOp(...texts: string[]): boolean {
    const token = this.peek()
    return token.kind === 'op' && texts.includes(token.text)
  }

  private atName(text: string): boolean {
    const token = this.peek()
    return token.kind === 'name' && token.text === text
  }

  private advance(): Token {
    const token = this.tokens[this.position]!
    this.position += 1
    return token
  }

  private expectOp(text: string): void {
    if (!this.atOp(text)) fail(`invalid expression: expected ${JSON.stringify(text)}`)
    this.advance()
  }

  parseExpression(): AstNode {
    const node = this.parseTernary()
    if (this.peek().kind !== 'end') fail('invalid expression: unexpected trailing input')
    return node
  }

  private parseTernary(): AstNode {
    const body = this.parseOr()
    if (!this.atName('if')) return body
    this.advance()
    const test = this.parseOr()
    if (!this.atName('else')) fail('invalid expression: expected "else"')
    this.advance()
    const orelse = this.parseTernary()
    this.nodeCount += 1
    return { t: 'ifexp', test, body, orelse }
  }

  private parseBoolChain(op: 'and' | 'or', parseNext: () => AstNode): AstNode {
    const values = [parseNext()]
    while (this.atName(op)) {
      this.advance()
      values.push(parseNext())
    }
    if (values.length === 1) return values[0]!
    this.nodeCount += 2 // BoolOp + its single operator node
    return { t: 'bool', op, values }
  }

  private parseOr(): AstNode {
    return this.parseBoolChain('or', () => this.parseAnd())
  }

  private parseAnd(): AstNode {
    return this.parseBoolChain('and', () => this.parseNot())
  }

  private parseNot(): AstNode {
    if (this.atName('not')) {
      this.advance()
      const operand = this.parseNot()
      this.nodeCount += 2
      return { t: 'unary', op: 'not', operand }
    }
    return this.parseComparison()
  }

  private parseComparison(): AstNode {
    const left = this.parseBitOr()
    const ops: CompareKind[] = []
    const comparators: AstNode[] = []
    while (this.atOp('==', '!=', '<', '<=', '>', '>=')) {
      ops.push(this.advance().text as CompareKind)
      comparators.push(this.parseBitOr())
    }
    if (ops.length === 0) return left
    this.nodeCount += 1 + ops.length
    return { t: 'cmp', left, ops, comparators }
  }

  private parseBinaryChain(operators: readonly BinOpKind[], parseNext: () => AstNode): AstNode {
    let left = parseNext()
    while (this.atOp(...operators)) {
      const op = this.advance().text as BinOpKind
      const right = parseNext()
      this.nodeCount += 2
      left = { t: 'bin', op, left, right }
    }
    return left
  }

  private parseBitOr(): AstNode {
    return this.parseBinaryChain(['|'], () => this.parseBitXor())
  }

  private parseBitXor(): AstNode {
    return this.parseBinaryChain(['^'], () => this.parseBitAnd())
  }

  private parseBitAnd(): AstNode {
    return this.parseBinaryChain(['&'], () => this.parseShift())
  }

  private parseShift(): AstNode {
    return this.parseBinaryChain(['<<', '>>'], () => this.parseArith())
  }

  private parseArith(): AstNode {
    return this.parseBinaryChain(['+', '-'], () => this.parseTerm())
  }

  private parseTerm(): AstNode {
    return this.parseBinaryChain(['*', '/', '//', '%'], () => this.parseUnary())
  }

  private parseUnary(): AstNode {
    if (this.atOp('+', '-', '~')) {
      const text = this.advance().text
      const operand = this.parseUnary()
      this.nodeCount += 2
      const op: UnaryKind = text === '+' ? 'uadd' : text === '-' ? 'usub' : 'invert'
      return { t: 'unary', op, operand }
    }
    return this.parsePower()
  }

  private parsePower(): AstNode {
    const base = this.parsePostfix()
    if (!this.atOp('**')) return base
    this.advance()
    const exponent = this.parseUnary()
    this.nodeCount += 2
    return { t: 'bin', op: '**', left: base, right: exponent }
  }

  private parsePostfix(): AstNode {
    let node = this.parseAtom()
    for (;;) {
      if (this.atOp('(')) {
        if (node.t !== 'name') {
          fail('only direct function calls without keyword arguments are allowed')
        }
        this.advance()
        const args: AstNode[] = []
        if (!this.atOp(')')) {
          args.push(this.parseTernary())
          while (this.atOp(',')) {
            this.advance()
            if (this.atOp(')')) break
            args.push(this.parseTernary())
          }
        }
        this.expectOp(')')
        // Call replaces the Name+Load already counted for the callee.
        this.nodeCount += 1
        node = { t: 'call', func: node.id, args }
        continue
      }
      if (this.atOp('[')) {
        this.advance()
        const index = this.parseTernary()
        this.expectOp(']')
        this.nodeCount += 2 // Subscript + its Load context
        node = { t: 'sub', value: node, index }
        continue
      }
      return node
    }
  }

  private parseAtom(): AstNode {
    const token = this.peek()
    if (token.kind === 'number') {
      this.advance()
      this.nodeCount += 1
      return { t: 'const', v: token.value! }
    }
    if (token.kind === 'name') {
      if (token.text === 'True' || token.text === 'False') {
        this.advance()
        this.nodeCount += 1
        return { t: 'const', v: token.text === 'True' }
      }
      if (token.text === 'None') {
        this.advance()
        this.nodeCount += 1
        return { t: 'const', v: null }
      }
      if (KEYWORDS.has(token.text)) fail(`invalid expression: unexpected keyword ${token.text}`)
      this.advance()
      this.nodeCount += 2 // Name + its Load context
      return { t: 'name', id: token.text }
    }
    if (this.atOp('(')) {
      this.advance()
      const inner = this.parseTernary()
      if (this.atOp(',')) fail('expression syntax Tuple is not allowed')
      this.expectOp(')')
      return inner
    }
    if (this.atOp('[')) fail('expression syntax List is not allowed')
    fail('invalid expression: unexpected token')
  }
}

/**
 * Syntax-node total for a parseable expression, equal to Python's
 * len(list(ast.walk(ast.parse(expression, mode="eval")))). Exposed so tests
 * can pin count parity; the MAX_EXPRESSION_NODES limit uses the same count.
 */
export function countExpressionNodes(expression: string): number {
  const parser = new Parser(tokenize(expression))
  parser.parseExpression()
  return parser.nodeCount
}

function parse(expression: string): AstNode {
  if (expression.trim() === '') fail('expression cannot be empty')
  if (expression.length > MAX_EXPRESSION_LENGTH) {
    fail(`expression exceeds ${MAX_EXPRESSION_LENGTH} characters`)
  }
  const parser = new Parser(tokenize(expression))
  const node = parser.parseExpression()
  if (parser.nodeCount > MAX_EXPRESSION_NODES) {
    fail(`expression exceeds ${MAX_EXPRESSION_NODES} syntax nodes`)
  }
  return node
}

// ---------------------------------------------------------------------------
// Evaluation

const BINARY_OPERATIONS: Record<BinOpKind, (a: ExpressionScalar, b: ExpressionScalar) => EvalValue> = {
  '+': pyAdd,
  '-': pySubtract,
  '*': pyMultiply,
  '/': pyDivide,
  '//': pyFloorDivide,
  '%': pyModulo,
  '**': pyPow,
  '<<': (a, b) => pyShift(a, b, 'left'),
  '>>': (a, b) => pyShift(a, b, 'right'),
  '|': (a, b) => pyBitwise(a, b, (x, y) => x | y),
  '&': (a, b) => pyBitwise(a, b, (x, y) => x & y),
  '^': (a, b) => pyBitwise(a, b, (x, y) => x ^ y),
}

function evaluateNode(node: AstNode, names: ReadonlyMap<string, EvalValue>): EvalValue {
  switch (node.t) {
    case 'const':
      return requireScalar(node.v)
    case 'name': {
      const value = names.get(node.id)
      if (value === undefined) fail(`unknown expression name '${node.id}'`)
      return value
    }
    case 'bin':
      return BINARY_OPERATIONS[node.op](
        requireScalar(evaluateNode(node.left, names)),
        requireScalar(evaluateNode(node.right, names)),
      )
    case 'unary': {
      // The backend requires a scalar operand for every unary operator,
      // including `not`; sequence truthiness is only allowed in BoolOp/IfExp.
      const value = requireScalar(evaluateNode(node.operand, names))
      if (node.op === 'not') return !truthy(value)
      if (node.op === 'invert') return ~strictInt(value, 'bitwise inversion requires an integer operand')
      if (node.op === 'uadd') return typeof value === 'boolean' ? toBigInt(value) : value
      if (typeof value === 'number') return -value
      return -toBigInt(value)
    }
    case 'bool': {
      let result: EvalValue = node.op === 'and'
      for (const item of node.values) {
        result = evaluateNode(item, names)
        if (node.op === 'and' ? !truthy(result) : truthy(result)) break
      }
      return result
    }
    case 'cmp': {
      let left = requireScalar(evaluateNode(node.left, names))
      for (let index = 0; index < node.ops.length; index += 1) {
        const right = requireScalar(evaluateNode(node.comparators[index]!, names))
        if (!COMPARE_OPERATORS[node.ops[index]!]!(left, right)) return false
        left = right
      }
      return true
    }
    case 'ifexp':
      return evaluateNode(truthy(evaluateNode(node.test, names)) ? node.body : node.orelse, names)
    case 'call': {
      // Own-property lookup only: inherited Object.prototype members such as
      // 'constructor' or 'toString' are not expression functions.
      const spec = Object.hasOwn(FUNCTIONS, node.func) ? FUNCTIONS[node.func] : undefined
      if (spec === undefined) fail(`unknown expression function '${node.func}'`)
      if (node.args.length < spec.minArgs || node.args.length > spec.maxArgs) {
        fail(`function ${node.func} received ${node.args.length} arguments`)
      }
      return spec.apply(node.args.map((argument) => evaluateNode(argument, names)))
    }
    case 'sub': {
      const container = evaluateNode(node.value, names)
      const index = evaluateNode(node.index, names)
      if (!Array.isArray(container) || typeof index !== 'bigint') {
        fail('subscripts require a sequence and an integer index')
      }
      const length = BigInt(container.length)
      const resolved = index < 0n ? index + length : index
      if (resolved < 0n || resolved >= length) fail('sequence index out of range')
      return container[Number(resolved)] as ExpressionScalar
    }
  }
}

function scalarOutputs(result: EvalValue): { float: number; int: bigint; boolean: boolean } {
  const value = requireScalar(result)
  const float = toFloat(value)
  if (!Number.isFinite(float)) fail(`expression produced a non-finite result: ${value}`)
  return { float, int: pyInt(value), boolean: truthy(value) }
}

const LOWERCASE = 'abcdefghijklmnopqrstuvwxyz'

/**
 * Evaluate grammar v1 over scalars or equal-length list vectors. Input
 * order is significant: the implicit `values` list preserves it. Throws
 * ExpressionMirrorError on any failure; callers show no estimate.
 */
export function evaluateExpression(
  expression: string,
  values: ReadonlyMap<string, ExpressionValue>,
): ExpressionResult {
  try {
    return evaluateExpressionUnguarded(expression, values)
  } catch (error) {
    // An engine resource error (stack or allocation exhaustion) from a
    // pathological expression must degrade to "no estimate", never break
    // the caller's refresh.
    if (error instanceof RangeError) fail('expression exceeds evaluator resource limits')
    throw error
  }
}

function evaluateExpressionUnguarded(
  expression: string,
  values: ReadonlyMap<string, ExpressionValue>,
): ExpressionResult {
  const parsed = parse(expression)
  for (const name of values.keys()) {
    if (name.length !== 1 || !LOWERCASE.includes(name)) {
      fail(`expression input name must be one lowercase letter, got '${name}'`)
    }
  }
  const vectorLengths = new Set<number>()
  for (const value of values.values()) {
    if (Array.isArray(value)) {
      for (const item of value) requireScalar(item)
      vectorLengths.add(value.length)
    } else {
      requireScalar(value as ExpressionScalar)
    }
  }
  for (const length of vectorLengths) {
    if (length > MAX_VECTOR_LENGTH) {
      fail(`expression vectors are limited to ${MAX_VECTOR_LENGTH} items`)
    }
  }
  if (vectorLengths.size > 1) fail('expression vector inputs must have equal lengths')

  if (vectorLengths.size === 0) {
    const context = new Map<string, EvalValue>(values as ReadonlyMap<string, EvalValue>)
    context.set('values', [...values.values()] as readonly ExpressionScalar[])
    const { float, int, boolean } = scalarOutputs(evaluateNode(parsed, context))
    return { kind: 'scalar', float, int, boolean }
  }

  const [length] = vectorLengths
  const floats: number[] = []
  const ints: bigint[] = []
  const booleans: boolean[] = []
  for (let index = 0; index < length!; index += 1) {
    const context = new Map<string, EvalValue>()
    const elementValues: ExpressionScalar[] = []
    for (const [name, value] of values) {
      const element = Array.isArray(value) ? (value[index] as ExpressionScalar) : (value as ExpressionScalar)
      context.set(name, element)
      elementValues.push(element)
    }
    context.set('values', elementValues)
    const { float, int, boolean } = scalarOutputs(evaluateNode(parsed, context))
    floats.push(float)
    ints.push(int)
    booleans.push(boolean)
  }
  return { kind: 'vector', floats, ints, booleans }
}
