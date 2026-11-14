import ExcelJS from 'exceljs';

export type Cell = string | number | null;

export interface ParsedFile {
  headers: string[];
  rows: Cell[][];
  /** Първите редове като текст — за „Първите редове на последния файл“. */
  preview: string;
}

export class ParseError extends Error {}

export type Encoding = 'auto' | 'utf-8' | 'windows-1251';

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 20_000;
const PREVIEW_LINES = 6;

export function isXlsx(buf: Buffer, filename: string): boolean {
  // XLSX е ZIP архив: започва с „PK\x03\x04“.
  return /\.xlsx$/i.test(filename) || (buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50);
}

export async function parseImportFile(buf: Buffer, filename: string, encoding: Encoding = 'auto'): Promise<ParsedFile> {
  if (buf.length === 0) throw new ParseError('empty_file');
  if (buf.length > MAX_IMPORT_BYTES) throw new ParseError('file_too_large');
  if (isXlsx(buf, filename)) return parseXlsx(buf);
  if (/\.(csv|txt)$/i.test(filename) || !filename.includes('.')) return parseCsv(decode(buf, encoding));
  throw new ParseError('unsupported_format');
}

/** UTF-8, ако е валиден; иначе Windows-1251 (обичайно за касови програми). */
export function decode(buf: Buffer, encoding: Encoding): string {
  let text: string;
  if (encoding === 'windows-1251') text = new TextDecoder('windows-1251').decode(buf);
  else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      if (encoding === 'utf-8') throw new ParseError('bad_encoding');
      text = new TextDecoder('windows-1251').decode(buf);
    }
  }
  return text.replace(/^﻿/, '');
}

function detectDelimiter(line: string): string {
  const counts = new Map<string, number>([[';', 0], [',', 0], ['\t', 0]]);
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && counts.has(ch)) counts.set(ch, counts.get(ch)! + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
}

/** CSV по RFC 4180: кавички, удвоени кавички, нов ред в кавички. */
export function parseCsv(text: string): ParsedFile {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delim = detectDelimiter(firstLine);
  const records: string[][] = [];
  let field = '', row: string[] = [], quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      records.push(row); row = [];
      if (records.length > MAX_ROWS + 1) throw new ParseError('too_many_rows');
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); records.push(row); }
  const nonEmpty = records.filter((r) => r.some((c) => c.trim() !== ''));
  const [headers, ...rows] = nonEmpty;
  if (!headers) throw new ParseError('empty_file');
  return {
    headers: headers.map((h) => h.trim()),
    rows: rows.map((r) => r.map((c) => c.trim())),
    preview: text.split(/\r?\n/).slice(0, PREVIEW_LINES).join('\n'),
  };
}

async function parseXlsx(buf: Buffer): Promise<ParsedFile> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch {
    throw new ParseError('bad_xlsx');
  }
  const ws = wb.worksheets[0];
  if (!ws) throw new ParseError('empty_file');
  if (ws.rowCount > MAX_ROWS + 1) throw new ParseError('too_many_rows');
  const all: Cell[][] = [];
  ws.eachRow({ includeEmpty: false }, (r) => {
    const out: Cell[] = [];
    for (let c = 1; c <= ws.columnCount; c++) out.push(cellValue(r.getCell(c).value));
    all.push(out);
  });
  const [headers, ...rows] = all.filter((r) => r.some((c) => c !== null && String(c).trim() !== ''));
  if (!headers) throw new ParseError('empty_file');
  const asText = (r: Cell[]) => r.map((c) => (c === null ? '' : String(c))).join(';');
  return {
    headers: headers.map((h) => String(h ?? '').trim()),
    rows,
    preview: [headers, ...rows].slice(0, PREVIEW_LINES).map(asText).join('\n'),
  };
}

function cellValue(v: ExcelJS.CellValue): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if ('result' in v) return cellValue(v.result as ExcelJS.CellValue); // формула
    if ('richText' in v) return v.richText.map((t) => t.text).join('').trim();
    if ('text' in v) return String(v.text).trim(); // връзка
  }
  return String(v);
}
