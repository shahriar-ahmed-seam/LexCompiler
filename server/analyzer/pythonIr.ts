import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { sha256Hex } from '../util/hash.js';
import {
  emptyIr,
  MODULE_SCOPE,
  type IrCall,
  type IrCallArg,
  type IrRef,
  type ProgramIr,
  type Span,
  type ValueExpr,
} from './programIr.js';

const execFileAsync = promisify(execFile);

const PYTHON_IR_SCRIPT = String.raw`
import ast, json, sys

BINOPS = {ast.Add: "+", ast.Sub: "-", ast.Mult: "*", ast.Div: "/", ast.FloorDiv: "//"}
CMPOPS = {ast.Lt: "<", ast.LtE: "<=", ast.Gt: ">", ast.GtE: ">=", ast.Eq: "==", ast.NotEq: "!="}

def dotted(n):
    parts = []
    cur = n
    while isinstance(cur, ast.Attribute):
        parts.append(cur.attr)
        cur = cur.value
    if isinstance(cur, ast.Name):
        parts.append(cur.id)
        return ".".join(reversed(parts))
    return None

def sp(n):
    line = getattr(n, "lineno", 1)
    end_line = getattr(n, "end_lineno", None) or line
    col = getattr(n, "col_offset", 0)
    end_col = getattr(n, "end_col_offset", None)
    if end_col is None:
        end_col = col
    return [line, end_line, col, end_col]

def vexpr(n, d=0):
    if n is None or d > 10:
        return {"k": "unknown"}
    if isinstance(n, ast.Constant):
        v = n.value
        if isinstance(v, bool):
            return {"k": "bool", "v": v, "s": sp(n)}
        if isinstance(v, (int, float)):
            return {"k": "num", "v": v, "s": sp(n)}
        if isinstance(v, str):
            return {"k": "str", "v": v, "s": sp(n)}
        return {"k": "unknown", "s": sp(n)}
    if isinstance(n, ast.UnaryOp) and isinstance(n.op, ast.USub):
        inner = vexpr(n.operand, d + 1)
        if inner.get("k") == "num":
            return {"k": "num", "v": -inner["v"], "s": sp(n)}
        return {"k": "unknown", "s": sp(n)}
    if isinstance(n, (ast.Name, ast.Attribute)):
        p = dotted(n)
        if p:
            return {"k": "ref", "path": p, "s": sp(n)}
    if isinstance(n, ast.BinOp) and type(n.op) in BINOPS:
        return {"k": "bin", "op": BINOPS[type(n.op)], "l": vexpr(n.left, d + 1), "r": vexpr(n.right, d + 1), "s": sp(n)}
    if isinstance(n, ast.Call):
        return {
            "k": "call",
            "callee": dotted(n.func) or "",
            "args": [vexpr(a, d + 1) for a in n.args[:6]],
            "kw": {k.arg: vexpr(k.value, d + 1) for k in n.keywords if k.arg},
            "s": sp(n),
        }
    return {"k": "unknown", "s": sp(n)}

def refs(n):
    out = []
    def visit(x, under):
        if isinstance(x, (ast.Lambda, ast.FunctionDef, ast.AsyncFunctionDef)):
            return
        if isinstance(x, ast.Call):
            cname = dotted(x.func) or ""
            if isinstance(x.func, ast.Attribute):
                base = dotted(x.func.value)
                if base:
                    out.append({"path": base, "under": under, "s": sp(x.func.value)})
                else:
                    visit(x.func.value, under)
            for a in x.args:
                visit(a, under + [cname])
            for k in x.keywords:
                visit(k.value, under + [cname])
            return
        if isinstance(x, (ast.Name, ast.Attribute)):
            p = dotted(x)
            if p:
                out.append({"path": p, "under": under, "s": sp(x)})
                return
        for c in ast.iter_child_nodes(x):
            visit(c, under)
    visit(n, [])
    return out

class Collector(ast.NodeVisitor):
    def __init__(self, src):
        self.src = src
        self.scope = []
        self.assignments = []
        self.calls = []
        self.compares = []
        self.functions = []
        self.records = []
        self.imports = []
        self.scope_refs = {}

    def qual(self):
        return ".".join(name for _, name in self.scope) if self.scope else "<module>"

    def cls(self):
        for kind, name in reversed(self.scope):
            if kind == "class":
                return name
        return None

    def seg(self, n, limit=600):
        try:
            text = ast.get_source_segment(self.src, n) or ""
        except Exception:
            text = ""
        return text[:limit]

    def note_ref(self, path):
        bucket = self.scope_refs.setdefault(self.qual(), set())
        bucket.add(path)
        bucket.add(path.split(".")[0])

    def dict_items(self, prefix, node, depth=0):
        if depth > 3:
            return
        for k, v in zip(node.keys, node.values):
            if isinstance(k, ast.Constant) and isinstance(k.value, str):
                path = prefix + "." + k.value
                self.assignments.append({"target": path, "scope": self.qual(), "cls": self.cls(), "value": vexpr(v), "refs": refs(v), "s": sp(v), "text": self.seg(v, 200)})
                if isinstance(v, ast.Dict):
                    self.dict_items(path, v, depth + 1)

    def assign(self, target, value, node):
        path = dotted(target)
        if not path:
            return
        self.assignments.append({"target": path, "scope": self.qual(), "cls": self.cls(), "value": vexpr(value), "refs": refs(value), "s": sp(node), "text": self.seg(node, 300)})
        if isinstance(value, ast.Dict):
            self.dict_items(path, value)

    def visit_Assign(self, n):
        for t in n.targets:
            self.assign(t, n.value, n)
        self.visit(n.value)

    def visit_AnnAssign(self, n):
        if n.value is not None:
            self.assign(n.target, n.value, n)
            self.visit(n.value)

    def visit_ClassDef(self, n):
        fields = []
        for b in n.body:
            if isinstance(b, ast.AnnAssign) and isinstance(b.target, ast.Name):
                fields.append({"name": b.target.id, "ann": self.seg(b.annotation, 120)})
            elif isinstance(b, ast.Assign):
                for t in b.targets:
                    if isinstance(t, ast.Name):
                        fields.append({"name": t.id, "ann": ""})
        self.records.append({"name": n.name, "fields": fields, "s": sp(n)})
        for dd in n.decorator_list:
            self.visit(dd)
        self.scope.append(("class", n.name))
        for b in n.body:
            self.visit(b)
        self.scope.pop()

    def visit_function(self, n):
        a = n.args
        params = []
        for arg in list(getattr(a, "posonlyargs", [])) + list(a.args) + list(a.kwonlyargs):
            params.append({"name": arg.arg, "ann": self.seg(arg.annotation, 120) if arg.annotation is not None else ""})
        if a.vararg is not None:
            params.append({"name": a.vararg.arg, "ann": ""})
        if a.kwarg is not None:
            params.append({"name": a.kwarg.arg, "ann": ""})
        start = n.decorator_list[0].lineno if n.decorator_list else n.lineno
        qual = ".".join([name for _, name in self.scope] + [n.name])
        span = sp(n)
        span[0] = start
        self.functions.append({
            "name": n.name,
            "qual": qual,
            "cls": self.cls(),
            "params": params,
            "decorators": [self.seg(dd, 160) for dd in n.decorator_list],
            "s": span,
            "top": not self.scope,
        })
        for dd in n.decorator_list:
            self.visit(dd)
        self.scope.append(("function", n.name))
        for b in n.body:
            self.visit(b)
        self.scope.pop()

    visit_FunctionDef = visit_function
    visit_AsyncFunctionDef = visit_function

    def visit_Call(self, n):
        callee = dotted(n.func) or self.seg(n.func, 80)
        args = []
        for a in n.args:
            args.append({"kw": None, "value": vexpr(a), "refs": refs(a), "text": self.seg(a, 300), "s": sp(a)})
            if isinstance(a, ast.Dict):
                self.dict_items(callee + "()", a)
        for k in n.keywords:
            args.append({"kw": k.arg, "value": vexpr(k.value), "refs": refs(k.value), "text": self.seg(k.value, 300), "s": sp(k.value)})
            if isinstance(k.value, ast.Dict) and k.arg:
                self.dict_items(callee + "()." + k.arg, k.value)
        self.calls.append({"callee": callee, "scope": self.qual(), "cls": self.cls(), "s": sp(n), "fs": sp(n.func), "args": args, "text": self.seg(n, 400)})
        self.generic_visit(n)

    def visit_Compare(self, n):
        if len(n.ops) == 1 and type(n.ops[0]) in CMPOPS:
            self.compares.append({
                "scope": self.qual(),
                "cls": self.cls(),
                "op": CMPOPS[type(n.ops[0])],
                "left": vexpr(n.left),
                "lrefs": refs(n.left),
                "right": vexpr(n.comparators[0]),
                "rrefs": refs(n.comparators[0]),
                "s": sp(n),
                "text": self.seg(n, 200),
            })
        self.generic_visit(n)

    def visit_Name(self, n):
        self.note_ref(n.id)

    def visit_Attribute(self, n):
        path = dotted(n)
        if path:
            self.note_ref(path)
        else:
            self.generic_visit(n)

    def visit_Import(self, n):
        if not self.scope:
            self.imports.append({"module": ",".join(a.name for a in n.names), "names": [a.asname or a.name for a in n.names], "s": sp(n)})

    def visit_ImportFrom(self, n):
        if not self.scope:
            self.imports.append({"module": n.module or "", "names": [a.asname or a.name for a in n.names], "s": sp(n)})

def analyze(src):
    try:
        tree = ast.parse(src)
    except SyntaxError as e:
        return {"error": "SyntaxError: %s (line %s)" % (e.msg, e.lineno)}
    c = Collector(src)
    c.visit(tree)
    return {
        "error": None,
        "node_count": sum(1 for _ in ast.walk(tree)),
        "assignments": c.assignments,
        "calls": c.calls,
        "compares": c.compares,
        "functions": c.functions,
        "records": c.records,
        "imports": c.imports,
        "scope_refs": {k: sorted(v) for k, v in c.scope_refs.items()},
    }

payload = json.loads(sys.stdin.read())
result = {}
for item in payload.get("files", []):
    try:
        result[item["key"]] = analyze(item["source"])
    except Exception as e:
        result[item["key"]] = {"error": "%s: %s" % (type(e).__name__, e)}
sys.stdout.write(json.dumps(result))
`;

