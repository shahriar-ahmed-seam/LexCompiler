import type { ASTFindingNode, SourceEditAnchor, SourceEditAnchorRole, TargetRepoFile } from '../../shared/types.js';
import {
  classifyPiiName,
  isSanitizerCallee,
  lastSegment,
  MODULE_SCOPE,
  normalizeIdentifier,
  PII_CONTAINER_RE,
  sliceLines,
  slugify,
  spanText,
  SymbolTable,
  unitHoursFromName,
  type IrAssignment,
  type IrCall,
  type IrFunction,
  type IrRef,
  type ProgramIr,
  type Span,
} from './programIr.js';

const TENANT_KMS_FLAG_RE =
  /(tenant.*(kms|key|isolat|envelope|cmk|byok))|((kms|envelope|cmk|byok).*tenant)|(^|_)(use|enable|enforce)_kms(_|$)/;
const CIPHER_NAME_RE = /(cipher|encryption_(algorithm|mode|scheme|key_mode)|key_scheme|kms_mode|crypto_mode)$/;
const SHARED_KEY_RE = /(shared|global|static|single_key|default_key)/;
const TENANT_SCOPED_RE = /(tenant|kms|envelope|cmk|byok)/;
const ENCRYPT_CALL_RE = /(^|_)(encrypt|seal|kms_encrypt|envelope_encrypt)/;
const DECRYPT_CALL_RE = /(decrypt|unseal|unwrap)/;
const ROUTE_DECORATOR_RE = /\.(get|post|put|patch|delete|route|api_route|websocket|head|options|all)\s*\(|^(Get|Post|Put|Patch|Delete|All)\s*\(/;
const LOG_METHODS = new Set(['debug', 'info', 'warning', 'warn', 'error', 'exception', 'critical', 'fatal', 'log', 'trace', 'notice']);
const LOG_RECEIVER_RE = /^(_?log(ger)?|logging|logs|console|structlog|winston|pino|bunyan|syslog)$|(^|_)logger$/;
const RETENTION_NAME_RE = /(ttl|retention|retain|expir|purge|keep_for|max_age|lifetime)/;
const RETENTION_EXCLUDED_RE = /(audit|ledger|compliance_log|backup)/;
const PII_SCOPE_NAME_RE = /(pii|phi|personal|customer|user|patient|session|cache|data|record|profile|account|payment|card|kyc)/;
const CONFIDENCE_REF_RE = /(confidence|certainty|probability|likelihood)/;
const SCORE_REF_RE = /score/;
const AI_CONTEXT_RE = /\b(model|predict|prediction|inference|classifier|llm|machine_learning)\b|(^|_)(ai|ml)(_|$)/i;
const CONFIDENCE_CONST_RE =
  /(min|threshold|cutoff|floor|gate).*(confidence|certainty|score|probability)|(confidence|certainty|probability).*(threshold|min|cutoff|floor|gate)/;
const HUMAN_FLAG_RE = /(human|manual|oversight|hitl|escalat|four_eyes|maker_checker|reviewer)/;
const HUMAN_CALL_RE =
  /((request|require|queue|route|escalate|send|enqueue)_?(for_)?(human|manual)_?(review|approval))|escalat|human_review|manual_review/;
const AUDIT_FLAG_RE = /audit/;
const AUDIT_CALL_RE = /((write|append|record|emit)_?(immutable_)?audit)|(audit_?(log|trail|write|record|append))|(ledger_(append|write))/;
const EGRESS_CONTEXT_RE = /(region|replica|destination|dest|target|location|zone|datacenter|failover|backup|mirror|sync|export|residency)/;
const EGRESS_CALLEE_RE = /(replicat|sync|copy|export|transfer|upload|put_object|send|client|bucket|storage)/i;
const SOVEREIGN_FLAG_RE = /(sovereign|residency|data_boundary|geo_?fenc|eu_only|in_country|locali[sz]ation|boundary)/;

const AWS_REGION_RE = /^(us|eu|ap|sa|ca|me|af|il|mx)-(gov-)?(north|south|east|west|central|northeast|southeast|northwest|southwest)-\d+$/;
const GCP_REGION_RE =
  /^(us|europe|asia|australia|northamerica|southamerica|me|africa)-(north|south|east|west|central|northeast|southeast|northwest|southwest)\d+$/;
const AZURE_REGIONS = new Set([
  'eastus', 'eastus2', 'westus', 'westus2', 'westus3', 'centralus', 'northcentralus', 'southcentralus',
  'northeurope', 'westeurope', 'uksouth', 'ukwest', 'francecentral', 'germanywestcentral', 'switzerlandnorth',
  'swedencentral', 'norwayeast', 'polandcentral', 'italynorth', 'southeastasia', 'eastasia', 'japaneast',
  'japanwest', 'centralindia', 'southindia', 'australiaeast', 'koreacentral', 'canadacentral', 'brazilsouth',
  'uaenorth', 'southafricanorth',
]);

export function isCloudRegion(value: string): boolean {
  const v = value.trim().toLowerCase();
  return AWS_REGION_RE.test(v) || GCP_REGION_RE.test(v) || AZURE_REGIONS.has(v);
}

interface DetectorContext {
  file: TargetRepoFile;
  ir: ProgramIr;
  lines: string[];
  table: SymbolTable;
  language: 'python' | 'typescript';
  fileSlug: string;
}

interface TaintModel {
  handlesPii: boolean;
  isTainted(path: string): boolean;
  leakName(path: string): string;
  tenantExpr: string | null;
}

interface FlagBinding {
  assignment: IrAssignment;
  value: boolean;
}

function anchorFromSpan(
  ctx: DetectorContext,
  role: SourceEditAnchorRole,
  symbol: string,
  span: Span,
  extra: Partial<SourceEditAnchor> = {}
): SourceEditAnchor {
  return {
    role,
    symbol,
    line: span.line,
    column: span.col,
    endLine: span.endLine,
    endColumn: span.endCol,
    sourceText: spanText(ctx.lines, span),
    ...extra,
  };
}

function flagsMatching(ctx: DetectorContext, re: RegExp, cls: string | null): FlagBinding[] {
  return ctx.ir.assignments
    .filter((a) => a.scope === MODULE_SCOPE || (cls !== null && (a.scope === cls || a.cls === cls)))
    .filter((a) => a.value.k === 'bool' && re.test(normalizeIdentifier(lastSegment(a.target))))
    .map((a) => ({ assignment: a, value: (a.value as { v: boolean }).v }));
}

function flagAnchors(ctx: DetectorContext, role: SourceEditAnchorRole, flags: FlagBinding[]): SourceEditAnchor[] {
  return flags
    .filter((f) => !f.value && f.assignment.value.k === 'bool')
    .map((f) => {
      const v = f.assignment.value as { k: 'bool'; v: boolean; span: Span };
      return anchorFromSpan(ctx, role, f.assignment.target, v.span, { booleanValue: false });
    });
}

function functionForScope(ctx: DetectorContext, scope: string): IrFunction | null {
  return ctx.ir.functions.find((f) => f.qualname === scope) ?? null;
}

function annotationTypeNames(annotation: string): string[] {
  return annotation.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
}

function buildTaintModel(ctx: DetectorContext, fn: IrFunction | null): TaintModel {
  const piiFieldsByType = new Map<string, Map<string, string>>();
  for (const rec of ctx.ir.recordTypes) {
    const fields = new Map<string, string>();
    for (const field of rec.fields) {
      const norm = normalizeIdentifier(field.name);
      if (classifyPiiName(field.name)) fields.set(norm, field.name);
    }
    piiFieldsByType.set(rec.name, fields);
  }

  const taintedRoots = new Set<string>();
  const containers = new Map<string, Map<string, string> | null>();
  let tenantExpr: string | null = null;

  for (const param of fn?.params ?? []) {
    const name = param.name.replace(/^[*]+/, '').replace(/[?:].*$/, '').trim();
    const norm = normalizeIdentifier(name);
    if (!tenantExpr && /tenant/.test(norm) && !/(kms|key)/.test(norm)) tenantExpr = name;
    if (classifyPiiName(name)) {
      taintedRoots.add(name);
      continue;
    }
    const typed = annotationTypeNames(param.annotation)
      .map((t) => piiFieldsByType.get(t))
      .find((fields) => fields && fields.size > 0);
    if (typed) {
      containers.set(name, typed);
      continue;
    }
    if (PII_CONTAINER_RE.test(norm)) containers.set(name, null);
  }

  if (!tenantExpr && fn) {
    for (const param of fn.params) {
      const types = annotationTypeNames(param.annotation);
      for (const t of types) {
        const rec = ctx.ir.recordTypes.find((r) => r.name === t);
        const field = rec?.fields.find((f) => normalizeIdentifier(f.name) === 'tenant_id');
        if (field) {
          tenantExpr = `${param.name}.${field.name}`;
          break;
        }
      }
      if (tenantExpr) break;
    }
  }

  const isTaintedBase = (path: string): boolean => {
    const parts = path.split('.');
    const root = parts[0];
    if (taintedRoots.has(path) || taintedRoots.has(root)) return true;
    if (containers.has(root)) {
      if (parts.length === 1) return true;
      const fields = containers.get(root);
      const attr = normalizeIdentifier(parts[1]);
      return fields ? fields.has(attr) || classifyPiiName(parts[1]) !== null : true;
    }
    return classifyPiiName(lastSegment(path)) !== null;
  };

  if (fn) {
    const locals = ctx.ir.assignments.filter((a) => a.scope === fn.qualname);
    for (let pass = 0; pass < 4; pass++) {
      let changed = false;
      for (const a of locals) {
        if (taintedRoots.has(a.target)) continue;
        if (a.refs.some((r) => isTaintedBase(r.path) && !r.under.some(isSanitizerCallee))) {
          taintedRoots.add(a.target);
          changed = true;
        }
      }
      if (!changed) break;
    }
  }

  return {
    handlesPii: taintedRoots.size > 0 || containers.size > 0,
    isTainted: isTaintedBase,
    leakName: (path: string) => {
      const parts = path.split('.');
      if (containers.has(parts[0]) && parts.length > 1) return normalizeIdentifier(parts[1]);
      return normalizeIdentifier(lastSegment(path));
    },
    tenantExpr,
  };
}

function isLogSink(callee: string, language: 'python' | 'typescript'): boolean {
  if (language === 'python' && callee === 'print') return true;
  if (!callee.includes('.')) return false;
  const method = lastSegment(callee);
  if (!LOG_METHODS.has(method.toLowerCase())) return false;
  const receiver = callee.slice(0, callee.lastIndexOf('.'));
  return LOG_RECEIVER_RE.test(normalizeIdentifier(lastSegment(receiver)));
}

function leakedRefs(call: IrCall, model: TaintModel): IrRef[] {
  const seen = new Set<string>();
  const leaks: IrRef[] = [];
  for (const arg of call.args) {
    for (const ref of arg.refs) {
      if (!model.isTainted(ref.path) || ref.under.some(isSanitizerCallee)) continue;
      const key = `${ref.span.line}:${ref.span.col}:${ref.span.endCol}`;
      if (seen.has(key)) continue;
      seen.add(key);
      leaks.push(ref);
    }
  }
  return leaks;
}

function snippet(ctx: DetectorContext, start: number, end: number): string {
  return sliceLines(ctx.lines, Math.max(1, start), Math.max(start, end));
}

function astKind(ctx: DetectorContext, fn: IrFunction | null): string {
  if (!fn) return ctx.language === 'python' ? 'Module' : 'SourceFile';
  return ctx.language === 'python' ? `FunctionDef(${fn.name})` : `FunctionDeclaration(${fn.name})`;
}

function detectLoggerCalls(ctx: DetectorContext, models: Map<string, TaintModel>): ASTFindingNode[] {
  const findings: ASTFindingNode[] = [];
  for (const call of ctx.ir.calls) {
    if (!isLogSink(call.callee, ctx.language)) continue;
    if (!call.args.some((a) => a.refs.length > 0)) continue;
    const model = models.get(call.scope) ?? buildTaintModel(ctx, functionForScope(ctx, call.scope));
    const leaks = leakedRefs(call, model);
    const leakedFields = [...new Set(leaks.map((r) => model.leakName(r.path)))];
    findings.push({
      id: `ast-log-${ctx.fileSlug}-L${call.span.line}`,
      filePath: ctx.file.path,
      line: call.span.line,
      endLine: call.span.endLine,
      column: call.span.col + 1,
      language: ctx.language,
      astNodeKind: `Call(${call.callee})`,
      constructType: 'LOGGER_CALL',
      functionName: call.callee,
      codeSnippet: snippet(ctx, call.span.line, call.span.endLine),
      metadata: { logsPlaintextPii: leaks.length > 0, leakedFields },
      editAnchors: leaks.map((r) =>
        anchorFromSpan(ctx, 'PII_LOG_ARGUMENT', r.path, r.span, { context: { language: ctx.language } })
      ),
    });
  }
  return findings;
}

function cipherLabels(ctx: DetectorContext): Array<{ assignment: IrAssignment; value: string; span: Span }> {
  return ctx.ir.assignments
    .filter((a) => a.scope === MODULE_SCOPE && a.value.k === 'str')
    .filter((a) => CIPHER_NAME_RE.test(normalizeIdentifier(lastSegment(a.target))))
    .map((a) => {
      const v = a.value as { k: 'str'; v: string; span: Span };
      return { assignment: a, value: v.v, span: v.span };
    });
}

function detectPiiHandlers(ctx: DetectorContext, models: Map<string, TaintModel>): ASTFindingNode[] {
  const findings: ASTFindingNode[] = [];
  const labels = cipherLabels(ctx);
  for (const fn of ctx.ir.functions) {
    const model = models.get(fn.qualname)!;
    if (!model.handlesPii) continue;
    const encryptCalls = ctx.ir.calls.filter((c) => {
      if (c.scope !== fn.qualname) return false;
      const name = normalizeIdentifier(lastSegment(c.callee));
      return ENCRYPT_CALL_RE.test(name) && !DECRYPT_CALL_RE.test(name);
    });
    const isRoute = fn.decorators.some((d) => ROUTE_DECORATOR_RE.test(d));
    if (!isRoute && encryptCalls.length === 0) continue;

    const flags = flagsMatching(ctx, TENANT_KMS_FLAG_RE, fn.cls);
    const sharedLabels = labels.filter((l) => SHARED_KEY_RE.test(normalizeIdentifier(l.value)));
    const sharedCalls = encryptCalls.filter((c) => SHARED_KEY_RE.test(normalizeIdentifier(lastSegment(c.callee))));
    const tenantCalls = encryptCalls.filter(
      (c) =>
        !sharedCalls.includes(c) &&
        (TENANT_SCOPED_RE.test(normalizeIdentifier(lastSegment(c.callee))) ||
          c.args.some((a) => /tenant/i.test(a.keyword ?? '') || a.refs.some((r) => /tenant/i.test(r.path))))
    );
    const usesTenantKms =
      flags.every((f) => f.value) &&
      sharedLabels.length === 0 &&
      sharedCalls.length === 0 &&
      (flags.some((f) => f.value) || tenantCalls.length > 0);

    const sinks = ctx.ir.calls.filter((c) => c.scope === fn.qualname && isLogSink(c.callee, ctx.language));
    const leaks = sinks.flatMap((c) => leakedRefs(c, model));
    const leakedFields = [...new Set(leaks.map((r) => model.leakName(r.path)))];

    const anchors: SourceEditAnchor[] = [
      ...flagAnchors(ctx, 'TENANT_KMS_FLAG', flags),
      ...sharedLabels.map((l) =>
        anchorFromSpan(ctx, 'CIPHER_LABEL', l.assignment.target, l.span, { stringValue: l.value })
      ),
      ...sharedCalls.map((c) =>
        anchorFromSpan(ctx, 'SHARED_KEY_ENCRYPT_CALL', c.callee, c.span, {
          context: {
            language: ctx.language,
            calleeLine: String(c.calleeSpan.line),
            calleeCol: String(c.calleeSpan.col),
            calleeEndLine: String(c.calleeSpan.endLine),
            calleeEndCol: String(c.calleeSpan.endCol),
            closeLine: String(c.span.endLine),
            closeCol: String(Math.max(0, c.span.endCol - 1)),
            ...(model.tenantExpr ? { tenantExpr: model.tenantExpr } : {}),
          },
        })
      ),
    ];

    const cipherValue =
      labels[0]?.value ??
      (usesTenantKms ? 'AES-256-GCM-TENANT-KMS' : sharedCalls.length > 0 ? 'AES-256-GCM-SHARED-KEY' : undefined);

    findings.push({
      id: `ast-${ctx.language === 'python' ? 'py' : 'ts'}-handler-${ctx.fileSlug}-${slugify(fn.qualname)}`,
      filePath: ctx.file.path,
      line: fn.span.line,
      endLine: fn.span.endLine,
      column: fn.span.col + 1,
      language: ctx.language,
      astNodeKind: astKind(ctx, fn),
      constructType: isRoute ? 'FASTAPI_ENDPOINT' : 'PII_PROCESSING_FUNCTION',
      functionName: fn.qualname,
      codeSnippet: snippet(ctx, fn.span.line, fn.span.endLine),
      metadata: {
        usesTenantIsolatedKms: usesTenantKms,
        encryptionCipher: cipherValue,
        encryptsPii: encryptCalls.length > 0,
        logsPlaintextPii: leaks.length > 0,
        leakedFields,
      },
      editAnchors: anchors,
    });
  }
  return findings;
}

const CACHE_TTL_METHODS: Record<string, { ttlArg: number; secondsPerUnit: number; valueArg: number | null }> = {
  setex: { ttlArg: 1, secondsPerUnit: 1, valueArg: 2 },
  setEx: { ttlArg: 1, secondsPerUnit: 1, valueArg: 2 },
  psetex: { ttlArg: 1, secondsPerUnit: 0.001, valueArg: 2 },
  pSetEx: { ttlArg: 1, secondsPerUnit: 0.001, valueArg: 2 },
  expire: { ttlArg: 1, secondsPerUnit: 1, valueArg: null },
  pexpire: { ttlArg: 1, secondsPerUnit: 0.001, valueArg: null },
  pExpire: { ttlArg: 1, secondsPerUnit: 0.001, valueArg: null },
};

function cacheTtlArgument(call: IrCall): { arg: IrCall['args'][number]; secondsPerUnit: number; valueArgIndex: number | null } | null {
  const method = lastSegment(call.callee);
  const positional = call.args.filter((a) => a.keyword === null);
  const spec = CACHE_TTL_METHODS[method];
  if (spec) {
    const kwTtl = call.args.find((a) => a.keyword && /^(time|ex|seconds|ttl)$/i.test(a.keyword));
    const arg = positional[spec.ttlArg] ?? kwTtl;
    return arg ? { arg, secondsPerUnit: spec.secondsPerUnit, valueArgIndex: spec.valueArg } : null;
  }
  if (method === 'set') {
    const ex = call.args.find((a) => a.keyword && /^(ex|EX)$/.test(a.keyword));
    if (ex) return { arg: ex, secondsPerUnit: 1, valueArgIndex: 1 };
    const px = call.args.find((a) => a.keyword && /^(px|PX)$/.test(a.keyword));
    if (px) return { arg: px, secondsPerUnit: 0.001, valueArgIndex: 1 };
    const exIdx = positional.findIndex((a) => a.value.k === 'str' && /^(EX|PX)$/i.test(a.value.v));
    if (exIdx >= 0 && positional[exIdx + 1]) {
      const unit = (positional[exIdx].value as { v: string }).v.toUpperCase() === 'PX' ? 0.001 : 1;
      return { arg: positional[exIdx + 1], secondsPerUnit: unit, valueArgIndex: 1 };
    }
  }
  return null;
}

function detectCacheSinks(
  ctx: DetectorContext,
  models: Map<string, TaintModel>,
  consumedSymbols: Set<string>
): ASTFindingNode[] {
  const findings: ASTFindingNode[] = [];
  for (const call of ctx.ir.calls) {
    const ttl = cacheTtlArgument(call);
    if (!ttl) continue;
    const fn = functionForScope(ctx, call.scope);
    const model = models.get(call.scope) ?? buildTaintModel(ctx, fn);
    const positional = call.args.filter((a) => a.keyword === null);
    const valueArg = ttl.valueArgIndex !== null ? positional[ttl.valueArgIndex] : undefined;
    const cachesPii = valueArg
      ? valueArg.refs.some((r) => model.isTainted(r.path) && !r.under.some(isSanitizerCallee))
      : model.handlesPii;
    if (!cachesPii) continue;

    const resolved = ctx.table.evaluateNumeric(ttl.arg.value, call.scope, call.cls);
    const seconds = resolved ? (resolved.inSeconds ? resolved.value : resolved.value * ttl.secondsPerUnit) : null;
    const hours = seconds === null ? null : Math.round((seconds / 3600) * 1000) / 1000;
    const flags = flagsMatching(ctx, TENANT_KMS_FLAG_RE, call.cls);

    const anchors: SourceEditAnchor[] = [];
    if (resolved?.origin && Number.isFinite(resolved.scale) && resolved.scale > 0) {
      const secondsPerLiteralUnit = resolved.scale * (resolved.inSeconds ? 1 : ttl.secondsPerUnit);
      anchors.push(
        anchorFromSpan(ctx, 'RETENTION_TTL_LITERAL', resolved.origin.symbol, resolved.origin.span, {
          numericValue: resolved.origin.literal,
          hoursPerUnit: secondsPerLiteralUnit / 3600,
        })
      );
      if (resolved.origin.named) consumedSymbols.add(resolved.origin.symbol);
    }
    anchors.push(...flagAnchors(ctx, 'TENANT_KMS_FLAG', flags));

    const originLine = resolved?.origin?.span.line ?? call.span.line;
    const startLine = Math.min(originLine, fn?.span.line ?? call.span.line);
    const endLine = fn?.span.endLine ?? call.span.endLine;
    findings.push({
      id: `ast-cache-${ctx.fileSlug}-${slugify(call.scope)}-L${call.span.line}`,
      filePath: ctx.file.path,
      line: originLine,
      endLine,
      column: 1,
      language: ctx.language,
      astNodeKind: `Call(${call.callee})`,
      constructType: 'REDIS_CACHE_WORKER',
      functionName: call.scope === MODULE_SCOPE ? call.callee : call.scope,
      codeSnippet: snippet(ctx, startLine, endLine),
      metadata: {
        retentionTtlHours: hours,
        usesTenantIsolatedKms: flags.length > 0 && flags.every((f) => f.value),
      },
      editAnchors: anchors,
    });
  }
  return findings;
}

function referencingFunction(ctx: DetectorContext, symbol: string): IrFunction | null {
  return ctx.ir.functions.find((f) => (ctx.ir.scopeRefs[f.qualname] ?? []).includes(symbol)) ?? null;
}

function detectRetentionConstants(
  ctx: DetectorContext,
  consumedSymbols: Set<string>,
  fileHandlesPii: boolean
): ASTFindingNode[] {
  const findings: ASTFindingNode[] = [];
  for (const a of ctx.ir.assignments) {
    if (a.scope !== MODULE_SCOPE && a.scope !== a.cls) continue;
    if (consumedSymbols.has(a.target)) continue;
    const name = normalizeIdentifier(lastSegment(a.target));
    if (!RETENTION_NAME_RE.test(name) || RETENTION_EXCLUDED_RE.test(name)) continue;
    if (!PII_SCOPE_NAME_RE.test(name) && !fileHandlesPii) continue;
    const resolved = ctx.table.evaluateNumeric(a.value, a.scope, a.cls);
    if (!resolved) continue;
    const unitHours = resolved.inSeconds ? 1 / 3600 : unitHoursFromName(a.target);
    if (unitHours === null) continue;
    const hours = Math.round(resolved.value * unitHours * 1000) / 1000;
    const anchors: SourceEditAnchor[] = [];
    if (resolved.origin && Number.isFinite(resolved.scale) && resolved.scale > 0) {
      anchors.push(
        anchorFromSpan(ctx, 'RETENTION_TTL_LITERAL', a.target, resolved.origin.span, {
          numericValue: resolved.origin.literal,
          hoursPerUnit: resolved.scale * unitHours,
        })
      );
    }
    const user = referencingFunction(ctx, a.target);
    findings.push({
      id: `ast-retention-${ctx.fileSlug}-${slugify(a.target)}`,
      filePath: ctx.file.path,
      line: a.span.line,
      endLine: a.span.endLine,
      column: a.span.col + 1,
      language: ctx.language,
      astNodeKind: ctx.language === 'python' ? `Assign(${a.target})` : `VariableDeclaration(${a.target})`,
      constructType: 'DATA_RETENTION_POLICY',
      functionName: user ? user.qualname : a.target,
      codeSnippet: snippet(ctx, a.span.line, a.span.endLine),
      metadata: { retentionTtlHours: hours },
      editAnchors: anchors,
    });
  }
  return findings;
}

function detectAiDecisionGates(ctx: DetectorContext): ASTFindingNode[] {
  const aiContext = AI_CONTEXT_RE.test(ctx.file.content);
  const isConfidenceRef = (refs: IrRef[]) =>
    refs.some((r) => {
      const name = normalizeIdentifier(lastSegment(r.path));
      return CONFIDENCE_REF_RE.test(name) || (aiContext && SCORE_REF_RE.test(name));
    });

  const gates = new Map<string, { threshold: number; origin: NonNullable<ReturnType<SymbolTable['evaluateNumeric']>>['origin']; line: number; cls: string | null }>();
  for (const cmp of ctx.ir.compares) {
    let other: { value: typeof cmp.left; refs: IrRef[] } | null = null;
    if (isConfidenceRef(cmp.leftRefs)) other = { value: cmp.right, refs: cmp.rightRefs };
    else if (isConfidenceRef(cmp.rightRefs)) other = { value: cmp.left, refs: cmp.leftRefs };
    if (!other) continue;
    const resolved = ctx.table.evaluateNumeric(other.value, cmp.scope, cmp.cls);
    if (!resolved) continue;
    const threshold = resolved.value > 1 && resolved.value <= 100 ? resolved.value / 100 : resolved.value;
    if (!(threshold > 0 && threshold <= 1)) continue;
    const existing = gates.get(cmp.scope);
    if (!existing || threshold < existing.threshold) {
      gates.set(cmp.scope, { threshold, origin: resolved.origin, line: cmp.span.line, cls: cmp.cls });
    }
  }

  const usedSymbols = new Set([...gates.values()].map((g) => g.origin?.symbol).filter((s): s is string => Boolean(s)));
  for (const a of ctx.ir.assignments) {
    if (a.scope !== MODULE_SCOPE || a.value.k !== 'num' || usedSymbols.has(a.target)) continue;
    if (!CONFIDENCE_CONST_RE.test(normalizeIdentifier(lastSegment(a.target)))) continue;
    const raw = a.value.v;
    const threshold = raw > 1 && raw <= 100 ? raw / 100 : raw;
    if (!(threshold > 0 && threshold <= 1)) continue;
    const user = referencingFunction(ctx, a.target);
    const scope = user?.qualname ?? MODULE_SCOPE;
    if (gates.has(scope)) continue;
    gates.set(scope, {
      threshold,
      origin: { symbol: a.target, span: a.value.span, literal: raw, named: true },
      line: a.span.line,
      cls: user?.cls ?? null,
    });
  }

  const findings: ASTFindingNode[] = [];
  for (const [scope, gate] of gates) {
    const fn = functionForScope(ctx, scope);
    const humanFlags = flagsMatching(ctx, HUMAN_FLAG_RE, gate.cls);
    const auditFlags = flagsMatching(ctx, AUDIT_FLAG_RE, gate.cls);
    const scopeCalls = ctx.ir.calls.filter((c) => c.scope === scope || (fn && c.scope.startsWith(`${fn.qualname}.`)));
    const humanCalls = scopeCalls.filter((c) => HUMAN_CALL_RE.test(normalizeIdentifier(lastSegment(c.callee))));
    const auditCalls = scopeCalls.filter((c) => AUDIT_CALL_RE.test(normalizeIdentifier(lastSegment(c.callee))));
    const hasHuman = humanFlags.length > 0 ? humanFlags.every((f) => f.value) : humanCalls.length > 0;
    const writesAudit = auditFlags.length > 0 ? auditFlags.every((f) => f.value) : auditCalls.length > 0;

    const anchors: SourceEditAnchor[] = [];
    if (gate.origin) {
      anchors.push(
        anchorFromSpan(ctx, 'AI_CONFIDENCE_THRESHOLD', gate.origin.symbol, gate.origin.span, {
          numericValue: gate.origin.literal,
          context: { format: gate.origin.literal > 1 ? 'percent' : 'fraction' },
        })
      );
    }
    anchors.push(...flagAnchors(ctx, 'HUMAN_OVERSIGHT_FLAG', humanFlags));
    anchors.push(...flagAnchors(ctx, 'AUDIT_LOG_FLAG', auditFlags));

    const startLine = gate.origin && gate.origin.span.line < (fn?.span.line ?? gate.line) ? gate.origin.span.line : fn?.span.line ?? gate.line;
    const endLine = fn?.span.endLine ?? gate.line;
    findings.push({
      id: `ast-ai-${ctx.fileSlug}-${slugify(scope)}`,
      filePath: ctx.file.path,
      line: startLine,
      endLine,
      column: 1,
      language: ctx.language,
      astNodeKind: astKind(ctx, fn),
      constructType: 'LLM_INFERENCE_CALL',
      functionName: fn?.qualname ?? gate.origin?.symbol ?? scope,
      codeSnippet: snippet(ctx, startLine, endLine),
      metadata: {
        aiConfidenceThreshold: Math.round(gate.threshold * 10000) / 10000,
        hasHumanOversightGate: hasHuman,
        writesAuditLog: writesAudit,
      },
      editAnchors: anchors,
    });
  }
  return findings;
}

function detectEgressRegions(ctx: DetectorContext): ASTFindingNode[] {
  const candidates: Array<{ value: string; span: Span; symbol: string; scope: string }> = [];
  for (const a of ctx.ir.assignments) {
    if (a.value.k !== 'str' || !isCloudRegion(a.value.v)) continue;
    if (!EGRESS_CONTEXT_RE.test(normalizeIdentifier(lastSegment(a.target)))) continue;
    candidates.push({ value: a.value.v, span: a.value.span, symbol: a.target, scope: a.scope });
  }
  for (const call of ctx.ir.calls) {
    for (const arg of call.args) {
      if (arg.value.k !== 'str' || !isCloudRegion(arg.value.v)) continue;
      const contextual = arg.keyword ? EGRESS_CONTEXT_RE.test(normalizeIdentifier(arg.keyword)) : EGRESS_CALLEE_RE.test(call.callee);
      if (!contextual) continue;
      candidates.push({ value: arg.value.v, span: arg.value.span, symbol: `${call.callee}(${arg.keyword ?? ''})`, scope: call.scope });
    }
  }

  const seen = new Set<string>();
  const sovereignFlags = flagsMatching(ctx, SOVEREIGN_FLAG_RE, null);
  const findings: ASTFindingNode[] = [];
  for (const c of candidates) {
    const key = `${c.span.line}:${c.span.col}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const user = c.scope === MODULE_SCOPE ? referencingFunction(ctx, c.symbol) : functionForScope(ctx, c.scope);
    const endLine = user && user.span.endLine > c.span.line ? user.span.endLine : c.span.endLine;
    const quote = spanText(ctx.lines, c.span).charAt(0);
    findings.push({
      id: `ast-egress-${ctx.fileSlug}-L${c.span.line}`,
      filePath: ctx.file.path,
      line: c.span.line,
      endLine,
      column: c.span.col + 1,
      language: ctx.language,
      astNodeKind: user ? astKind(ctx, user) : `Literal(${c.symbol})`,
      constructType: 'CROSS_BORDER_EGRESS',
      functionName: user?.qualname ?? c.symbol,
      codeSnippet: snippet(ctx, c.span.line, endLine),
      metadata: {
        egressRegion: c.value,
        ...(sovereignFlags.length > 0 ? { sovereignGuardEnabled: sovereignFlags.every((f) => f.value) } : {}),
      },
      editAnchors: [
        anchorFromSpan(ctx, 'EGRESS_REGION_LITERAL', c.symbol, c.span, {
          stringValue: c.value,
          context: { quote: /["'`]/.test(quote) ? quote : '"' },
        }),
        ...flagAnchors(ctx, 'SOVEREIGN_BOUNDARY_FLAG', sovereignFlags),
      ],
    });
  }
  return findings;
}

/** Runs every language-neutral compliance detector over one parsed source file. */
export function detectComplianceConstructs(file: TargetRepoFile, ir: ProgramIr): ASTFindingNode[] {
  if (ir.parseError && ir.nodeCount === 0) return [];
  const ctx: DetectorContext = {
    file,
    ir,
    lines: file.content.split('\n'),
    table: new SymbolTable(ir),
    language: ir.language,
    fileSlug: slugify(file.path, 40),
  };
  const models = new Map<string, TaintModel>();
  models.set(MODULE_SCOPE, buildTaintModel(ctx, null));
  for (const fn of ir.functions) models.set(fn.qualname, buildTaintModel(ctx, fn));
  const fileHandlesPii = ir.functions.some((fn) => models.get(fn.qualname)?.handlesPii);

  const consumedSymbols = new Set<string>();
  return [
    ...detectPiiHandlers(ctx, models),
    ...detectLoggerCalls(ctx, models),
    ...detectCacheSinks(ctx, models, consumedSymbols),
    ...detectRetentionConstants(ctx, consumedSymbols, fileHandlesPii),
    ...detectAiDecisionGates(ctx),
    ...detectEgressRegions(ctx),
  ];
}
