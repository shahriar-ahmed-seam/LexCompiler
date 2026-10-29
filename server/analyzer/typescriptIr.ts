import ts from 'typescript';
import {
  MODULE_SCOPE,
  type CompareOp,
  type IrAssignment,
  type IrCallArg,
  type IrFunction,
  type IrRef,
  type ProgramIr,
  type Span,
  type ValueExpr,
} from './programIr.js';

const COMPARE_OPS: Partial<Record<ts.SyntaxKind, CompareOp>> = {
  [ts.SyntaxKind.LessThanToken]: '<',
  [ts.SyntaxKind.LessThanEqualsToken]: '<=',
  [ts.SyntaxKind.GreaterThanToken]: '>',
  [ts.SyntaxKind.GreaterThanEqualsToken]: '>=',
  [ts.SyntaxKind.EqualsEqualsEqualsToken]: '==',
  [ts.SyntaxKind.EqualsEqualsToken]: '==',
  [ts.SyntaxKind.ExclamationEqualsEqualsToken]: '!=',
  [ts.SyntaxKind.ExclamationEqualsToken]: '!=',
};

const ARITH_OPS: Partial<Record<ts.SyntaxKind, '+' | '-' | '*' | '/'>> = {
  [ts.SyntaxKind.PlusToken]: '+',
  [ts.SyntaxKind.MinusToken]: '-',
  [ts.SyntaxKind.AsteriskToken]: '*',
  [ts.SyntaxKind.SlashToken]: '/',
};

type FunctionLike =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

