// Map-to-map comparison.
//
// Two ECU maps are rarely comparable by extId alone. Maps built from different
// ROMs share most extIds but not all, rename ~2/3 of their tables (the display
// names are translated descriptions, not identifiers), and — most importantly —
// frequently carry different axis breakpoints for the same logical table. A
// cell-by-cell diff of two tables whose X axis runs [90,100,230,...,1700] versus
// [90,100,230,...,1500,1600,1700] compares unrelated operating points.
//
// So matching runs in tiers (strongest identifier first) and value comparison
// resamples B onto A's axes whenever both tables declare real axes.

export interface TableDefLike {
  id?: string;
  extId: string;
  name?: string;
  units?: string;
  /**
   * Marks the tables bootmod3 surfaces in its folder tree — the "main" tables.
   * Exactly equal to tree membership and to the map's declared total in every
   * cached map; the remaining ~5/6 of tableData is hidden internals.
   */
  core?: boolean;
  hasXAxis?: boolean;
  hasYAxis?: boolean;
  xAxisName?: string;
  yAxisName?: string;
  rows?: string | number;
  columns?: string | number;
  /** Calibratable bounds for the table's values. */
  min?: number;
  max?: number;
}

export interface TableEntryLike {
  def: TableDefLike;
  rows: Array<{ values: number[] }>;
  hAxis?: { values: number[] };
  vAxis?: { values: number[] };
}

export interface TreeNodeLike {
  name: string;
  nodes?: TreeNodeLike[];
  tables?: Array<{ extId: string }>;
}

export interface TableTreeLike {
  mapId?: string;
  engineType?: string;
  nodes?: TreeNodeLike[];
  tableData: Record<string, TableEntryLike>;
}

export type MatchTier = "extId" | "id" | "id-normalized" | "name+shape" | "name";

export const ALL_TIERS: MatchTier[] = ["extId", "id", "id-normalized", "name+shape", "name"];

/**
 * Bare-name matching is off by default. Display names are translated
 * descriptions, not identifiers, and distinct tables genuinely share them —
 * e.g. two "Torque" scale-code entries whose ids differ only by index. The
 * shape+units guard on the tier above is what makes name matching safe.
 */
export const DEFAULT_TIERS: MatchTier[] = ["extId", "id", "id-normalized", "name+shape"];

export interface CompareOptions {
  /** Absolute difference at or below this is never reported. */
  absTol?: number;
  /** Relative difference at or below this is never reported. */
  relTol?: number;
  /** Matching tiers to attempt, strongest first. Defaults to DEFAULT_TIERS. */
  tiers?: MatchTier[];
  /** Resample B onto A's axes when both declare real axes that differ. */
  alignAxes?: boolean;
  /** Cap on per-table cell deltas retained; the summary counts are unaffected. */
  maxCellsPerTable?: number;
  /** Restrict both maps to their main (core) tables before matching. */
  onlyMainTables?: boolean;
}

export interface CellDelta {
  row: number;
  col: number;
  /** A's X-axis value at this column, when the table has a real X axis. */
  x?: number;
  /** A's Y-axis value at this row, when the table has a real Y axis. */
  y?: number;
  a: number;
  b: number;
  delta: number;
  /** Percent change relative to A, null when A is 0. */
  pct: number | null;
}

export interface TableStub {
  id?: string;
  extId: string;
  name?: string;
  units?: string;
  path: string;
  shape: [number, number];
}

