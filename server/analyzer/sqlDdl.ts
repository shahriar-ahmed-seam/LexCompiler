import type {
  ASTFindingNode,
  SourceEditAnchor,
  SQLColumnNode,
  SQLTableSchema,
  TargetRepoFile,
} from '../../shared/types.js';
import {
  classifyPiiName,
  lineStartOffsets,
  normalizeIdentifier,
  offsetToLineCol,
  sliceLines,
  unitHoursFromName,
} from './programIr.js';

interface SqlComment {
  start: number;
  end: number;
  text: string;
}

interface ParsedColumn {
  node: SQLColumnNode;
  itemStart: number;
  itemEnd: number;
  itemEndPosition: { line: number; col: number };
  comment: SqlComment | null;
  defaultNumber: { value: number; start: number; end: number } | null;
  references: {
    table: string;
    column: string;
    clauseEnd: number;
    onDeleteAction: { text: string; start: number; end: number } | null;
  } | null;
  encryptedAnnotation: { algorithm: string; start: number; end: number } | null;
  retentionAnnotation: { value: number; hoursPerUnit: number; start: number; end: number } | null;
}

export interface ParsedSqlTable {
  schema: SQLTableSchema;
  finding: ASTFindingNode;
  columns: ParsedColumn[];
}

const SURROGATE_KEY_TYPES = /^(uuid|int|integer|bigint|smallint|serial|bigserial|smallserial|int4|int8)\b/i;
const CONSTRAINT_ITEM = /^(constraint|primary\s+key|foreign\s+key|unique|check|exclude|key|index|like)\b/i;
const COLUMN_CONSTRAINT_KEYWORD =
  /\b(not\s+null|null|primary\s+key|references|default|unique|check|constraint|generated|collate|encrypted\s+with)\b/i;