type RawSpan = [number, number, number, number];

interface RawValue {
  k: string;
  v?: number | string | boolean;
  path?: string;
  op?: '+' | '-' | '*' | '/' | '//';
  l?: RawValue;
  r?: RawValue;
  callee?: string;
  args?: RawValue[];
  kw?: Record<string, RawValue>;
  s?: RawSpan;
}

interface RawRef {
  path: string;
  under: string[];
  s: RawSpan;
}

interface RawPythonIr {
  error: string | null;
  node_count?: number;
  assignments?: Array<{
    target: string;
    scope: string;
    cls: string | null;
    value: RawValue;
    refs: RawRef[];
    s: RawSpan;
    text: string;
  }>;
  calls?: Array<{
    callee: string;
    scope: string;
    cls: string | null;
    s: RawSpan;
    fs: RawSpan;
    args: Array<{ kw: string | null; value: RawValue; refs: RawRef[]; text: string; s: RawSpan }>;
    text: string;
  }>;
  compares?: Array<{
    scope: string;
    cls: string | null;
    op: '<' | '<=' | '>' | '>=' | '==' | '!=';
    left: RawValue;
    lrefs: RawRef[];
    right: RawValue;
    rrefs: RawRef[];
    s: RawSpan;
    text: string;
  }>;
  functions?: Array<{
    name: string;
    qual: string;
    cls: string | null;
    params: Array<{ name: string; ann: string }>;
    decorators: string[];
    s: RawSpan;
    top: boolean;
  }>;
  records?: Array<{ name: string; fields: Array<{ name: string; ann: string }>; s: RawSpan }>;
  imports?: Array<{ module: string; names: string[]; s: RawSpan }>;
  scope_refs?: Record<string, string[]>;
}