export interface TableDiff {
  id?: string;
  extId: string;
  extIdB: string;
  name?: string;
  /** Set only when B's name differs from A's. */
  nameB?: string;
  path: string;
  pathB?: string;
  units?: string;
  unitsB?: string;
  tier: MatchTier;
  shapeA: [number, number];
  shapeB: [number, number];
  /** Both tables declare real axes and those axes are not identical. */
  axesDiffer: boolean;
  /** B was resampled onto A's axes before diffing. */
  axisAligned: boolean;
  /** Axes differ but B's axes were unusable, so cells were compared by index. */
  axisAlignmentFailed?: boolean;
  comparable: boolean;
  /** Why the values could not be compared, when comparable is false. */
  reason?: string;
  /** Caveat on an otherwise valid comparison. */
  note?: string;
  totalCells: number;
  changedCells: number;
  maxDelta: number | null;
  maxDeltaPct: number | null;
  /**
   * The largest change as a percentage of the table's own calibratable span
   * (def.max - def.min). Scale-free, so it is comparable across tables in a way
   * that percent-of-baseline is not, and defined even when the baseline is 0.
   */
  maxDeltaSpanPct: number | null;
  maxAt: { row: number; col: number; x?: number; y?: number } | null;
  meanAbsDelta: number | null;
  cells: CellDelta[];
  /** True when cells was truncated by maxCellsPerTable. */
  cellsTruncated: boolean;
}

export interface CompareResult {
  mapA?: string;
  mapB?: string;
  engineA?: string;
  engineB?: string;
  /** Whether the comparison was restricted to main (core) tables. */
  onlyMainTables: boolean;
  counts: {
    /** Tables considered, after any main-tables restriction. */
    tablesA: number;
    tablesB: number;
    matched: number;
    byTier: Record<string, number>;
    changed: number;
    unchanged: number;
    incomparable: number;
    onlyInA: number;
    onlyInB: number;
  };
  changed: TableDiff[];
  incomparable: TableDiff[];
  onlyInA: TableStub[];
  onlyInB: TableStub[];
}

export interface Indexed {
  entry: TableEntryLike;
  extId: string;
  path: string;
  shape: [number, number];
}

const DEFAULTS = {
  absTol: 1e-9,
  relTol: 1e-6,
  alignAxes: true,
  maxCellsPerTable: 200,
};

