/**
 * Language-neutral program representation shared by the Python (`ast`) and
 * TypeScript (compiler API) front-ends, plus the scope-aware constant
 * resolution used by every compliance detector.
 */

/** 1-based lines, 0-based UTF-16 columns. */
export interface Span {
  line: number;
  endLine: number;
  col: number;
  endCol: number;
}

export type ValueExpr =
  | { k: 'num'; v: number; span: Span }
  | { k: 'str'; v: string; span: Span }
  | { k: 'bool'; v: boolean; span: Span }
  | { k: 'ref'; path: string; span: Span }
  | { k: 'bin'; op: '+' | '-' | '*' | '/' | '//'; l: ValueExpr; r: ValueExpr; span: Span }
  | { k: 'call'; callee: string; args: ValueExpr[]; kw: Record<string, ValueExpr>; span: Span }
  | { k: 'unknown'; span?: Span };

export interface IrRef {
  path: string;
  under: string[];
  span: Span;
}

export interface IrAssignment {
  target: string;
  scope: string;
  cls: string | null;
  value: ValueExpr;
  refs: IrRef[];
  span: Span;
  text: string;
}

export interface IrCallArg {
  keyword: string | null;
  value: ValueExpr;
  refs: IrRef[];
  text: string;
  span: Span;
}

export interface IrCall {
  callee: string;
  scope: string;
  cls: string | null;
  span: Span;
  calleeSpan: Span;
  args: IrCallArg[];
  text: string;
}

export type CompareOp = '<' | '<=' | '>' | '>=' | '==' | '!=';

export interface IrCompare {
  scope: string;
  cls: string | null;
  op: CompareOp;
  left: ValueExpr;
  leftRefs: IrRef[];
  right: ValueExpr;
  rightRefs: IrRef[];
  span: Span;
  text: string;
}

export interface IrParam {
  name: string;
  annotation: string;
}

export interface IrFunction {
  name: string;
  qualname: string;
  cls: string | null;
  params: IrParam[];
  decorators: string[];
  span: Span;
  /** First line of the definition including decorators and directly attached comments. */
  insertionLine: number;
  topLevel: boolean;
}

export interface IrRecordType {
  name: string;
  fields: IrParam[];
  span: Span;
}

export interface IrImport {
  module: string;
  names: string[];
  span: Span;
}

export interface ProgramIr {
  language: 'python' | 'typescript';
  nodeCount: number;
  assignments: IrAssignment[];
  calls: IrCall[];
  compares: IrCompare[];
  functions: IrFunction[];
  recordTypes: IrRecordType[];
  imports: IrImport[];
  scopeRefs: Record<string, string[]>;
  parseError: string | null;
}

export const MODULE_SCOPE = '<module>';

export function emptyIr(language: 'python' | 'typescript', parseError: string | null): ProgramIr {
  return {
    language,
    nodeCount: 0,
    assignments: [],
    calls: [],
    compares: [],
    functions: [],
    recordTypes: [],
    imports: [],
    scopeRefs: {},
    parseError,
  };
}

/** `diagnosisCode` → `diagnosis_code`, `PII_CACHE_TTL_HOURS` → `pii_cache_ttl_hours`. */
export function normalizeIdentifier(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

export function lastSegment(path: string): string {
  const idx = path.lastIndexOf('.');
  return idx >= 0 ? path.slice(idx + 1) : path;
}

export function slugify(value: string, max = 48): string {
  const slug = value
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, max);
  return slug || 'node';
}

export const PII_FIELD_RE =
  /^(ssn|social_security(_number)?|sin_number|email(_address)?|e_mail|phone(_number)?|mobile(_number)?|msisdn|full_name|first_name|last_name|surname|legal_name|dob|date_of_birth|birth_?date|passport(_no|_number)?|national_id(_number)?|nid(_number)?|tax_id|tin|itin|credit_card(_number)?|card_number|card_pan|pan_number|cvv|iban|account_number|bank_account(_number)?|diagnosis(_code)?|icd(10)?(_code)?|medical_record(_number)?|mrn|health_record|patient_[a-z0-9_]+|biometric_[a-z0-9_]+|fingerprint[a-z0-9_]*|face_(embedding|template)|retina[a-z0-9_]*|home_address|street_address|address_line[a-z0-9_]*|ip_address)$/;

export const PII_CONTAINER_RE = /(^|_)(pii|phi|pci|personal_data|sensitive_data|patient_record|customer_record)(_|$)/;

const NON_REVEALING_CALL_RE = /^(len|type|bool|isinstance|hasattr|id|count|length|size|typeof)$/;
const SANITIZER_CALL_RE =
  /(redact|mask|hash|sha256|sha512|sha1|hmac|anonymi[sz]e|pseudonymi[sz]e|tokeni[sz]e|scrub|obfuscate|encrypt|digest)/;