/** Blanks comments and string contents (keeping offsets and newlines) so structure can be scanned safely. */
function maskSql(content: string): { masked: string; comments: SqlComment[] } {
  const chars = content.split('');
  const comments: SqlComment[] = [];
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (chars[k] !== '\n') chars[k] = ' ';
  };
  let i = 0;
  while (i < content.length) {
    const c = content[i];
    const d = content[i + 1];
    if (c === '-' && d === '-') {
      const nl = content.indexOf('\n', i);
      const end = nl === -1 ? content.length : nl;
      comments.push({ start: i, end, text: content.slice(i, end) });
      blank(i, end);
      i = end;
    } else if (c === '/' && d === '*') {
      const close = content.indexOf('*/', i + 2);
      const end = close === -1 ? content.length : close + 2;
      comments.push({ start: i, end, text: content.slice(i, end) });
      blank(i, end);
      i = end;
    } else if (c === "'") {
      let j = i + 1;
      while (j < content.length) {
        if (content[j] === "'") {
          if (content[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
    } else if (c === '"') {
      const close = content.indexOf('"', i + 1);
      i = close === -1 ? content.length : close + 1;
    } else {
      i++;
    }
  }
  return { masked: chars.join(''), comments };
}

function unquote(identifier: string): string {
  const last = identifier.split('.').pop() ?? identifier;
  return last.trim().replace(/^"|"$/g, '');
}

function splitTopLevel(masked: string, from: number, to: number): Array<{ start: number; end: number }> {
  const items: Array<{ start: number; end: number }> = [];
  let depth = 0;
  let segStart = from;
  for (let i = from; i < to; i++) {
    const ch = masked[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      items.push({ start: segStart, end: i });
      segStart = i + 1;
    }
  }
  items.push({ start: segStart, end: to });
  return items
    .map(({ start, end }) => {
      let s = start;
      let e = end;
      while (s < e && /\s/.test(masked[s])) s++;
      while (e > s && /\s/.test(masked[e - 1])) e--;
      return { start: s, end: e };
    })
    .filter(({ start, end }) => end > start);
}

function annotationRetention(comment: SqlComment | null): ParsedColumn['retentionAnnotation'] {
  if (!comment) return null;
  const m = /@retention_(hours|days|minutes|seconds|weeks)\(\s*(\d+(?:\.\d+)?)\s*\)/i.exec(comment.text);
  if (!m) return null;
  const valueStart = comment.start + m.index + m[0].indexOf(m[2], m[1].length);
  return {
    value: Number(m[2]),
    hoursPerUnit: unitHoursFromName(m[1]) ?? 1,
    start: valueStart,
    end: valueStart + m[2].length,
  };
}

function parseColumn(
  content: string,
  masked: string,
  item: { start: number; end: number },
  comment: SqlComment | null,
  starts: number[]
): ParsedColumn | null {
  const text = masked.slice(item.start, item.end);
  const nameMatch = /^("(?:[^"]+)"|[A-Za-z_][\w$]*)/.exec(text);
  if (!nameMatch) return null;
  const name = unquote(nameMatch[1]);
  const rest = text.slice(nameMatch[0].length);
  const constraintIdx = rest.search(COLUMN_CONSTRAINT_KEYWORD);
  const typeText = (constraintIdx >= 0 ? rest.slice(0, constraintIdx) : rest).trim();
  const dataType = typeText.split(/\s+/)[0] || 'UNKNOWN';
  const isPrimaryKey = /\bprimary\s+key\b/i.test(rest);
  const isNullable = !/\bnot\s+null\b/i.test(rest) && !isPrimaryKey;

  let references: ParsedColumn['references'] = null;
  const refMatch = /\breferences\s+("(?:[^"]+)"|[\w$.]+)\s*(?:\(\s*("?[\w$]+"?)\s*\))?/i.exec(rest);
  if (refMatch) {
    const clauseEnd = item.start + nameMatch[0].length + refMatch.index + refMatch[0].length;
    const tail = rest.slice(refMatch.index + refMatch[0].length);
    const onDelete = /\bon\s+delete\s+(cascade|restrict|no\s+action|set\s+null|set\s+default)\b/i.exec(tail);
    const actionStart = onDelete ? clauseEnd + onDelete.index + onDelete[0].length - onDelete[1].length : 0;
    references = {
      table: unquote(refMatch[1]),
      column: refMatch[2] ? unquote(refMatch[2]) : '',
      clauseEnd,
      onDeleteAction: onDelete ? { text: onDelete[1], start: actionStart, end: actionStart + onDelete[1].length } : null,
    };
  }

  let defaultNumber: ParsedColumn['defaultNumber'] = null;
  const defMatch = /\bdefault\s+\(?\s*(-?\d+(?:\.\d+)?)/i.exec(rest);
  if (defMatch) {
    const start = item.start + nameMatch[0].length + defMatch.index + defMatch[0].length - defMatch[1].length;
    defaultNumber = { value: Number(defMatch[1]), start, end: start + defMatch[1].length };
  }

  const commentText = comment?.text ?? '';
  const piiAnnotation = /@pii\(\s*([A-Za-z_]+)\s*\)/i.exec(commentText);
  const optOut = /@not_pii\b/i.test(commentText) || piiAnnotation?.[1].toUpperCase() === 'NONE';
  const isSurrogateKey =
    isPrimaryKey ||
    Boolean(references) ||
    (/(_id|_uuid)$/i.test(name) && SURROGATE_KEY_TYPES.test(typeText));
  const inferred = classifyPiiName(name);
  let piiInference: SQLColumnNode['piiInference'] = 'NONE';
  let piiClassification: SQLColumnNode['piiClassification'] = 'NONE';
  if (piiAnnotation && !optOut) {
    piiInference = 'ANNOTATION';
    piiClassification = piiAnnotation[1].toUpperCase() as SQLColumnNode['piiClassification'];
  } else if (!optOut && inferred && !isSurrogateKey) {
    piiInference = 'NAME_PATTERN';
    piiClassification = inferred;
  }
  const isPII = piiInference !== 'NONE';

  let encryptedAnnotation: ParsedColumn['encryptedAnnotation'] = null;
  const encMatch = comment ? /@encrypted\(\s*([A-Za-z0-9_-]+)\s*\)/i.exec(comment.text) : null;
  if (comment && encMatch) {
    const start = comment.start + encMatch.index + encMatch[0].indexOf(encMatch[1]);
    encryptedAnnotation = { algorithm: encMatch[1], start, end: start + encMatch[1].length };
  }
  const nativeEncryption = /\bencrypted\s+with\b[^,]*?algorithm\s*=\s*'?([A-Za-z0-9_-]+)/i.exec(
    content.slice(item.start, item.end)
  );
  const encryptionAlgorithm = encryptedAnnotation?.algorithm ?? nativeEncryption?.[1];

  const hasTenantKeyIsolation =
    /tenant.*(kms|key)/i.test(normalizeIdentifier(name)) || /@tenant_isolated_kms\b/i.test(commentText);

  return {
    node: {
      name,
      dataType,
      isPrimaryKey,
      isNullable,
      isPII,
      piiClassification,
      piiInference,
      encryptedAtRest: Boolean(encryptionAlgorithm),
      encryptionAlgorithm,
      hasTenantKeyIsolation,
      foreignKeyReference: references
        ? { table: references.table, column: references.column, onDeleteCascade: /cascade/i.test(references.onDeleteAction?.text ?? '') }
        : undefined,
      line: offsetToLineCol(starts, item.start).line,
    },
    itemStart: item.start,
    itemEnd: item.end,
    itemEndPosition: offsetToLineCol(starts, item.end),
    comment,
    defaultNumber,
    references,
    encryptedAnnotation,
    retentionAnnotation: annotationRetention(comment),
  };
}

function anchorFromOffsets(
  starts: number[],
  content: string,
  start: number,
  end: number,
  base: Omit<SourceEditAnchor, 'line' | 'column' | 'endLine' | 'endColumn' | 'sourceText'>
): SourceEditAnchor {
  const s = offsetToLineCol(starts, start);
  const e = offsetToLineCol(starts, end);
  return { ...base, line: s.line, column: s.col, endLine: e.line, endColumn: e.col, sourceText: content.slice(start, end) };
}

/**
 * Parses every `CREATE TABLE` statement in a SQL file. Foreign-key dependents
 * and erasure-cascade status are resolved across files by `linkSqlTables`.
 */
export function parseSqlDdl(file: TargetRepoFile): { tables: ParsedSqlTable[]; astNodeCount: number } {
  const content = file.content;
  const starts = lineStartOffsets(content);
  const lines = content.split('\n');
  const { masked, comments } = maskSql(content);
  const tables: ParsedSqlTable[] = [];
  let astNodeCount = 0;

  const createRe =
    /\bcreate\s+(?:(?:global|local)\s+)?(?:temp(?:orary)?\s+|unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?((?:"[^"]+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$]*))?)\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = createRe.exec(masked)) !== null) {
    const tableName = unquote(match[1].replace(/\s+/g, ''));
    const openParen = match.index + match[0].length - 1;
    let depth = 0;
    let closeParen = -1;
    for (let i = openParen; i < masked.length; i++) {
      if (masked[i] === '(') depth++;
      else if (masked[i] === ')') {
        depth--;
        if (depth === 0) {
          closeParen = i;
          break;
        }
      }
    }
    if (closeParen < 0) continue;
    createRe.lastIndex = closeParen;
    astNodeCount += 4;

    const startLine = offsetToLineCol(starts, match.index).line;
    const endLine = offsetToLineCol(starts, closeParen).line;
    const multiline = endLine > startLine;
    const items = splitTopLevel(masked, openParen + 1, closeParen);
    const lineOf = (offset: number) => offsetToLineCol(starts, offset).line;
    const trailingComment = (itemEnd: number): SqlComment | null => {
      const line = lineOf(itemEnd);
      return comments.find((c) => c.start >= itemEnd && lineOf(c.start) === line && c.start < closeParen) ??
        comments.find((c) => c.start >= itemEnd && lineOf(c.start) === line) ??
        null;
    };

    const columns: ParsedColumn[] = [];
    const tableForeignKeys: Array<{ column: string; table: string; refColumn: string; onDeleteAction: ParsedColumn['references'] }> = [];
    for (const item of items) {
      astNodeCount += 3;
      const itemText = masked.slice(item.start, item.end);
      if (CONSTRAINT_ITEM.test(itemText)) {
        const fk = /foreign\s+key\s*\(\s*("?[\w$]+"?)\s*\)\s*references\s+("(?:[^"]+)"|[\w$.]+)\s*(?:\(\s*("?[\w$]+"?)\s*\))?/i.exec(itemText);
        if (fk) {
          const clauseEnd = item.start + fk.index + fk[0].length;
          const tail = itemText.slice(fk.index + fk[0].length);
          const onDelete = /\bon\s+delete\s+(cascade|restrict|no\s+action|set\s+null|set\s+default)\b/i.exec(tail);
          const actionStart = onDelete ? clauseEnd + onDelete.index + onDelete[0].length - onDelete[1].length : 0;
          tableForeignKeys.push({
            column: unquote(fk[1]),
            table: unquote(fk[2]),
            refColumn: fk[3] ? unquote(fk[3]) : '',
            onDeleteAction: {
              table: unquote(fk[2]),
              column: fk[3] ? unquote(fk[3]) : '',
              clauseEnd,
              onDeleteAction: onDelete ? { text: onDelete[1], start: actionStart, end: actionStart + onDelete[1].length } : null,
            },
          });
        }
        continue;
      }
      const parsed = parseColumn(content, masked, item, trailingComment(item.end), starts);
      if (parsed) columns.push(parsed);
    }

    for (const fk of tableForeignKeys) {
      const col = columns.find((c) => c.node.name === fk.column);
      if (col && fk.onDeleteAction) {
        col.references = fk.onDeleteAction;
        col.node.foreignKeyReference = {
          table: fk.table,
          column: fk.refColumn,
          onDeleteCascade: /cascade/i.test(fk.onDeleteAction.onDeleteAction?.text ?? ''),
        };
        if (col.node.isPII && col.node.piiInference === 'NAME_PATTERN') {
          col.node.isPII = false;
          col.node.piiClassification = 'NONE';
          col.node.piiInference = 'NONE';
        }
      }
    }

    const createLineComment = comments.find((c) => lineOf(c.start) === startLine && c.start > openParen) ?? null;
    const tableRetentionAnnotation = annotationRetention(createLineComment);

    const retentionCandidates: Array<{ hours: number; anchor: SourceEditAnchor }> = [];
    for (const col of columns) {
      const colUnit = /(retention|ttl|expir|purge)/i.test(col.node.name) ? unitHoursFromName(col.node.name) : null;
      if (col.defaultNumber && colUnit !== null) {
        retentionCandidates.push({
          hours: col.defaultNumber.value * colUnit,
          anchor: anchorFromOffsets(starts, content, col.defaultNumber.start, col.defaultNumber.end, {
            role: 'RETENTION_TTL_LITERAL',
            symbol: `${tableName}.${col.node.name}`,
            numericValue: col.defaultNumber.value,
            hoursPerUnit: colUnit,
          }),
        });
      }
      if (col.retentionAnnotation) {
        retentionCandidates.push({
          hours: col.retentionAnnotation.value * col.retentionAnnotation.hoursPerUnit,
          anchor: anchorFromOffsets(starts, content, col.retentionAnnotation.start, col.retentionAnnotation.end, {
            role: 'RETENTION_ANNOTATION_LITERAL',
            symbol: `${tableName}.${col.node.name}`,
            numericValue: col.retentionAnnotation.value,
            hoursPerUnit: col.retentionAnnotation.hoursPerUnit,
          }),
        });
      }
    }
    if (tableRetentionAnnotation) {
      retentionCandidates.push({
        hours: tableRetentionAnnotation.value * tableRetentionAnnotation.hoursPerUnit,
        anchor: anchorFromOffsets(starts, content, tableRetentionAnnotation.start, tableRetentionAnnotation.end, {
          role: 'RETENTION_ANNOTATION_LITERAL',
          symbol: tableName,
          numericValue: tableRetentionAnnotation.value,
          hoursPerUnit: tableRetentionAnnotation.hoursPerUnit,
        }),
      });
    }

    const piiColumns = columns.filter((c) => c.node.isPII);
    const retentionHours = retentionCandidates.length ? Math.max(...retentionCandidates.map((r) => r.hours)) : null;
    const hasTenantKeyIsolation =
      columns.some((c) => c.node.hasTenantKeyIsolation) || /@tenant_isolated_kms\b/i.test(createLineComment?.text ?? '');

    const schema: SQLTableSchema = {
      tableName,
      filePath: file.path,
      startLine,
      endLine,
      containsPII: piiColumns.length > 0,
      retentionHoursConfigured: retentionHours,
      retentionDaysConfigured: retentionHours === null ? null : Math.round((retentionHours / 24) * 10) / 10,
      hasTenantKeyIsolation,
      hasErasureCascade: true,
      encryptedColumnsCount: piiColumns.filter((c) => c.node.encryptedAtRest).length,
      unencryptedPiiColumns: piiColumns.filter((c) => !c.node.encryptedAtRest).map((c) => c.node.name),
      columns: columns.map((c) => c.node),
      dependentForeignKeys: [],
    };

    const anchors: SourceEditAnchor[] = retentionCandidates.map((r) => r.anchor);

    // Column insertion point: after `tenant_id` when it ends with a comma, else before the last column.
    if (columns.length > 0) {
      const tenantCol = columns.find((c) => normalizeIdentifier(c.node.name) === 'tenant_id');
      const tenantHasComma = tenantCol ? masked.slice(tenantCol.itemEnd).trimStart().startsWith(',') : false;
      const lastCol = columns[columns.length - 1];
      const indentOf = (offset: number) => {
        const line = offsetToLineCol(starts, offset).line;
        return /^\s*/.exec(lines[line - 1] ?? '')?.[0] ?? '    ';
      };
      if (multiline) {
        const insertBeforeLine = tenantCol && tenantHasComma ? lineOf(tenantCol.itemEnd) + 1 : lineOf(lastCol.itemStart);
        anchors.push({
          role: 'SQL_COLUMN_INSERTION_POINT',
          symbol: tableName,
          line: insertBeforeLine,
          column: 0,
          endLine: insertBeforeLine,
          endColumn: 0,
          sourceText: '',
          context: { layout: 'multiline', indent: indentOf(lastCol.itemStart) },
        });
      } else {
        anchors.push(
          anchorFromOffsets(starts, content, lastCol.itemStart, lastCol.itemStart, {
            role: 'SQL_COLUMN_INSERTION_POINT',
            symbol: tableName,
            context: { layout: 'inline', indent: '' },
          })
        );
      }
    }

    for (const col of piiColumns) {
      const symbol = `${tableName}.${col.node.name}`;
      if (col.encryptedAnnotation) {
        anchors.push(
          anchorFromOffsets(starts, content, col.encryptedAnnotation.start, col.encryptedAnnotation.end, {
            role: 'SQL_COLUMN_ENCRYPTION_ANNOTATION',
            symbol,
            stringValue: col.encryptedAnnotation.algorithm,
            context: { mode: 'replace', piiClass: col.node.piiClassification ?? 'DIRECT_IDENTIFIER' },
          })
        );
      } else if (col.comment && lineOf(col.comment.start) === lineOf(col.itemEnd)) {
        anchors.push(
          anchorFromOffsets(starts, content, col.comment.end, col.comment.end, {
            role: 'SQL_COLUMN_ENCRYPTION_ANNOTATION',
            symbol,
            context: { mode: 'append-to-comment', piiClass: col.node.piiClassification ?? 'DIRECT_IDENTIFIER' },
          })
        );
      } else if (multiline) {
        const line = lineOf(col.itemEnd);
        const lineEnd = starts[line - 1] + (lines[line - 1] ?? '').length;
        anchors.push(
          anchorFromOffsets(starts, content, lineEnd, lineEnd, {
            role: 'SQL_COLUMN_ENCRYPTION_ANNOTATION',
            symbol,
            context: { mode: 'append-comment', piiClass: col.node.piiClassification ?? 'DIRECT_IDENTIFIER' },
          })
        );
      }
    }

    for (const col of columns) {
      if (!col.references) continue;
      const symbol = `${tableName}.${col.node.name}`;
      if (col.references.onDeleteAction) {
        anchors.push(
          anchorFromOffsets(starts, content, col.references.onDeleteAction.start, col.references.onDeleteAction.end, {
            role: 'SQL_FOREIGN_KEY_ON_DELETE',
            symbol,
            stringValue: col.references.onDeleteAction.text,
            context: { mode: 'replace-action', refTable: col.references.table },
          })
        );
      } else {
        anchors.push(
          anchorFromOffsets(starts, content, col.references.clauseEnd, col.references.clauseEnd, {
            role: 'SQL_FOREIGN_KEY_ON_DELETE',
            symbol,
            context: { mode: 'append-action', refTable: col.references.table },
          })
        );
      }
    }

    const encryptionCipher = piiColumns.find((c) => c.node.encryptionAlgorithm)?.node.encryptionAlgorithm;
    const finding: ASTFindingNode = {
      id: `ast-sql-${tableName}`,
      filePath: file.path,
      line: startLine,
      endLine,
      column: 1,
      language: 'sql',
      astNodeKind: 'CreateTableStatement',
      constructType: 'POSTGRES_DDL_TABLE',
      functionName: `CREATE TABLE ${tableName}`,
      codeSnippet: sliceLines(lines, startLine, endLine),
      metadata: {
        usesTenantIsolatedKms: hasTenantKeyIsolation,
        encryptionCipher: encryptionCipher
          ? hasTenantKeyIsolation && !/tenant/i.test(encryptionCipher)
            ? `${encryptionCipher}-TENANT-KMS`
            : encryptionCipher
          : undefined,
        retentionTtlHours: retentionHours,
        hasCascadeDelete: true,
        containsPii: piiColumns.length > 0,
      },
      editAnchors: anchors,
    };

    tables.push({ schema, finding, columns });
  }

  return { tables, astNodeCount };
}