export function normalizeId(s: string | undefined): string {
  return (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function normalizeName(s: string | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Folder path for every extId in the tree, e.g. "Fuel > Lambda". */
export function buildPathIndex(nodes: TreeNodeLike[] | undefined, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const node of nodes ?? []) {
    const p = prefix ? `${prefix} > ${node.name}` : node.name;
    for (const t of node.tables ?? []) out.set(t.extId, p);
    for (const [k, v] of buildPathIndex(node.nodes, p)) out.set(k, v);
  }
  return out;
}

function shapeOf(entry: TableEntryLike): [number, number] {
  const rows = entry.rows?.length ?? 0;
  const cols = rows > 0 ? entry.rows[0].values.length : 0;
  return [rows, cols];
}

export function indexMap(map: TableTreeLike, onlyMainTables = false): Indexed[] {
  const paths = buildPathIndex(map.nodes);
  return Object.entries(map.tableData)
    .filter(([, entry]) => !onlyMainTables || entry.def.core === true)
    .map(([extId, entry]) => ({
      entry,
      extId,
      path: paths.get(extId) ?? "",
      shape: shapeOf(entry),
    }));
}

function tierKey(tier: MatchTier, t: Indexed): string | null {
  const d = t.entry.def;
  switch (tier) {
    case "extId":
      return t.extId;
    case "id":
      return d.id ? d.id : null;
    case "id-normalized": {
      const n = normalizeId(d.id);
      return n.length >= 3 ? n : null;
    }
    case "name+shape": {
      const n = normalizeName(d.name);
      return n.length >= 3 ? `${n}|${d.units ?? ""}|${t.shape[0]}x${t.shape[1]}` : null;
    }
    case "name": {
      const n = normalizeName(d.name);
      return n.length >= 3 ? n : null;
    }
  }
}

/**
 * Greedy tiered matching. Each tier only considers tables left unmatched by the
 * stronger tiers above it, and a key that is ambiguous on either side is skipped
 * rather than guessed — a wrong pairing is worse than an unmatched table, since
 * a bogus pairing shows up as a large fake delta.
 */
export function matchTables(
  a: Indexed[],
  b: Indexed[],
  tiers: MatchTier[]
): { pairs: Array<{ tier: MatchTier; a: Indexed; b: Indexed }>; unmatchedA: Indexed[]; unmatchedB: Indexed[] } {
  const pairs: Array<{ tier: MatchTier; a: Indexed; b: Indexed }> = [];
  let restA = a;
  let restB = b;

  for (const tier of tiers) {
    const bByKey = new Map<string, Indexed[]>();
    for (const t of restB) {
      const k = tierKey(tier, t);
      if (k === null) continue;
      const bucket = bByKey.get(k);
      if (bucket) bucket.push(t);
      else bByKey.set(k, [t]);
    }

    const aByKey = new Map<string, Indexed[]>();
    for (const t of restA) {
      const k = tierKey(tier, t);
      if (k === null) continue;
      const bucket = aByKey.get(k);
      if (bucket) bucket.push(t);
      else aByKey.set(k, [t]);
    }

    const takenA = new Set<Indexed>();
    const takenB = new Set<Indexed>();
    for (const [k, aCands] of aByKey) {
      const bCands = bByKey.get(k);
      if (!bCands || aCands.length !== 1 || bCands.length !== 1) continue;
      pairs.push({ tier, a: aCands[0], b: bCands[0] });
      takenA.add(aCands[0]);
      takenB.add(bCands[0]);
    }

    if (takenA.size === 0) continue;
    restA = restA.filter((t) => !takenA.has(t));
    restB = restB.filter((t) => !takenB.has(t));
  }

  return { pairs, unmatchedA: restA, unmatchedB: restB };
}

function isStrictlyMonotonic(v: number[]): 1 | -1 | 0 {
  if (v.length < 2) return 1;
  const up = v[1] > v[0];
  for (let i = 1; i < v.length; i++) {
    if (up && v[i] <= v[i - 1]) return 0;
    if (!up && v[i] >= v[i - 1]) return 0;
  }
  return up ? 1 : -1;
}

/**
 * Position of `x` in a strictly monotonic axis, as an index pair plus weight.
 * Values outside the axis clamp to the edge — extrapolating ECU tables past
 * their calibrated range invents data.
 */
function locate(axis: number[], x: number): { i0: number; i1: number; w: number } {
  const n = axis.length;
  if (n === 1) return { i0: 0, i1: 0, w: 0 };
  const desc = axis[n - 1] < axis[0];
  const cmp = (p: number, q: number) => (desc ? p > q : p < q);

  if (!cmp(axis[0], x) && axis[0] !== x) return { i0: 0, i1: 0, w: 0 };
  if (cmp(axis[n - 1], x) || axis[n - 1] === x) return { i0: n - 1, i1: n - 1, w: 0 };

  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cmp(axis[mid], x)) lo = mid;
    else hi = mid;
  }
  const span = axis[hi] - axis[lo];
  return { i0: lo, i1: hi, w: span === 0 ? 0 : (x - axis[lo]) / span };
}

/** Bilinear sample of `grid` (indexed [row][col]) at (x, y) over yAxis/xAxis. */
export function sampleGrid(
  grid: number[][],
  xAxis: number[],
  yAxis: number[],
  x: number,
  y: number
): number {
  const cx = locate(xAxis, x);
  const cy = locate(yAxis, y);
  const v00 = grid[cy.i0][cx.i0];
  const v01 = grid[cy.i0][cx.i1];
  const v10 = grid[cy.i1][cx.i0];
  const v11 = grid[cy.i1][cx.i1];
  const top = v00 + (v01 - v00) * cx.w;
  const bottom = v10 + (v11 - v10) * cx.w;
  return top + (bottom - top) * cy.w;
}

/**
 * Resample B's grid onto A's axes. Returns null when B's axes are unusable
 * (non-monotonic, or a length that disagrees with its own grid), in which case
 * the caller must fall back to index-wise comparison or report incomparable.
 */