export function isSanitizerCallee(callee: string): boolean {
  const name = normalizeIdentifier(lastSegment(callee));
  return SANITIZER_CALL_RE.test(name) || NON_REVEALING_CALL_RE.test(lastSegment(callee));
}

export type PiiClassification = 'DIRECT_IDENTIFIER' | 'HEALTH_PHI' | 'FINANCIAL_PCI' | 'BIOMETRIC';

export function classifyPiiName(name: string): PiiClassification | null {
  const n = normalizeIdentifier(name);
  if (!PII_FIELD_RE.test(n)) return null;
  if (/^(credit_card|card_number|card_pan|pan_number|cvv|iban|account_number|bank_account)/.test(n)) {
    return 'FINANCIAL_PCI';
  }
  if (/^(diagnosis|icd|medical_record|mrn|health_record|patient_)/.test(n)) return 'HEALTH_PHI';
  if (/^(biometric_|fingerprint|face_|retina)/.test(n)) return 'BIOMETRIC';
  return 'DIRECT_IDENTIFIER';
}

/** Hours represented by one unit of a value whose unit is spelled in its identifier. */
export function unitHoursFromName(name: string): number | null {
  const n = normalizeIdentifier(lastSegment(name));
  if (/(^|_)(ms|millis|milliseconds?)$/.test(n)) return 1 / 3_600_000;
  if (/(^|_)(s|sec|secs|seconds?)$/.test(n)) return 1 / 3600;
  if (/(^|_)(min|mins|minutes?)$/.test(n)) return 1 / 60;
  if (/(^|_)(h|hr|hrs|hours?)$/.test(n)) return 1;
  if (/(^|_)(d|days?)$/.test(n)) return 24;
  if (/(^|_)(w|wk|wks|weeks?)$/.test(n)) return 168;
  if (/(^|_)(mo|mos|months?)$/.test(n)) return 720;
  if (/(^|_)(y|yr|yrs|years?)$/.test(n)) return 8760;
  return null;
}

export interface NumericOrigin {
  symbol: string;
  span: Span;
  literal: number;
  named: boolean;
}

export interface NumericResolution {
  value: number;
  origin: NumericOrigin | null;
  /** d(value) / d(origin literal); NaN when the relationship is not linear. */
  scale: number;
  /** True when the value is already expressed in seconds (e.g. `timedelta`). */
  inSeconds: boolean;
}

export interface StringResolution {
  value: string;
  span: Span;
  symbol: string;
}

const TIMEDELTA_UNIT_SECONDS: Record<string, number> = {
  weeks: 604_800,
  days: 86_400,
  hours: 3600,
  minutes: 60,
  seconds: 1,
  milliseconds: 0.001,
};
const TIMEDELTA_POSITIONAL = ['days', 'seconds', 'microseconds', 'milliseconds', 'minutes', 'hours', 'weeks'];
const PASSTHROUGH_CALLEES = /^(int|float|round|Number|parseInt|parseFloat|floor|ceil|trunc)$/;

/**
 * Resolves names through function, class/instance (`self.` / `this.`) and
 * module scopes, so a cache TTL like `self.ttl_hours * 3600` folds back to the
 * literal it was configured from.
 */
export class SymbolTable {
  private readonly byTarget = new Map<string, IrAssignment[]>();

  constructor(private readonly ir: ProgramIr) {
    for (const a of ir.assignments) {
      const list = this.byTarget.get(a.target) ?? [];
      list.push(a);
      this.byTarget.set(a.target, list);
    }
  }

  assignmentsInScope(scope: string): IrAssignment[] {
    return this.ir.assignments.filter((a) => a.scope === scope);
  }

  resolve(path: string, scope: string, cls: string | null): IrAssignment | null {
    const exact = this.byTarget.get(path) ?? [];
    const sameScope = exact.find((a) => a.scope === scope);
    if (sameScope) return sameScope;

    const instance = /^(self|this)\.(.+)$/.exec(path);
    if (instance && cls) {
      const attr = instance[2];
      const viaInstance = [...(this.byTarget.get(`self.${attr}`) ?? []), ...(this.byTarget.get(`this.${attr}`) ?? [])]
        .find((a) => a.cls === cls);
      if (viaInstance) return viaInstance;
      const classAttr = (this.byTarget.get(attr) ?? []).find((a) => a.scope === cls);
      if (classAttr) return classAttr;
    }

    // Enclosing function scopes for nested definitions (`Outer.inner` → `Outer`).
    let parent = scope;
    while (parent.includes('.')) {
      parent = parent.slice(0, parent.lastIndexOf('.'));
      const enclosing = exact.find((a) => a.scope === parent);
      if (enclosing) return enclosing;
    }

    return exact.find((a) => a.scope === MODULE_SCOPE) ?? null;
  }

