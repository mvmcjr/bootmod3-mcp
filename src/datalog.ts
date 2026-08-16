// Datalog CSV parsing, channel resolution, and highlight (de)serialization.
//
// Pure by design — no `fs`, no `fetch`. Downloading a log and reading/writing
// the highlights file stay in `index.ts`; everything that can be decided from a
// string alone lives here so it is testable.

export interface ParsedDatalog {
  id: string;
  columns: string[]; // columns[0] is always the Time channel (seconds)
  rows: number[][];
}

export interface DatalogHighlight {
  uid: string;
  time: number;
  column?: string;
  value?: number;
  note: string;
  createdAt: string;
}

// bootmod3's CSV header sometimes has trailing metadata tokens (app version, log hash)
// that don't correspond to real data columns — trim the header to the actual row width.
export function parseDatalogCsv(id: string, raw: string): ParsedDatalog {
  const lines = raw
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.length > 0);
  if (lines.length === 0) return { id, columns: [], rows: [] };

  const header = lines[0].split(",").map((s) => s.trim());
  const dataLines = lines.slice(1);
  if (dataLines.length === 0) return { id, columns: header, rows: [] };

  const width = dataLines[0].split(",").length;
  const columns = header.slice(0, width);
  const rows = dataLines.map((line) => {
    const parts = line.split(",");
    const row = new Array<number>(width).fill(NaN);
    for (let i = 0; i < width && i < parts.length; i++) row[i] = parseFloat(parts[i]);
    return row;
  });

  return { id, columns, rows };
}

export function splitColumn(col: string): { name: string; unit?: string } {
  const m = col.match(/^(.*?)\s*\[(.*)\]$/);
  return m ? { name: m[1], unit: m[2] } : { name: col };
}

export function resolveColumn(datalog: ParsedDatalog, query: string): number {
  const lq = query.toLowerCase();
  const exact = datalog.columns.findIndex((c) => c.toLowerCase() === lq);
  if (exact !== -1) return exact;

  const matches = datalog.columns
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.toLowerCase().includes(lq));

  if (matches.length === 0) {
    throw new Error(`No datalog column matching "${query}". Available: ${datalog.columns.join(", ")}`);
  }
  if (matches.length > 1) {
    throw new Error(`"${query}" matches multiple columns, be more specific: ${matches.map((m) => m.c).join(", ")}`);
  }
  return matches[0].i;
}

/**
 * Highlights are a local invention with no server behind them, so a missing or
 * corrupt file is not an error condition — an unreadable store reads as "no
 * highlights yet" rather than failing the tool call.
 */
export function parseHighlights(raw: string | null | undefined): DatalogHighlight[] {
  if (raw === null || raw === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  // Valid JSON that isn't an array is still a corrupt store. Returning it
  // unchecked would hand a non-array to callers that push to it and read its
  // length — a truncated file containing `null` parses cleanly and then throws
  // a TypeError deep inside the tool handler.
  return Array.isArray(parsed) ? (parsed as DatalogHighlight[]) : [];
}

export function serializeHighlights(highlights: DatalogHighlight[]): string {
  return JSON.stringify(highlights, null, 2);
}

/** Returns the list without `uid`, throwing when there was nothing to remove. */
export function removeHighlight(
  highlights: DatalogHighlight[],
  uid: string,
  datalogId: string
): DatalogHighlight[] {
  const filtered = highlights.filter((h) => h.uid !== uid);
  if (filtered.length === highlights.length) {
    throw new Error(`No highlight with uid "${uid}" found for datalog ${datalogId}`);
  }
  return filtered;
}