export function resampleOntoAxes(
  bGrid: number[][],
  bXAxis: number[],
  bYAxis: number[],
  aXAxis: number[],
  aYAxis: number[]
): number[][] | null {
  // An empty grid passes every check below vacuously — a zero-length axis is
  // trivially "monotonic" and trivially matches a zero-row grid — and then
  // sampling it dereferences undefined. Reject it up front.
  if (bGrid.length === 0 || bXAxis.length === 0 || bYAxis.length === 0) return null;
  if (bGrid.length !== bYAxis.length) return null;
  if (bGrid.some((r) => r.length !== bXAxis.length)) return null;
  if (isStrictlyMonotonic(bXAxis) === 0 || isStrictlyMonotonic(bYAxis) === 0) return null;

  return aYAxis.map((y) => aXAxis.map((x) => sampleGrid(bGrid, bXAxis, bYAxis, x, y)));
}

export function valuesDiffer(a: number, b: number, absTol: number, relTol: number): boolean {
  const aNaN = Number.isNaN(a);
  const bNaN = Number.isNaN(b);
  if (aNaN || bNaN) return aNaN !== bNaN;
  const d = Math.abs(a - b);
  if (d <= absTol) return false;
  return d > relTol * Math.max(Math.abs(a), Math.abs(b));
}

function gridOf(entry: TableEntryLike): number[][] {
  return (entry.rows ?? []).map((r) => r.values);
}

function axisValues(entry: TableEntryLike, which: "h" | "v"): number[] {
  return (which === "h" ? entry.hAxis?.values : entry.vAxis?.values) ?? [];
}

/** Only axes the table declares as real carry meaningful breakpoints. */
function realAxes(entry: TableEntryLike): { x: number[] | null; y: number[] | null } {
  const d = entry.def;
  return {
    x: d.hasXAxis ? axisValues(entry, "h") : null,
    y: d.hasYAxis ? axisValues(entry, "v") : null,
  };
}

function sameNumbers(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
}

