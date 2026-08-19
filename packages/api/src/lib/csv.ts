// Minimal RFC-4180 CSV, hand-rolled rather than pulled in as a dependency:
// the whole surface we need is "quote when necessary" and "respect quotes".

export function toCsv(rows: Array<Record<string, unknown>>, columns: string[]): string {
  const cell = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const text = value instanceof Date ? value.toISOString() : String(value);
    // A field needs quoting if it contains a comma, a quote or a line break.
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => cell(row[column])).join(','));
  }
  // CRLF and a UTF-8 BOM keep Excel happy on Windows.
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** Returns the header row plus one object per data row. */
export function parseCsv(input: string): { columns: string[]; rows: Array<Record<string, string>> } {
  const text = input.replace(/^﻿/, '');
  const table: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      // Skip blank lines rather than emitting an empty record.
      if (row.length > 1 || row[0] !== '') table.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') table.push(row);
  }

  const [header = [], ...body] = table;
  const columns = header.map((name) => name.trim());
  const rows = body.map((cells) =>
    Object.fromEntries(columns.map((column, index) => [column, (cells[index] ?? '').trim()])),
  );
  return { columns, rows };
}