const MAX_CACHE_ENTRIES = 512;
const rawIrCache = new Map<string, RawPythonIr>();

function cacheGet(key: string): RawPythonIr | undefined {
  const hit = rawIrCache.get(key);
  if (hit) {
    rawIrCache.delete(key);
    rawIrCache.set(key, hit);
  }
  return hit;
}

function cacheSet(key: string, value: RawPythonIr): void {
  rawIrCache.set(key, value);
  while (rawIrCache.size > MAX_CACHE_ENTRIES) {
    const oldest = rawIrCache.keys().next().value;
    if (oldest === undefined) break;
    rawIrCache.delete(oldest);
  }
}

let subprocessParseCount = 0;

/** Number of `python3` subprocesses spawned for AST parsing since process start. */
export function getPythonParseSubprocessCount(): number {
  return subprocessParseCount;
}

function pendingSources(sources: string[]): Array<{ key: string; source: string }> {
  const pending = new Map<string, string>();
  for (const source of sources) {
    const key = sha256Hex(source);
    if (!rawIrCache.has(key) && !pending.has(key)) pending.set(key, source);
  }
  return [...pending.entries()].map(([key, source]) => ({ key, source }));
}

function storeBatch(batch: Array<{ key: string }>, stdout: string | null, failure: string | null): void {
  let parsed: Record<string, RawPythonIr> = {};
  if (stdout) {
    try {
      parsed = JSON.parse(stdout) as Record<string, RawPythonIr>;
    } catch (err) {
      failure = `Invalid python3 AST output: ${String(err)}`;
    }
  }
  for (const { key } of batch) {
    cacheSet(key, parsed[key] ?? { error: failure ?? 'python3 AST parser returned no result' });
  }
}