export function diffTables(
  a: Indexed,
  b: Indexed,
  tier: MatchTier,
  opts: Required<Pick<CompareOptions, "absTol" | "relTol" | "alignAxes" | "maxCellsPerTable">>
): TableDiff {
  const da = a.entry.def;
  const db = b.entry.def;

  const base: TableDiff = {
    id: da.id,
    extId: a.extId,
    extIdB: b.extId,
    name: da.name,
    nameB: da.name === db.name ? undefined : db.name,
    path: a.path,
    pathB: a.path === b.path ? undefined : b.path,
    units: da.units,
    unitsB: da.units === db.units ? undefined : db.units,
    tier,
    shapeA: a.shape,
    shapeB: b.shape,
    axesDiffer: false,
    axisAligned: false,
    comparable: true,
    totalCells: a.shape[0] * a.shape[1],
    changedCells: 0,
    maxDelta: null,
    maxDeltaPct: null,
    maxDeltaSpanPct: null,
    maxAt: null,
    meanAbsDelta: null,
    cells: [],
    cellsTruncated: false,
  };

  const aGrid = gridOf(a.entry);
  const bGrid = gridOf(b.entry);
  const axA = realAxes(a.entry);
  const axB = realAxes(b.entry);

  // A real axis on one side and none on the other means the two tables are not
  // the same kind of thing, whatever the identifier match said.
  const axisKindMismatch = !!axA.x !== !!axB.x || !!axA.y !== !!axB.y;

  const xDiffers = !!axA.x && !!axB.x && !sameNumbers(axA.x, axB.x);
  const yDiffers = !!axA.y && !!axB.y && !sameNumbers(axA.y, axB.y);
  base.axesDiffer = xDiffers || yDiffers;

  let compareGrid: number[][] | null = bGrid;

  // A's own axes must describe A's grid before they can be used as the
  // reference frame, or the resampled grid comes out a different size than the
  // grid it is diffed against.
  const aAxesUsable =
    (axA.x === null || axA.x.length === a.shape[1]) && (axA.y === null || axA.y.length === a.shape[0]);

  if (axisKindMismatch) {
    // A real axis on one side and none on the other means the two tables are
    // not the same kind of thing, whatever the identifier match said — that
    // holds whether or not the shapes happen to agree.
    compareGrid = null;
    base.comparable = false;
    base.reason =
      a.shape[0] === b.shape[0] && a.shape[1] === b.shape[1]
        ? "axis kinds differ (one side declares a real axis the other does not) — not the same kind of table"
        : `shape ${a.shape[0]}x${a.shape[1]} vs ${b.shape[0]}x${b.shape[1]} and axis kinds differ`;
  } else if (!aAxesUsable) {
    compareGrid = null;
    base.comparable = false;
    base.reason = `map A's axes do not describe its own grid (${a.shape[0]}x${a.shape[1]} grid, ${axA.y?.length ?? "-"}x${axA.x?.length ?? "-"} axes)`;
  } else if (opts.alignAxes && base.axesDiffer) {
    // A 1-D table has one real axis; give the missing dimension a degenerate
    // axis so the same bilinear path handles both cases.
    const aX = axA.x ?? Array.from({ length: a.shape[1] }, (_, i) => i);
    const aY = axA.y ?? Array.from({ length: a.shape[0] }, (_, i) => i);
    const bX = axB.x ?? Array.from({ length: b.shape[1] }, (_, i) => i);
    const bY = axB.y ?? Array.from({ length: b.shape[0] }, (_, i) => i);

    const resampled = resampleOntoAxes(bGrid, bX, bY, aX, aY);
    if (resampled) {
      compareGrid = resampled;
      base.axisAligned = true;
    } else if (a.shape[0] === b.shape[0] && a.shape[1] === b.shape[1]) {
      // Plenty of tables carry axis arrays that aren't real breakpoints
      // (repeated values, padding). Alignment is impossible there, but an
      // index-wise diff of two same-shaped grids is still informative — just
      // flag it so the caller knows the operating points may not line up.
      base.axisAlignmentFailed = true;
      base.note = "axes differ but B's axes are not strictly monotonic — compared by cell index";
    } else {
      compareGrid = null;
      base.comparable = false;
      base.reason = "axes differ, B's axes are not strictly monotonic, and shapes disagree — cannot align";
    }
  } else if (a.shape[0] !== b.shape[0] || a.shape[1] !== b.shape[1]) {
    compareGrid = null;
    base.comparable = false;
    base.reason = `shape ${a.shape[0]}x${a.shape[1]} vs ${b.shape[0]}x${b.shape[1]} with no usable axes to align on`;
  }

  if (!compareGrid) return base;

  // Whatever path produced compareGrid, it must now cover A cell for cell.
  // Silently skipping a missing cell would report a partial diff as a complete
  // one — worse, a wholly absent grid would report "unchanged".
  if (compareGrid.length !== aGrid.length || aGrid.some((row, i) => compareGrid![i].length !== row.length)) {
    base.comparable = false;
    base.reason = `internal: comparison grid ${compareGrid.length}x${compareGrid[0]?.length ?? 0} does not cover A's ${a.shape[0]}x${a.shape[1]} grid`;
    return base;
  }

  let sumAbs = 0;
  let maxAbs = -1;
  for (let r = 0; r < aGrid.length; r++) {
    for (let c = 0; c < aGrid[r].length; c++) {
      const av = aGrid[r][c];
      const bv = compareGrid[r][c];
      if (!valuesDiffer(av, bv, opts.absTol, opts.relTol)) continue;

      const delta = bv - av;
      const abs = Math.abs(delta);
      base.changedCells++;
      sumAbs += abs;

      const cell: CellDelta = {
        row: r,
        col: c,
        x: axA.x ? axA.x[c] : undefined,
        y: axA.y ? axA.y[r] : undefined,
        a: av,
        b: bv,
        delta,
        pct: av === 0 ? null : (delta / Math.abs(av)) * 100,
      };
      if (base.cells.length < opts.maxCellsPerTable) base.cells.push(cell);
      else base.cellsTruncated = true;

      if (abs > maxAbs) {
        maxAbs = abs;
        base.maxDelta = delta;
        base.maxDeltaPct = cell.pct;
        base.maxAt = { row: r, col: c, x: cell.x, y: cell.y };
      }
    }
  }

  base.meanAbsDelta = base.changedCells > 0 ? sumAbs / base.changedCells : 0;

  const span = (da.max ?? NaN) - (da.min ?? NaN);
  if (maxAbs >= 0 && Number.isFinite(span) && span > 0) {
    base.maxDeltaSpanPct = (maxAbs / span) * 100;
  }

  return base;
}

