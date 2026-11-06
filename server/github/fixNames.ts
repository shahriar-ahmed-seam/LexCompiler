import type { TargetRepoFile } from '../../shared/types.js';

/**
 * Names a model-written fix calls that nothing defines. A fix can parse, satisfy Z3 and pass the
 * rescan while calling a helper that doesn't exist (in the live run, `encrypt_with_tenant_kms`);
 * this catches that kind. Only plain calls (`name(`) in the replacement lines are checked, not
 * method calls (`x.name(`), whose targets can't be resolved from source text. A name counts as
 * defined when any repository file defines or imports it, or it is a language builtin. SQL is
 * skipped: its functions belong to the database.
 */

const PY_BUILTINS = new Set(
  ('abs all any ascii bin bool breakpoint bytearray bytes callable chr classmethod compile complex delattr dict dir divmod ' +
    'enumerate eval exec filter float format frozenset getattr globals hasattr hash help hex id input int isinstance issubclass ' +
    'iter len list locals map max memoryview min next object oct open ord pow print property range repr reversed round set ' +
    'setattr slice sorted staticmethod str sum super tuple type vars zip __import__ ' +
    'Exception BaseException ValueError TypeError KeyError IndexError RuntimeError AttributeError NotImplementedError ' +
    'PermissionError AssertionError LookupError OSError IOError StopIteration ZeroDivisionError ImportError TimeoutError ' +
    'if elif while for with return not and or in is lambda yield assert del raise except print').split(' ')
);
const JS_BUILTINS = new Set(
  ('Array Boolean Date Error TypeError RangeError SyntaxError Map Set WeakMap WeakSet Number Object Promise Proxy Reflect ' +
    'RegExp String Symbol BigInt URL URLSearchParams Uint8Array Int32Array Float64Array ArrayBuffer DataView TextEncoder ' +
    'TextDecoder AbortController Headers Request Response FormData Blob Buffer ' +
    'parseInt parseFloat isNaN isFinite encodeURIComponent decodeURIComponent encodeURI decodeURI escape unescape ' +
    'setTimeout clearTimeout setInterval clearInterval setImmediate queueMicrotask structuredClone fetch require atob btoa ' +
    'if for while switch catch return typeof instanceof await function async super import void delete new in of yield').split(' ')
);

const isPython = (path: string) => path.endsWith('.py');
const isJs = (path: string) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path);

/** Every name a source file defines or imports. */
export function definedNames(file: TargetRepoFile): Set<string> {
  const out = new Set<string>();
  const add = (s: string | undefined) => {
    for (const part of (s ?? '').split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim().replace(/[()]/g, '');
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) out.add(name);
    }
  };
  const text = file.content;
  if (isPython(file.path)) {
    for (const m of text.matchAll(/^\s*(?:async\s+)?(?:def|class)\s+(\w+)/gm)) add(m[1]);
    for (const m of text.matchAll(/^\s*(\w+)\s*(?::[^=\n]+)?=(?!=)/gm)) add(m[1]);
    for (const m of text.matchAll(/^\s*from\s+[\w.]+\s+import\s+\(?([^)\n]+)\)?/gm)) add(m[1]);
    for (const m of text.matchAll(/^\s*import\s+([\w.,\s]+?)$/gm)) for (const mod of m[1].split(',')) add(mod.trim().split(/\s+as\s+/).pop()?.split('.')[0]);
  } else if (isJs(file.path)) {
    for (const m of text.matchAll(/\b(?:function\*?|class)\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
    for (const m of text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
    for (const m of text.matchAll(/\b(?:const|let|var)\s+\{([^}]*)\}/g)) add(m[1].replace(/:\s*/g, ' as '));
    for (const m of text.matchAll(/import\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s*(?:,|\s+from)/g)) add(m[1]);
    for (const m of text.matchAll(/import\s+(?:type\s+)?(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}/g)) add(m[1].replace(/\btype\s+/g, ''));
    for (const m of text.matchAll(/import\s+\*\s+as\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  }
  return out;
}

/** Plain calls in `lines` (not `obj.name(`), for a Python or JS/TS file. */
function calledNames(path: string, lines: string[]): Set<string> {
  const out = new Set<string>();
  for (const line of lines) {
    const code = isPython(path) ? line.replace(/#.*$/, '') : line.replace(/\/\/.*$/, '');
    const noStrings = code.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""');
    for (const m of noStrings.matchAll(/(^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) out.add(m[2]);
  }
  return out;
}

/**
 * The plain calls in a fix's replacement lines that no repository file defines or imports
 * (and that aren't builtins). `patched` is the file after the fix; `files` the repository before it.
 */
export function undefinedCalls(patched: TargetRepoFile, replacementLines: string[], files: TargetRepoFile[]): string[] {
  if (!isPython(patched.path) && !isJs(patched.path)) return [];
  const builtins = isPython(patched.path) ? PY_BUILTINS : JS_BUILTINS;
  const defined = new Set<string>();
  for (const f of [patched, ...files.filter((x) => x.path !== patched.path)]) for (const n of definedNames(f)) defined.add(n);
  return [...calledNames(patched.path, replacementLines)].filter((n) => !builtins.has(n) && !defined.has(n)).sort();
}