/** Parses every uncached source in one blocking `python3` call. */
export function parsePythonSourcesSync(sources: string[]): void {
  const batch = pendingSources(sources);
  if (batch.length === 0) return;
  subprocessParseCount++;
  try {
    const stdout = execFileSync('python3', ['-c', PYTHON_IR_SCRIPT], {
      input: JSON.stringify({ files: batch }),
      encoding: 'utf8',
      timeout: 8000,
      maxBuffer: 64 * 1024 * 1024,
    });
    storeBatch(batch, stdout, null);
  } catch (err) {
    storeBatch(batch, null, `python3 unavailable: ${String(err).slice(0, 160)}`);
  }
}

/** Parses every uncached source in one non-blocking `python3` call. */
export async function parsePythonSourcesAsync(sources: string[]): Promise<void> {
  const batch = pendingSources(sources);
  if (batch.length === 0) return;
  subprocessParseCount++;
  try {
    const child = execFileAsync('python3', ['-c', PYTHON_IR_SCRIPT], {
      encoding: 'utf8',
      timeout: 8000,
      maxBuffer: 64 * 1024 * 1024,
    });
    child.child.stdin?.end(JSON.stringify({ files: batch }));
    const { stdout } = await child;
    storeBatch(batch, stdout, null);
  } catch (err) {
    storeBatch(batch, null, `python3 unavailable: ${String(err).slice(0, 160)}`);
  }
}

/** Converts a UTF-8 byte offset reported by CPython into a UTF-16 column. */
function byteColToUtf16(lineText: string, byteCol: number): number {
  // ASCII-only line: UTF-8 byte offsets and UTF-16 offsets coincide.
  if (Buffer.byteLength(lineText, 'utf8') === lineText.length) return byteCol;
  let bytes = 0;
  let idx = 0;
  for (const ch of lineText) {
    if (bytes >= byteCol) break;
    bytes += Buffer.byteLength(ch, 'utf8');
    idx += ch.length;
  }
  return idx;
}