  evaluateNumeric(expr: ValueExpr, scope: string, cls: string | null, depth = 0): NumericResolution | null {
    if (depth > 12) return null;
    switch (expr.k) {
      case 'num':
        return {
          value: expr.v,
          origin: { symbol: '<inline>', span: expr.span, literal: expr.v, named: false },
          scale: 1,
          inSeconds: false,
        };
      case 'ref': {
        const assignment = this.resolve(expr.path, scope, cls);
        if (!assignment) return null;
        const resolved = this.evaluateNumeric(assignment.value, assignment.scope, assignment.cls, depth + 1);
        if (resolved?.origin && !resolved.origin.named) {
          resolved.origin = { ...resolved.origin, symbol: assignment.target, named: true };
        }
        return resolved;
      }
      case 'bin': {
        const l = this.evaluateNumeric(expr.l, scope, cls, depth + 1);
        const r = this.evaluateNumeric(expr.r, scope, cls, depth + 1);
        if (!l || !r) return null;
        const value = applyBinary(expr.op, l.value, r.value);
        if (value === null) return null;
        const useRight = Boolean(r.origin?.named) && !l.origin?.named;
        const inSeconds = l.inSeconds || r.inSeconds;
        if (!useRight) {
          let scale = l.scale;
          if (expr.op === '*') scale = l.scale * r.value;
          else if (expr.op === '/' || expr.op === '//') scale = r.value === 0 ? Number.NaN : l.scale / r.value;
          return { value, origin: l.origin, scale, inSeconds };
        }
        let scale = r.scale;
        if (expr.op === '*') scale = r.scale * l.value;
        else if (expr.op === '-') scale = -r.scale;
        else if (expr.op === '/' || expr.op === '//') scale = Number.NaN;
        return { value, origin: r.origin, scale, inSeconds };
      }
      case 'call': {
        const callee = lastSegment(expr.callee);
        if (callee === 'timedelta') {
          let seconds = 0;
          let origin: NumericOrigin | null = null;
          let scale = Number.NaN;
          const parts: Array<[string, ValueExpr]> = [
            ...expr.args.map((a, i): [string, ValueExpr] => [TIMEDELTA_POSITIONAL[i] ?? 'seconds', a]),
            ...Object.entries(expr.kw),
          ];
          for (const [unit, valueExpr] of parts) {
            const unitSeconds = TIMEDELTA_UNIT_SECONDS[unit];
            if (unitSeconds === undefined) continue;
            const part = this.evaluateNumeric(valueExpr, scope, cls, depth + 1);
            if (!part) return null;
            seconds += part.value * unitSeconds;
            if (parts.length === 1) {
              origin = part.origin;
              scale = part.scale * unitSeconds;
            }
          }
          return { value: seconds, origin, scale, inSeconds: true };
        }
        if (PASSTHROUGH_CALLEES.test(callee) && expr.args[0]) {
          return this.evaluateNumeric(expr.args[0], scope, cls, depth + 1);
        }
        return null;
      }
      default:
        return null;
    }
  }

  evaluateString(expr: ValueExpr, scope: string, cls: string | null, depth = 0): StringResolution | null {
    if (depth > 8) return null;
    if (expr.k === 'str') return { value: expr.v, span: expr.span, symbol: '<inline>' };
    if (expr.k === 'ref') {
      const assignment = this.resolve(expr.path, scope, cls);
      if (!assignment) return null;
      const resolved = this.evaluateString(assignment.value, assignment.scope, assignment.cls, depth + 1);
      if (resolved && resolved.symbol === '<inline>') return { ...resolved, symbol: assignment.target };
      return resolved;
    }
    return null;
  }
}

function applyBinary(op: '+' | '-' | '*' | '/' | '//', a: number, b: number): number | null {
  switch (op) {
    case '+':
      return a + b;
    case '-':
      return a - b;
    case '*':
      return a * b;
    case '/':
      return b === 0 ? null : a / b;
    case '//':
      return b === 0 ? null : Math.floor(a / b);
    default:
      return null;
  }
}

export function lineStartOffsets(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

export function offsetToLineCol(starts: number[], offset: number): { line: number; col: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, col: offset - starts[lo] };
}

export function sliceLines(lines: string[], startLine: number, endLine: number): string {
  return lines.slice(Math.max(0, startLine - 1), Math.max(startLine, endLine)).join('\n');
}

export function spanText(lines: string[], span: Span): string {
  if (span.line === span.endLine) {
    return (lines[span.line - 1] ?? '').slice(span.col, span.endCol);
  }
  const parts = [(lines[span.line - 1] ?? '').slice(span.col)];
  for (let l = span.line + 1; l < span.endLine; l++) parts.push(lines[l - 1] ?? '');
  parts.push((lines[span.endLine - 1] ?? '').slice(0, span.endCol));
  return parts.join('\n');
}