/**
 * Resolves dependents across every parsed SQL file: explicit `REFERENCES`
 * plus implicit links (a column sharing the parent's primary-key name without
 * a foreign key), and derives each table's erasure-cascade status.
 */
export function linkSqlTables(parsed: ParsedSqlTable[]): void {
  for (const parent of parsed) {
    const dependents: NonNullable<SQLTableSchema['dependentForeignKeys']> = [];
    const pk = parent.schema.columns.find((c) => c.isPrimaryKey)?.name;
    for (const child of parsed) {
      if (child === parent) continue;
      for (const col of child.columns) {
        const ref = col.node.foreignKeyReference;
        if (ref && ref.table.toLowerCase() === parent.schema.tableName.toLowerCase()) {
          dependents.push({
            childTable: child.schema.tableName,
            childColumn: col.node.name,
            filePath: child.schema.filePath,
            line: col.node.line,
            onDeleteCascade: ref.onDeleteCascade,
            implicit: false,
          });
        } else if (!ref && pk && col.node.name === pk && !col.node.isPrimaryKey) {
          dependents.push({
            childTable: child.schema.tableName,
            childColumn: col.node.name,
            filePath: child.schema.filePath,
            line: col.node.line,
            onDeleteCascade: false,
            implicit: true,
          });
          col.node.foreignKeyReference = { table: parent.schema.tableName, column: pk, onDeleteCascade: false, implicit: true };
          const end = col.itemEndPosition;
          child.finding.editAnchors = [
            ...(child.finding.editAnchors ?? []),
            {
              role: 'SQL_FOREIGN_KEY_ON_DELETE',
              symbol: `${child.schema.tableName}.${col.node.name}`,
              line: end.line,
              column: end.col,
              endLine: end.line,
              endColumn: end.col,
              sourceText: '',
              context: { mode: 'add-references', refTable: parent.schema.tableName, refColumn: pk },
            },
          ];
        }
      }
    }
    parent.schema.dependentForeignKeys = dependents;
    parent.schema.hasErasureCascade = dependents.every((d) => d.onDeleteCascade);
    parent.finding.metadata.hasCascadeDelete = parent.schema.hasErasureCascade;
  }
}