/**
 * Ranking weight for "most interesting change first".
 *
 * Magnitude only: a 20% timing pull matters exactly as much as a 20% addition,
 * and callers truncate this list, so a signed sort would hide every reduction.
 *
 * Fraction of the table's own calibratable span is the primary metric rather
 * than percent-of-baseline. Percent is unusable for ranking across tables here:
 * baselines near zero produce absurd percentages (one real cross-ROM pair
 * scores 41,942,940%) and a baseline of exactly zero produces none at all,
 * so a percent-ranked list is dominated by tables whose values merely started
 * small. Every table in every cached map carries a usable min/max span.
 */
function changeRank(d: TableDiff): number {
  if (d.maxDeltaSpanPct !== null) return d.maxDeltaSpanPct;
  if (d.maxDeltaPct !== null) return Math.abs(d.maxDeltaPct);
  return d.changedCells > 0 ? Infinity : 0;
}

function stub(t: Indexed): TableStub {
  return {
    id: t.entry.def.id,
    extId: t.extId,
    name: t.entry.def.name,
    units: t.entry.def.units,
    path: t.path,
    shape: t.shape,
  };
}

export function compareMaps(a: TableTreeLike, b: TableTreeLike, options: CompareOptions = {}): CompareResult {
  const opts = {
    absTol: options.absTol ?? DEFAULTS.absTol,
    relTol: options.relTol ?? DEFAULTS.relTol,
    alignAxes: options.alignAxes ?? DEFAULTS.alignAxes,
    maxCellsPerTable: options.maxCellsPerTable ?? DEFAULTS.maxCellsPerTable,
  };
  // An empty array is not nullish, so it would otherwise disable matching
  // entirely and report every table as unique to its map.
  if (options.tiers && options.tiers.length === 0) {
    throw new Error("tiers must name at least one matching tier");
  }
  const tiers = options.tiers ?? DEFAULT_TIERS;

  const onlyMainTables = options.onlyMainTables ?? false;
  const ia = indexMap(a, onlyMainTables);
  const ib = indexMap(b, onlyMainTables);
  const { pairs, unmatchedA, unmatchedB } = matchTables(ia, ib, tiers);

  const byTier: Record<string, number> = {};
  const changed: TableDiff[] = [];
  const incomparable: TableDiff[] = [];
  let unchanged = 0;

  for (const p of pairs) {
    byTier[p.tier] = (byTier[p.tier] ?? 0) + 1;
    const d = diffTables(p.a, p.b, p.tier, opts);
    if (!d.comparable) incomparable.push(d);
    else if (d.changedCells > 0) changed.push(d);
    else unchanged++;
  }

  changed.sort(
    (x, y) =>
      changeRank(y) - changeRank(x) ||
      Math.abs(y.maxDelta ?? 0) - Math.abs(x.maxDelta ?? 0) ||
      y.changedCells - x.changedCells
  );

  return {
    mapA: a.mapId,
    mapB: b.mapId,
    engineA: a.engineType,
    engineB: b.engineType,
    onlyMainTables,
    counts: {
      tablesA: ia.length,
      tablesB: ib.length,
      matched: pairs.length,
      byTier,
      changed: changed.length,
      unchanged,
      incomparable: incomparable.length,
      onlyInA: unmatchedA.length,
      onlyInB: unmatchedB.length,
    },
    changed,
    incomparable,
    onlyInA: unmatchedA.map(stub),
    onlyInB: unmatchedB.map(stub),
  };
}