function isFunctionLike(node: ts.Node): node is FunctionLike {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

export function buildTypeScriptIr(filePath: string, content: string): ProgramIr {
  const sf = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.ES2022,
    true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

  const ir: ProgramIr = {
    language: 'typescript',
    nodeCount: 0,
    assignments: [],
    calls: [],
    compares: [],
    functions: [],
    recordTypes: [],
    imports: [],
    scopeRefs: {},
    parseError: null,
  };

  const diagnostics = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    const first = diagnostics[0];
    const pos = first.start !== undefined ? sf.getLineAndCharacterOfPosition(first.start).line + 1 : 0;
    ir.parseError = `TypeScript syntax error: ${ts.flattenDiagnosticMessageText(first.messageText, ' ')} (line ${pos})`;
  }

  const scopeStack: Array<{ kind: 'function' | 'class'; name: string }> = [];
  const qual = () => (scopeStack.length ? scopeStack.map((s) => s.name).join('.') : MODULE_SCOPE);
  const currentClass = () => {
    for (let i = scopeStack.length - 1; i >= 0; i--) {
      if (scopeStack[i].kind === 'class') return scopeStack[i].name;
    }
    return null;
  };

  const spanOf = (node: ts.Node): Span => {
    const s = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    const e = sf.getLineAndCharacterOfPosition(node.getEnd());
    return { line: s.line + 1, endLine: e.line + 1, col: s.character, endCol: e.character };
  };
  const textOf = (node: ts.Node, limit = 400) => node.getText(sf).slice(0, limit);

  const refPath = (node: ts.Node): string | null => {
    if (ts.isIdentifier(node)) return node.text;
    if (node.kind === ts.SyntaxKind.ThisKeyword) return 'this';
    if (ts.isPropertyAccessExpression(node)) {
      const base = refPath(node.expression);
      return base ? `${base}.${node.name.text}` : null;
    }
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
      const base = refPath(node.expression);
      return base ? `${base}.${node.argumentExpression.text}` : null;
    }
    if (ts.isNonNullExpression(node) || ts.isParenthesizedExpression(node)) return refPath(node.expression);
    return null;
  };

  const valueOf = (node: ts.Expression, depth = 0): ValueExpr => {
    if (depth > 10) return { k: 'unknown' };
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node)
    ) {
      return valueOf(node.expression, depth + 1);
    }
    const span = spanOf(node);
    if (ts.isNumericLiteral(node)) return { k: 'num', v: Number(node.text.replace(/_/g, '')), span };
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { k: 'str', v: node.text, span };
    if (node.kind === ts.SyntaxKind.TrueKeyword) return { k: 'bool', v: true, span };
    if (node.kind === ts.SyntaxKind.FalseKeyword) return { k: 'bool', v: false, span };
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
      const inner = valueOf(node.operand, depth + 1);
      return inner.k === 'num' ? { k: 'num', v: -inner.v, span } : { k: 'unknown', span };
    }
    const path = refPath(node);
    if (path) return { k: 'ref', path, span };
    if (ts.isBinaryExpression(node)) {
      const op = ARITH_OPS[node.operatorToken.kind];
      if (op) return { k: 'bin', op, l: valueOf(node.left, depth + 1), r: valueOf(node.right, depth + 1), span };
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const args = node.arguments ?? ts.factory.createNodeArray<ts.Expression>();
      const kw: Record<string, ValueExpr> = {};
      for (const a of args) {
        if (!ts.isObjectLiteralExpression(a)) continue;
        for (const prop of a.properties) {
          if (ts.isPropertyAssignment(prop) && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) {
            kw[prop.name.text] = valueOf(prop.initializer, depth + 1);
          }
        }
      }
      return {
        k: 'call',
        callee: refPath(node.expression) ?? textOf(node.expression, 80),
        args: args.slice(0, 6).map((a) => valueOf(a, depth + 1)),
        kw,
        span,
      };
    }
    return { k: 'unknown', span };
  };

  const refsOf = (root: ts.Node): IrRef[] => {
    const out: IrRef[] = [];
    const visit = (n: ts.Node, under: string[]) => {
      if (isFunctionLike(n) || ts.isTypeNode(n)) return;
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
        const callee = refPath(n.expression) ?? '';
        if (ts.isPropertyAccessExpression(n.expression)) {
          const base = refPath(n.expression.expression);
          if (base) out.push({ path: base, under, span: spanOf(n.expression.expression) });
          else visit(n.expression.expression, under);
        }
        for (const a of n.arguments ?? []) visit(a, [...under, callee]);
        return;
      }
      if (ts.isPropertyAssignment(n)) {
        visit(n.initializer, under);
        return;
      }
      if (ts.isShorthandPropertyAssignment(n)) {
        out.push({ path: n.name.text, under, span: spanOf(n.name) });
        return;
      }
      if (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
        const path = refPath(n);
        if (path) {
          out.push({ path, under, span: spanOf(n) });
          return;
        }
      }
      ts.forEachChild(n, (c) => visit(c, under));
    };
    visit(root, []);
    return out;
  };

  const noteRef = (path: string) => {
    const key = qual();
    const bucket = ir.scopeRefs[key] ?? [];
    if (!bucket.includes(path)) bucket.push(path);
    const root = path.split('.')[0];
    if (!bucket.includes(root)) bucket.push(root);
    ir.scopeRefs[key] = bucket;
  };

  const pushAssignment = (target: string, valueNode: ts.Expression, statement: ts.Node) => {
    const assignment: IrAssignment = {
      target,
      scope: qual(),
      cls: currentClass(),
      value: valueOf(valueNode),
      refs: refsOf(valueNode),
      span: spanOf(statement),
      text: textOf(statement, 300),
    };
    ir.assignments.push(assignment);
    if (ts.isObjectLiteralExpression(skipWrappers(valueNode))) {
      pushObjectProperties(target, skipWrappers(valueNode) as ts.ObjectLiteralExpression, 0);
    }
  };

  const pushObjectProperties = (prefix: string, obj: ts.ObjectLiteralExpression, depth: number) => {
    if (depth > 3) return;
    for (const prop of obj.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const name = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null;
      if (!name) continue;
      const path = `${prefix}.${name}`;
      ir.assignments.push({
        target: path,
        scope: qual(),
        cls: currentClass(),
        value: valueOf(prop.initializer),
        refs: refsOf(prop.initializer),
        span: spanOf(prop.initializer),
        text: textOf(prop, 200),
      });
      const inner = skipWrappers(prop.initializer);
      if (ts.isObjectLiteralExpression(inner)) pushObjectProperties(path, inner, depth + 1);
    }
  };

  const functionName = (node: FunctionLike): { name: string; routeLabel: string | null } => {
    if (ts.isConstructorDeclaration(node)) return { name: 'constructor', routeLabel: null };
    if (node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) {
      return { name: node.name.text, routeLabel: null };
    }
    const parent = node.parent;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return { name: parent.name.text, routeLabel: null };
    if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return { name: parent.name.text, routeLabel: null };
    if (ts.isCallExpression(parent)) {
      const callee = refPath(parent.expression) ?? 'callback';
      const firstArg = parent.arguments[0];
      const route = firstArg && ts.isStringLiteralLike(firstArg) ? firstArg.text : '';
      const label = route ? `${callee}("${route}")` : callee;
      return { name: label.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'callback', routeLabel: label };
    }
    return { name: 'anonymous', routeLabel: null };
  };

  const recordFunction = (node: FunctionLike) => {
    const { name, routeLabel } = functionName(node);
    const decorators = (ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : []).map((d) =>
      textOf(d, 160).replace(/^@/, '')
    );
    if (routeLabel) decorators.push(routeLabel);
    const span = spanOf(node);
    const statement = ts.isVariableDeclaration(node.parent) ? node.parent.parent?.parent : node;
    const anchorNode = statement && ts.isVariableStatement(statement) ? statement : node;
    let insertionLine = spanOf(anchorNode).line;
    const leadingComments = ts.getLeadingCommentRanges(content, anchorNode.getFullStart()) ?? [];
    for (let i = leadingComments.length - 1; i >= 0; i--) {
      const commentEndLine = sf.getLineAndCharacterOfPosition(leadingComments[i].end).line + 1;
      if (commentEndLine < insertionLine - 1) break;
      insertionLine = sf.getLineAndCharacterOfPosition(leadingComments[i].pos).line + 1;
    }
    const fn: IrFunction = {
      name,
      qualname: [...scopeStack.map((s) => s.name), name].join('.'),
      cls: currentClass(),
      params: node.parameters.map((p) => ({ name: p.name.getText(sf), annotation: p.type ? textOf(p.type, 120) : '' })),
      decorators,
      span,
      insertionLine,
      topLevel: scopeStack.length === 0,
    };
    ir.functions.push(fn);
    return fn;
  };

  const visit = (node: ts.Node) => {
    ir.nodeCount++;

    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const names: string[] = [];
      const clause = node.importClause;
      if (clause?.name) names.push(clause.name.text);
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) names.push(el.name.text);
      }
      ir.imports.push({ module: node.moduleSpecifier.text, names, span: spanOf(node) });
      return;
    }

    if (isFunctionLike(node)) {
      const fn = recordFunction(node);
      scopeStack.push({ kind: 'function', name: fn.name });
      ts.forEachChild(node, visit);
      scopeStack.pop();
      return;
    }

    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const name = node.name?.text ?? 'AnonymousClass';
      ir.recordTypes.push({
        name,
        fields: node.members
          .filter((m): m is ts.PropertyDeclaration => ts.isPropertyDeclaration(m))
          .map((m) => ({ name: m.name.getText(sf), annotation: m.type ? textOf(m.type, 120) : '' })),
        span: spanOf(node),
      });
      scopeStack.push({ kind: 'class', name });
      ts.forEachChild(node, visit);
      scopeStack.pop();
      return;
    }

    if (ts.isInterfaceDeclaration(node)) {
      ir.recordTypes.push({
        name: node.name.text,
        fields: node.members
          .filter((m): m is ts.PropertySignature => ts.isPropertySignature(m))
          .map((m) => ({ name: m.name.getText(sf), annotation: m.type ? textOf(m.type, 120) : '' })),
        span: spanOf(node),
      });
      return;
    }

    if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) {
      ir.recordTypes.push({
        name: node.name.text,
        fields: node.type.members
          .filter((m): m is ts.PropertySignature => ts.isPropertySignature(m))
          .map((m) => ({ name: m.name.getText(sf), annotation: m.type ? textOf(m.type, 120) : '' })),
        span: spanOf(node),
      });
      return;
    }

    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      if (!isFunctionLike(skipWrappers(node.initializer))) {
        pushAssignment(node.name.text, node.initializer, node);
      }
    } else if (ts.isPropertyDeclaration(node) && node.initializer && currentClass()) {
      pushAssignment(`this.${node.name.getText(sf)}`, node.initializer, node);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      !isFunctionLike(skipWrappers(node.right))
    ) {
      const target = refPath(node.left);
      if (target) pushAssignment(target, node.right, node);
    }

    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = refPath(node.expression) ?? textOf(node.expression, 80);
      const args: IrCallArg[] = [];
      for (const a of node.arguments ?? []) {
        args.push({ keyword: null, value: valueOf(a), refs: refsOf(a), text: textOf(a, 300), span: spanOf(a) });
        const inner = skipWrappers(a);
        if (ts.isObjectLiteralExpression(inner)) {
          pushObjectProperties(`${callee}()`, inner, 0);
          for (const prop of inner.properties) {
            if (ts.isPropertyAssignment(prop) && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) {
              args.push({
                keyword: prop.name.text,
                value: valueOf(prop.initializer),
                refs: refsOf(prop.initializer),
                text: textOf(prop.initializer, 300),
                span: spanOf(prop.initializer),
              });
            }
          }
        }
      }
      ir.calls.push({
        callee,
        scope: qual(),
        cls: currentClass(),
        span: spanOf(node),
        calleeSpan: spanOf(node.expression),
        args,
        text: textOf(node, 400),
      });
    }

    if (ts.isBinaryExpression(node)) {
      const op = COMPARE_OPS[node.operatorToken.kind];
      if (op) {
        ir.compares.push({
          scope: qual(),
          cls: currentClass(),
          op,
          left: valueOf(node.left),
          leftRefs: refsOf(node.left),
          right: valueOf(node.right),
          rightRefs: refsOf(node.right),
          span: spanOf(node),
          text: textOf(node, 200),
        });
      }
    }

    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
      const path = refPath(node);
      if (path) {
        noteRef(path);
        if (ts.isPropertyAccessExpression(node)) return;
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);
  if (!ir.scopeRefs[MODULE_SCOPE]) ir.scopeRefs[MODULE_SCOPE] = [];
  return ir;
}

function skipWrappers(node: ts.Expression): ts.Expression {
  let cur = node;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isSatisfiesExpression(cur) ||
    ts.isTypeAssertionExpression(cur) ||
    ts.isNonNullExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}