export function buildPythonIr(content: string): ProgramIr {
  const key = sha256Hex(content);
  let raw = cacheGet(key);
  if (!raw) {
    parsePythonSourcesSync([content]);
    raw = cacheGet(key);
  }
  if (!raw || raw.error) return emptyIr('python', raw?.error ?? 'python3 AST parse failed');

  const lines = content.split('\n');
  const span = (s: RawSpan | undefined): Span => {
    if (!s) return { line: 1, endLine: 1, col: 0, endCol: 0 };
    const [line, endLine, col, endCol] = s;
    return {
      line,
      endLine,
      col: byteColToUtf16(lines[line - 1] ?? '', col),
      endCol: byteColToUtf16(lines[endLine - 1] ?? '', endCol),
    };
  };
  const value = (v: RawValue | undefined): ValueExpr => {
    if (!v) return { k: 'unknown' };
    switch (v.k) {
      case 'num':
        return { k: 'num', v: Number(v.v), span: span(v.s) };
      case 'str':
        return { k: 'str', v: String(v.v), span: span(v.s) };
      case 'bool':
        return { k: 'bool', v: Boolean(v.v), span: span(v.s) };
      case 'ref':
        return { k: 'ref', path: v.path ?? '', span: span(v.s) };
      case 'bin':
        return { k: 'bin', op: v.op ?? '+', l: value(v.l), r: value(v.r), span: span(v.s) };
      case 'call':
        return {
          k: 'call',
          callee: v.callee ?? '',
          args: (v.args ?? []).map(value),
          kw: Object.fromEntries(Object.entries(v.kw ?? {}).map(([k, x]) => [k, value(x)])),
          span: span(v.s),
        };
      default:
        return { k: 'unknown', span: v.s ? span(v.s) : undefined };
    }
  };
  const refList = (rs: RawRef[] | undefined): IrRef[] =>
    (rs ?? []).map((r) => ({ path: r.path, under: r.under, span: span(r.s) }));

  const calls: IrCall[] = (raw.calls ?? []).map((c) => ({
    callee: c.callee,
    scope: c.scope,
    cls: c.cls,
    span: span(c.s),
    calleeSpan: span(c.fs),
    text: c.text,
    args: c.args.map(
      (a): IrCallArg => ({
        keyword: a.kw,
        value: value(a.value),
        refs: refList(a.refs),
        text: a.text,
        span: span(a.s),
      })
    ),
  }));

  return {
    language: 'python',
    nodeCount: raw.node_count ?? 0,
    assignments: (raw.assignments ?? []).map((a) => ({
      target: a.target,
      scope: a.scope,
      cls: a.cls,
      value: value(a.value),
      refs: refList(a.refs),
      span: span(a.s),
      text: a.text,
    })),
    calls,
    compares: (raw.compares ?? []).map((c) => ({
      scope: c.scope,
      cls: c.cls,
      op: c.op,
      left: value(c.left),
      leftRefs: refList(c.lrefs),
      right: value(c.right),
      rightRefs: refList(c.rrefs),
      span: span(c.s),
      text: c.text,
    })),
    functions: (raw.functions ?? []).map((f) => {
      const fnSpan = span(f.s);
      let insertionLine = fnSpan.line;
      while (insertionLine > 1 && /^\s*#/.test(lines[insertionLine - 2] ?? '')) insertionLine--;
      return {
        name: f.name,
        qualname: f.qual,
        cls: f.cls,
        params: f.params.map((p) => ({ name: p.name, annotation: p.ann })),
        decorators: f.decorators,
        span: fnSpan,
        insertionLine,
        topLevel: f.top,
      };
    }),
    recordTypes: (raw.records ?? []).map((r) => ({
      name: r.name,
      fields: r.fields.map((x) => ({ name: x.name, annotation: x.ann })),
      span: span(r.s),
    })),
    imports: (raw.imports ?? []).map((i) => ({ module: i.module, names: i.names, span: span(i.s) })),
    scopeRefs: raw.scope_refs ?? { [MODULE_SCOPE]: [] },
    parseError: null,
  };
}
