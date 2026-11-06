import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

/**
 * Documents for the lawyer's workspace (product guide, Phase 3): text from PDF, DOCX or plain
 * text, a check for Bangla documents in the old Bijoy encoding, and clause splitting. Splitting
 * is deterministic; a model never decides where a clause starts.
 */

export type DocumentFormat = 'pdf' | 'docx' | 'text';
export const MAX_DOCUMENT_BYTES = 3 * 1024 * 1024;

export interface ExtractedDocument {
  format: DocumentFormat;
  text: string;
  /** SHA-256 of the original file, not of the extracted text. */
  fileSha256: string;
  pages: number | null;
}

export class DocumentError extends Error {}

const PDF_MAGIC = Buffer.from('%PDF-');
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** The format from the file's first bytes; the name only breaks ties for plain text. */
export function detectFormat(data: Buffer, filename = ''): DocumentFormat {
  if (data.subarray(0, 5).equals(PDF_MAGIC)) return 'pdf';
  if (data.subarray(0, 4).equals(ZIP_MAGIC)) {
    if (/\.docx$/i.test(filename) || data.includes(Buffer.from('word/document.xml'))) return 'docx';
    throw new DocumentError('This is a ZIP file but not a Word document (.docx).');
  }
  if (/\.(pdf|docx?)$/i.test(filename)) throw new DocumentError(`The file is named ${filename} but its contents are not a ${filename.split('.').pop()!.toUpperCase()} file.`);
  return 'text';
}

/** Text of a PDF, DOCX or UTF-8 text file. Throws DocumentError for files we cannot read. */
export async function extractDocumentText(data: Buffer, filename = ''): Promise<ExtractedDocument> {
  if (data.length === 0) throw new DocumentError('The file is empty.');
  if (data.length > MAX_DOCUMENT_BYTES) throw new DocumentError(`The file is larger than ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB.`);
  const format = detectFormat(data, filename);
  const fileSha256 = crypto.createHash('sha256').update(data).digest('hex');
  if (format === 'text') {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(data).replace(/^\uFEFF/, '');
    return { format, text: normalizeNewlines(text), fileSha256, pages: null };
  }
  if (format === 'docx') {
    const mammoth = await import('mammoth');
    try {
      const { value } = await mammoth.extractRawText({ buffer: data });
      return { format, text: normalizeNewlines(value), fileSha256, pages: null };
    } catch (err) {
      throw new DocumentError(`The Word document could not be read: ${(err as Error).message}`);
    }
  }
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  let doc;
  try {
    doc = await pdfjs.getDocument({ data: new Uint8Array(data), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, standardFontDataUrl: standardFontDataUrl(), verbosity: 0 }).promise;
  } catch (err) {
    throw new DocumentError(`The PDF could not be read: ${(err as Error).message}`);
  }
  try {
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let line = '';
      const lines: string[] = [];
      for (const item of content.items) {
        if (!('str' in item)) continue;
        line += item.str;
        if (item.hasEOL) {
          lines.push(line);
          line = '';
        }
      }
      if (line) lines.push(line);
      pages.push(lines.join('\n'));
    }
    const text = normalizeNewlines(pages.join('\n\n'));
    if (!text.trim()) throw new DocumentError('The PDF has no text layer (a scan?). Upload a text PDF, a Word file or the text itself.');
    return { format, text, fileSha256, pages: doc.numPages };
  } finally {
    await doc.destroy();
  }
}

/** pdfjs reads the 14 standard PDF fonts (Helvetica, Times, …) from its own folder. */
const standardFontDataUrl = () => `${path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts')}${path.sep}`;

const normalizeNewlines = (s: string) => s.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n');

/**
 * Bangla PDFs made with the old Bijoy fonts extract as Latin letters. For a document the
 * uploader says is Bangla, fewer than 30% Bangla letters (U+0980–U+09FF) among all letters means
 * the text is not Unicode Bangla.
 */
export function looksLikeLegacyBangla(text: string): boolean {
  const bangla = (text.match(/[ঀ-৿]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  return bangla + latin > 20 && bangla / (bangla + latin) < 0.3;
}

const BANGLA_DIGITS = '০১২৩৪৫৬৭৮৯';
export const asciiDigits = (s: string) => s.replace(/[০-৯]/g, (d) => String(BANGLA_DIGITS.indexOf(d)));

/** A numbered heading at the start of a line: 4.2, Section 4, Article 17, § 3, ধারা ৪.২. */
const HEADING =
  /^[ \t]*(?:(?:§|section|sec\.|article|art\.|clause|ধারা|অনুচ্ছেদ)[ \t]*([0-9০-৯]+(?:\.[0-9০-৯]+)*[a-z]?)|([0-9০-৯]+(?:\.[0-9০-৯]+)+|[0-9০-৯]+\.)(?=[ \t]))/imu;

/** Wording that makes a clause an obligation or a prohibition. */
const NORMATIVE = /\b(?:must(?:\s+not)?|shall(?:\s+not)?|is\s+prohibited|are\s+prohibited|prohibited|is\s+required|are\s+required|required\s+to|may\s+not|is\s+not\s+permitted|never)\b|অবশ্যই|করতে\s*হবে|নিষিদ্ধ|যাবে\s*না|করা\s*যাবে\s*না/giu;

export interface DocumentClause {
  index: number;
  /** The heading number with ASCII digits ("4.2"), or null for text before the first heading. */
  number: string | null;
  /** Character offsets of the clause in the document text. */
  start: number;
  end: number;
  text: string;
  normative: boolean;
  /** The normative words found, with offsets relative to the clause text. */
  normativeMatches: Array<{ text: string; start: number; end: number }>;
}

/**
 * Splits a document on numbered headings. Every part is returned, normative or not, so the
 * lawyer sees what was skipped. Text before the first heading is a clause without a number.
 */
export function splitClauses(text: string): DocumentClause[] {
  const starts: Array<{ at: number; number: string }> = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    const m = HEADING.exec(line);
    if (m) starts.push({ at: offset, number: asciiDigits(m[1] ?? m[2]).replace(/\.$/, '') });
    offset += line.length + 1;
  }
  const parts: Array<{ start: number; end: number; number: string | null }> = [];
  if (starts.length === 0 || starts[0].at > 0) parts.push({ start: 0, end: starts[0]?.at ?? text.length, number: null });
  starts.forEach((s, i) => parts.push({ start: s.at, end: starts[i + 1]?.at ?? text.length, number: s.number }));

  const out: DocumentClause[] = [];
  for (const p of parts) {
    const raw = text.slice(p.start, p.end);
    const lead = raw.length - raw.trimStart().length;
    const body = raw.trim();
    if (!body) continue;
    const normativeMatches = [...body.matchAll(NORMATIVE)].map((m) => ({ text: m[0], start: m.index!, end: m.index! + m[0].length }));
    out.push({
      index: out.length,
      number: p.number,
      start: p.start + lead,
      end: p.start + lead + body.length,
      text: body,
      normative: normativeMatches.length > 0,
      normativeMatches,
    });
  }
  return out;
}
