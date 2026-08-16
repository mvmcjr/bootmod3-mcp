import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import {
  ALL_TIERS,
  compareMaps,
  indexMap,
  matchTables,
  normalizeId,
  normalizeName,
  resampleOntoAxes,
  sampleGrid,
  valuesDiffer,
  type TableEntryLike,
  type TableTreeLike,
} from "./compare.js";

// ---------------------------------------------------------------------------
// synthetic fixtures — exact assertions the real cache can't give us
// ---------------------------------------------------------------------------

interface MakeTable {
  id?: string;
  extId: string;
  name?: string;
  units?: string;
  grid: number[][];
  xAxis?: number[];
  yAxis?: number[];
  folder?: string;
  core?: boolean;
  min?: number;
  max?: number;
}

function makeMap(mapId: string, tables: MakeTable[], engineType = "N20-TEST"): TableTreeLike {
  const tableData: Record<string, TableEntryLike> = {};
  const folders = new Map<string, Array<{ extId: string }>>();

  for (const t of tables) {
    const rows = t.grid.length;
    const cols = rows > 0 ? t.grid[0].length : 0;
    tableData[t.extId] = {
      def: {
        id: t.id,
        extId: t.extId,
        name: t.name,
        units: t.units,
        core: t.core,
        min: t.min,
        max: t.max,
        hasXAxis: t.xAxis !== undefined,
        hasYAxis: t.yAxis !== undefined,
        rows: String(rows),
        columns: String(cols),
      },
      rows: t.grid.map((values) => ({ values })),
      // A table without a real axis still carries a padded axis array in the
      // API payload, mirroring what bootmod3 actually returns.
      hAxis: { values: t.xAxis ?? new Array(Math.max(cols, 1)).fill(48) },
      vAxis: { values: t.yAxis ?? new Array(Math.max(rows, 1)).fill(48) },
    };
    const folder = t.folder ?? "Root";
    const bucket = folders.get(folder);
    if (bucket) bucket.push({ extId: t.extId });
    else folders.set(folder, [{ extId: t.extId }]);
  }

  return {
    mapId,
    engineType,
    nodes: [...folders].map(([name, tbls]) => ({ name, tables: tbls })),
    tableData,
  };
}

describe("normalizers", () => {
  test("normalizeId strips separators and case", () => {
    assert.equal(normalizeId("KF_ZW_PF1"), "KFZWPF1");
    assert.equal(normalizeId("kf-zw pf1"), "KFZWPF1");
    assert.equal(normalizeId(undefined), "");
  });

  test("normalizeName strips punctuation and case", () => {
    assert.equal(normalizeName("Base Ignition Timing (Full Load)"), "baseignitiontimingfullload");
  });
});

describe("valuesDiffer", () => {
  test("float noise below relative tolerance is not a difference", () => {
    assert.equal(valuesDiffer(10.000610349923999, 10.0006103499241, 1e-9, 1e-6), false);
  });

  test("a real change is a difference", () => {
    assert.equal(valuesDiffer(10, 10.5, 1e-9, 1e-6), true);
  });

  test("absolute tolerance covers near-zero values that relative tolerance cannot", () => {
    assert.equal(valuesDiffer(0, 1e-12, 1e-9, 1e-6), false);
    assert.equal(valuesDiffer(0, 0.001, 1e-9, 1e-6), true);
  });

  test("NaN equals NaN, NaN differs from a number", () => {
    assert.equal(valuesDiffer(NaN, NaN, 1e-9, 1e-6), false);
    assert.equal(valuesDiffer(NaN, 1, 1e-9, 1e-6), true);
  });
});

describe("sampleGrid", () => {
  const grid = [
    [0, 10],
    [20, 30],
  ];
  const x = [0, 100];
  const y = [0, 100];

  test("hits exact breakpoints", () => {
    assert.equal(sampleGrid(grid, x, y, 0, 0), 0);
    assert.equal(sampleGrid(grid, x, y, 100, 0), 10);
    assert.equal(sampleGrid(grid, x, y, 0, 100), 20);
    assert.equal(sampleGrid(grid, x, y, 100, 100), 30);
  });

  test("interpolates bilinearly between breakpoints", () => {
    assert.equal(sampleGrid(grid, x, y, 50, 0), 5);
    assert.equal(sampleGrid(grid, x, y, 50, 50), 15);
  });

  test("clamps outside the calibrated range instead of extrapolating", () => {
    assert.equal(sampleGrid(grid, x, y, -500, -500), 0);
    assert.equal(sampleGrid(grid, x, y, 5000, 5000), 30);
  });

  test("handles a descending axis", () => {
    const desc = [100, 0];
    const dgrid = [
      [10, 0],
      [30, 20],
    ];
    assert.equal(sampleGrid(dgrid, desc, y, 100, 0), 10);
    assert.equal(sampleGrid(dgrid, desc, y, 50, 0), 5);
  });
});

describe("resampleOntoAxes", () => {
  test("rejects non-monotonic source axes", () => {
    const bad = resampleOntoAxes([[1, 2, 3]], [0, 5, 5], [0], [0, 5], [0]);
    assert.equal(bad, null);
  });

  test("rejects axes whose length disagrees with the grid", () => {
    assert.equal(resampleOntoAxes([[1, 2]], [0, 1, 2], [0], [0], [0]), null);
  });

  test("rejects an empty grid instead of dereferencing undefined", () => {
    // An empty grid satisfies every other check vacuously: a zero-length axis
    // is trivially monotonic and trivially matches a zero-row grid. Sampling it
    // then threw a TypeError out of the whole comparison.
    assert.equal(resampleOntoAxes([], [], [], [0, 1], [0]), null);
    assert.equal(resampleOntoAxes([], [0, 1], [0], [0, 1], [0]), null);
  });

  test("resamples a coarser grid onto a finer axis", () => {
    const out = resampleOntoAxes(
      [
        [0, 100],
        [0, 100],
      ],
      [0, 10],
      [0, 10],
      [0, 5, 10],
      [0, 10]
    );
    assert.deepEqual(out, [
      [0, 50, 100],
      [0, 50, 100],
    ]);
  });
});

describe("matchTables tiers", () => {
  test("extId wins when both maps share it", () => {
    const a = makeMap("A", [{ extId: "E1", id: "KF_A", name: "Alpha", grid: [[1]] }]);
    const b = makeMap("B", [{ extId: "E1", id: "KF_A", name: "Alpha", grid: [[2]] }]);
    const { pairs } = matchTables(indexMap(a), indexMap(b), ALL_TIERS);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].tier, "extId");
  });

  test("falls back to id when extIds were reissued", () => {
    const a = makeMap("A", [{ extId: "E1", id: "KF_A", name: "Alpha", grid: [[1]] }]);
    const b = makeMap("B", [{ extId: "ZZZ", id: "KF_A", name: "Renamed Alpha", grid: [[2]] }]);
    const { pairs } = matchTables(indexMap(a), indexMap(b), ALL_TIERS);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].tier, "id");
  });

  test("falls back to a normalized id when separators drift", () => {
    const a = makeMap("A", [{ extId: "E1", id: "KF_ZW_PF1", name: "Alpha", grid: [[1]] }]);
    const b = makeMap("B", [{ extId: "ZZZ", id: "kf-zw-pf1", name: "Beta", grid: [[2]] }]);
    const { pairs } = matchTables(indexMap(a), indexMap(b), ALL_TIERS);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].tier, "id-normalized");
  });

  test("falls back to name+shape when ids are absent", () => {
    const a = makeMap("A", [{ extId: "E1", name: "Lambda Target", units: "-", grid: [[1, 2]] }]);
    const b = makeMap("B", [{ extId: "E2", name: "lambda  target!", units: "-", grid: [[3, 4]] }]);
    const { pairs } = matchTables(indexMap(a), indexMap(b), ALL_TIERS);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].tier, "name+shape");
  });

  test("falls back to bare name when the shape also changed", () => {
    const a = makeMap("A", [{ extId: "E1", name: "Lambda Target", grid: [[1, 2]] }]);
    const b = makeMap("B", [{ extId: "E2", name: "Lambda Target", grid: [[3, 4, 5]] }]);
    const { pairs } = matchTables(indexMap(a), indexMap(b), ALL_TIERS);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].tier, "name");
  });

  test("an ambiguous name is left unmatched rather than guessed", () => {
    const a = makeMap("A", [{ extId: "E1", name: "Duplicate", grid: [[1]] }]);
    const b = makeMap("B", [
      { extId: "E2", name: "Duplicate", grid: [[2]] },
      { extId: "E3", name: "Duplicate", grid: [[3]] },
    ]);
    const { pairs, unmatchedA, unmatchedB } = matchTables(indexMap(a), indexMap(b), ALL_TIERS);
    assert.equal(pairs.length, 0);
    assert.equal(unmatchedA.length, 1);
    assert.equal(unmatchedB.length, 2);
  });

  test("a stronger tier claims a table before a weaker tier can steal it", () => {
    // B holds an id-match and a decoy that only shares A's name.
    const a = makeMap("A", [{ extId: "E1", id: "KF_A", name: "Alpha", grid: [[1]] }]);
    const b = makeMap("B", [
      { extId: "E9", id: "KF_A", name: "Totally Different", grid: [[2]] },
      { extId: "E8", id: "KF_OTHER", name: "Alpha", grid: [[3]] },
    ]);
    const { pairs } = matchTables(indexMap(a), indexMap(b), ALL_TIERS);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].tier, "id");
    assert.equal(pairs[0].b.extId, "E9");
  });

  test("bare-name matching is opt-in, not a default", () => {
    const a = makeMap("A", [{ extId: "E1", id: "KF_A", name: "Torque", grid: [[1, 2]] }]);
    const b = makeMap("B", [{ extId: "E2", id: "KF_B", name: "Torque", grid: [[3, 4, 5]] }]);

    assert.equal(compareMaps(a, b).counts.matched, 0);
    assert.equal(compareMaps(a, b, { tiers: ALL_TIERS }).counts.matched, 1);
  });

  test("restricting tiers suppresses the weaker fallbacks", () => {
    const a = makeMap("A", [{ extId: "E1", id: "KF_A", name: "Alpha", grid: [[1]] }]);
    const b = makeMap("B", [{ extId: "ZZZ", id: "KF_A", name: "Alpha", grid: [[2]] }]);
    const { pairs, unmatchedA } = matchTables(indexMap(a), indexMap(b), ["extId"]);
    assert.equal(pairs.length, 0);
    assert.equal(unmatchedA.length, 1);
  });
});

describe("compareMaps value diffing", () => {
  test("identical maps report no changes", () => {
    const a = makeMap("A", [{ extId: "E1", id: "KF_A", name: "Alpha", grid: [[1, 2]], xAxis: [0, 100] }]);
    const b = makeMap("B", [{ extId: "E1", id: "KF_A", name: "Alpha", grid: [[1, 2]], xAxis: [0, 100] }]);
    const r = compareMaps(a, b);
    assert.equal(r.counts.changed, 0);
    assert.equal(r.counts.unchanged, 1);
    assert.equal(r.counts.matched, 1);
  });

  test("a changed cell is reported with delta, percent and axis coordinates", () => {
    const a = makeMap("A", [
      { extId: "E1", id: "KF_ZW", name: "Ignition", units: "°", grid: [[10, 20]], xAxis: [1000, 2000] },
    ]);
    const b = makeMap("B", [
      { extId: "E1", id: "KF_ZW", name: "Ignition", units: "°", grid: [[10, 25]], xAxis: [1000, 2000] },
    ]);
    const r = compareMaps(a, b);
    assert.equal(r.counts.changed, 1);
    const d = r.changed[0];
    assert.equal(d.changedCells, 1);
    assert.equal(d.totalCells, 2);
    assert.equal(d.maxDelta, 5);
    assert.equal(d.maxDeltaPct, 25);
    assert.deepEqual(d.maxAt, { row: 0, col: 1, x: 2000, y: undefined });
    assert.equal(d.cells[0].x, 2000);
    assert.equal(d.axisAligned, false);
  });

  test("float noise inside tolerance is not reported as a change", () => {
    const a = makeMap("A", [{ extId: "E1", id: "KF_A", grid: [[10.000610349923999]] }]);
    const b = makeMap("B", [{ extId: "E1", id: "KF_A", grid: [[10.000610349924101]] }]);
    assert.equal(compareMaps(a, b).counts.changed, 0);
  });

  test("tightening relTol surfaces the noise as a change", () => {
    const a = makeMap("A", [{ extId: "E1", id: "KF_A", grid: [[10.0]] }]);
    const b = makeMap("B", [{ extId: "E1", id: "KF_A", grid: [[10.0001]] }]);
    assert.equal(compareMaps(a, b, { relTol: 1e-9 }).counts.changed, 1);
    assert.equal(compareMaps(a, b, { relTol: 1e-3 }).counts.changed, 0);
  });

  // This is the case that motivates axis alignment: B holds the identical
  // calibration, just sampled at extra breakpoints. Index-wise comparison
  // calls almost every cell changed; axis-aware comparison calls it identical.
  test("same calibration on a finer axis is identical once aligned", () => {
    const a = makeMap("A", [
      { extId: "E1", id: "KF_A", grid: [[0, 100]], xAxis: [0, 10] },
    ]);
    const b = makeMap("B", [
      { extId: "E1", id: "KF_A", grid: [[0, 50, 100]], xAxis: [0, 5, 10] },
    ]);

    const aligned = compareMaps(a, b);
    assert.equal(aligned.counts.changed, 0);
    assert.equal(aligned.counts.unchanged, 1);

    const naive = compareMaps(a, b, { alignAxes: false });
    assert.equal(naive.counts.incomparable, 1);
    assert.match(naive.incomparable[0].reason ?? "", /shape 1x2 vs 1x3/);
  });

  test("a real change on a shifted axis is still caught after alignment", () => {
    const a = makeMap("A", [{ extId: "E1", id: "KF_A", grid: [[0, 100]], xAxis: [0, 10] }]);
    const b = makeMap("B", [{ extId: "E1", id: "KF_A", grid: [[0, 60, 120]], xAxis: [0, 5, 10] }]);
    const r = compareMaps(a, b);
    assert.equal(r.counts.changed, 1);
    const d = r.changed[0];
    assert.equal(d.axisAligned, true);
    assert.equal(d.axesDiffer, true);
    // A's x=10 lands on B's last breakpoint: 120 vs 100.
    assert.equal(d.maxDelta, 20);
    assert.equal(d.maxAt?.x, 10);
  });

  test("axis alignment works in both dimensions", () => {
    const a = makeMap("A", [
      { extId: "E1", id: "KF_A", grid: [[0, 10], [20, 30]], xAxis: [0, 100], yAxis: [0, 100] },
    ]);
    const b = makeMap("B", [
      {
        extId: "E1",
        id: "KF_A",
        grid: [
          [0, 5, 10],
          [10, 15, 20],
          [20, 25, 30],
        ],
        xAxis: [0, 50, 100],
        yAxis: [0, 50, 100],
      },
    ]);
    assert.equal(compareMaps(a, b).counts.changed, 0);
  });

  test("shape change with no real axes is incomparable, not a fake diff", () => {
    const a = makeMap("A", [{ extId: "E1", id: "K_SCALAR", grid: [[5]] }]);
    const b = makeMap("B", [{ extId: "E1", id: "K_SCALAR", grid: [[5], [5], [5]] }]);
    const r = compareMaps(a, b);
    assert.equal(r.counts.incomparable, 1);
    assert.equal(r.counts.changed, 0);
    assert.match(r.incomparable[0].reason ?? "", /no usable axes/);
  });

  test("unusable axes fall back to an index diff, flagged, when shapes still agree", () => {
    // Real maps carry axis arrays that are padding rather than breakpoints;
    // those can't be aligned, but a same-shape index diff is still worth having.
    const a = makeMap("A", [{ extId: "E1", id: "KF_A", grid: [[1, 2, 3]], xAxis: [0, 5, 10] }]);
    const b = makeMap("B", [{ extId: "E1", id: "KF_A", grid: [[1, 9, 3]], xAxis: [0, 0, 0] }]);
    const r = compareMaps(a, b);
    assert.equal(r.counts.incomparable, 0);
    assert.equal(r.counts.changed, 1);
    const d = r.changed[0];
    assert.equal(d.axisAligned, false);
    assert.equal(d.axisAlignmentFailed, true);
    assert.match(d.note ?? "", /not strictly monotonic/);
    assert.equal(d.changedCells, 1);
  });

  test("unusable axes plus a shape mismatch is incomparable", () => {
    const a = makeMap("A", [{ extId: "E1", id: "KF_A", grid: [[1, 2, 3]], xAxis: [0, 5, 10] }]);
    const b = makeMap("B", [{ extId: "E1", id: "KF_A", grid: [[1, 9]], xAxis: [0, 0] }]);
    const r = compareMaps(a, b);
    assert.equal(r.counts.incomparable, 1);
    assert.match(r.incomparable[0].reason ?? "", /shapes disagree/);
  });

  test("axis kind mismatch is incomparable rather than silently index-diffed", () => {
    const a = makeMap("A", [{ extId: "E1", id: "KF_A", grid: [[1, 2]], xAxis: [0, 10] }]);
    const b = makeMap("B", [{ extId: "E1", id: "KF_A", grid: [[1, 2, 3]] }]);
    const r = compareMaps(a, b);
    assert.equal(r.counts.incomparable, 1);
    assert.match(r.incomparable[0].reason ?? "", /axis kinds differ/);
  });


  test("renames, unit changes and folder moves ride along with the diff", () => {
    const a = makeMap("A", [
      { extId: "E1", id: "KF_A", name: "Old Name", units: "-", grid: [[1]], folder: "Fuel" },
    ]);
    const b = makeMap("B", [
      { extId: "E1", id: "KF_A", name: "New Name", units: "%", grid: [[2]], folder: "Ignition" },
    ]);
    const d = compareMaps(a, b).changed[0];
    assert.equal(d.name, "Old Name");
    assert.equal(d.nameB, "New Name");
    assert.equal(d.units, "-");
    assert.equal(d.unitsB, "%");
    assert.equal(d.path, "Fuel");
    assert.equal(d.pathB, "Ignition");
  });

  test("tables present in only one map are reported separately", () => {
    const a = makeMap("A", [
      { extId: "E1", id: "KF_A", name: "Shared", grid: [[1]] },
      { extId: "E2", id: "KF_ONLY_A", name: "OnlyA", grid: [[1]] },
    ]);
    const b = makeMap("B", [
      { extId: "E1", id: "KF_A", name: "Shared", grid: [[1]] },
      { extId: "E3", id: "KF_ONLY_B", name: "OnlyB", grid: [[1]] },
    ]);
    const r = compareMaps(a, b);
    assert.equal(r.counts.onlyInA, 1);
    assert.equal(r.counts.onlyInB, 1);
    assert.equal(r.onlyInA[0].id, "KF_ONLY_A");
    assert.equal(r.onlyInB[0].id, "KF_ONLY_B");
  });

  test("cells are capped per table but counts stay complete", () => {
    const wide = Array.from({ length: 20 }, (_, i) => i);
    const a = makeMap("A", [{ extId: "E1", id: "KF_A", grid: [wide] }]);
    const b = makeMap("B", [{ extId: "E1", id: "KF_A", grid: [wide.map((v) => v + 1)] }]);
    const d = compareMaps(a, b, { maxCellsPerTable: 5 }).changed[0];
    assert.equal(d.changedCells, 20);
    assert.equal(d.cells.length, 5);
    assert.equal(d.cellsTruncated, true);
  });

  test("changed tables are ordered by largest percent change first", () => {
    const a = makeMap("A", [
      { extId: "E1", id: "SMALL", grid: [[100]] },
      { extId: "E2", id: "BIG", grid: [[10]] },
    ]);
    const b = makeMap("B", [
      { extId: "E1", id: "SMALL", grid: [[101]] },
      { extId: "E2", id: "BIG", grid: [[20]] },
    ]);
    const r = compareMaps(a, b);
    assert.deepEqual(
      r.changed.map((d) => d.id),
      ["BIG", "SMALL"]
    );
  });

  // Callers truncate the changed list, so a signed sort would push every
  // reduction past the cutoff — for a tuning tool that hides exactly the
  // pulled-timing direction.
  test("ordering is by magnitude, so a large reduction outranks a small increase", () => {
    const a = makeMap("A", [
      { extId: "E1", id: "TINY_UP", grid: [[100]] },
      { extId: "E2", id: "BIG_DOWN", grid: [[100]] },
    ]);
    const b = makeMap("B", [
      { extId: "E1", id: "TINY_UP", grid: [[101]] },
      { extId: "E2", id: "BIG_DOWN", grid: [[20]] },
    ]);
    const r = compareMaps(a, b);
    assert.deepEqual(
      r.changed.map((d) => d.id),
      ["BIG_DOWN", "TINY_UP"]
    );
    assert.equal(r.changed[0].maxDeltaPct, -80);
  });

  test("span percent measures the move against the table's own bounds", () => {
    const a = makeMap("A", [{ extId: "E1", id: "KF_A", grid: [[10]], min: 0, max: 200 }]);
    const b = makeMap("B", [{ extId: "E1", id: "KF_A", grid: [[60]], min: 0, max: 200 }]);
    const d = compareMaps(a, b).changed[0];
    assert.equal(d.maxDelta, 50);
    assert.equal(d.maxDeltaPct, 500);
    assert.equal(d.maxDeltaSpanPct, 25);
  });

  // Percent-of-baseline ranks a 1→2 flick above a real calibration move.
  // Fraction-of-span does not.
  test("span ranking beats a near-zero baseline's absurd percent", () => {
    const a = makeMap("A", [
      { extId: "E1", id: "TINY_BASELINE", grid: [[0.001]], min: 0, max: 100 },
      { extId: "E2", id: "REAL_MOVE", grid: [[20]], min: 0, max: 100 },
    ]);
    const b = makeMap("B", [
      { extId: "E1", id: "TINY_BASELINE", grid: [[1]], min: 0, max: 100 },
      { extId: "E2", id: "REAL_MOVE", grid: [[80]], min: 0, max: 100 },
    ]);
    const r = compareMaps(a, b);
    assert.ok(r.changed[0].maxDeltaPct! < r.changed[1].maxDeltaPct!, "percent alone would invert this");
    assert.deepEqual(
      r.changed.map((d) => d.id),
      ["REAL_MOVE", "TINY_BASELINE"]
    );
  });

  test("a value switched on from zero still ranks by its span", () => {
    const a = makeMap("A", [
      { extId: "E1", id: "SMALL_FROM_ZERO", grid: [[0]], min: 0, max: 100 },
      { extId: "E2", id: "BIG_FROM_ZERO", grid: [[0]], min: 0, max: 100 },
    ]);
    const b = makeMap("B", [
      { extId: "E1", id: "SMALL_FROM_ZERO", grid: [[1]], min: 0, max: 100 },
      { extId: "E2", id: "BIG_FROM_ZERO", grid: [[90]], min: 0, max: 100 },
    ]);
    const r = compareMaps(a, b);
    assert.equal(r.changed[0].id, "BIG_FROM_ZERO");
    assert.equal(r.changed[0].maxDeltaPct, null);
    assert.equal(r.changed[0].maxDeltaSpanPct, 90);
  });

  test("a table with no usable bounds falls back to percent ranking", () => {
    const a = makeMap("A", [{ extId: "E1", id: "NO_BOUNDS", grid: [[10]] }]);
    const b = makeMap("B", [{ extId: "E1", id: "NO_BOUNDS", grid: [[20]] }]);
    const d = compareMaps(a, b).changed[0];
    assert.equal(d.maxDeltaSpanPct, null);
    assert.equal(d.maxDeltaPct, 100);
  });

  test("A's own axes must describe A's grid", () => {
    // save_tables writes a placeholder axis regardless of column count, so a
    // map can legitimately carry an axis that does not match its grid.
    const a = makeMap("A", [{ extId: "E1", id: "KF_A", grid: [[1, 2, 3]], xAxis: [0, 10] }]);
    const b = makeMap("B", [{ extId: "E1", id: "KF_A", grid: [[50, 60, 70]], xAxis: [0, 5, 10] }]);
    const r = compareMaps(a, b);
    assert.equal(r.counts.changed, 0);
    assert.equal(r.counts.unchanged, 0);
    assert.equal(r.counts.incomparable, 1);
    assert.match(r.incomparable[0].reason ?? "", /do not describe its own grid/);
  });

  test("an empty axis on A is caught rather than reported as unchanged", () => {
    const a = makeMap("A", [{ extId: "E1", id: "KF_A", grid: [[1, 2, 3]] }]);
    a.tableData.E1.def.hasXAxis = true;
    a.tableData.E1.hAxis = { values: [] };
    const b = makeMap("B", [{ extId: "E1", id: "KF_A", grid: [[50, 60, 70]], xAxis: [0, 5, 10] }]);
    const r = compareMaps(a, b);
    assert.equal(r.counts.unchanged, 0);
    assert.equal(r.counts.incomparable, 1);
  });

  test("axis kind mismatch is incomparable even when the shapes agree", () => {
    const a = makeMap("A", [{ extId: "E1", id: "KF_A", grid: [[1, 2]] }]);
    const b = makeMap("B", [{ extId: "E1", id: "KF_A", grid: [[1, 9]], xAxis: [0, 10] }]);
    const r = compareMaps(a, b);
    assert.equal(r.counts.changed, 0);
    assert.equal(r.counts.incomparable, 1);
    assert.match(r.incomparable[0].reason ?? "", /axis kinds differ/);
  });

  test("a rows-less entry on the B side does not take down the whole comparison", () => {
    // The mirror of the A-side case below. B reaching the resample path with an
    // empty grid used to throw a TypeError out of compareMaps, failing every
    // other table in the map along with it.
    const a = makeMap("A", [
      { extId: "E1", id: "KF_OK", grid: [[1]] },
      { extId: "E2", id: "KF_BROKEN", grid: [[1, 2, 3]], xAxis: [0, 5, 10] },
    ]);
    const b = makeMap("B", [
      { extId: "E1", id: "KF_OK", grid: [[2]] },
      { extId: "E2", id: "KF_BROKEN", grid: [[9, 9, 9]], xAxis: [0, 6, 10] },
    ]);
    b.tableData.E2.rows = [];

    const r = compareMaps(a, b);
    assert.equal(r.counts.changed, 1);
    assert.equal(r.changed[0].id, "KF_OK");
    assert.equal(r.counts.incomparable, 1);
  });

  test("a table entry with no rows does not take down the whole comparison", () => {
    const a = makeMap("A", [
      { extId: "E1", id: "KF_A", grid: [[1]] },
      { extId: "E2", id: "KF_BROKEN", grid: [[1]] },
    ]);
    delete (a.tableData.E2 as { rows?: unknown }).rows;
    const b = makeMap("B", [
      { extId: "E1", id: "KF_A", grid: [[2]] },
      { extId: "E2", id: "KF_BROKEN", grid: [[2]] },
    ]);
    const r = compareMaps(a, b);
    assert.equal(r.counts.changed, 1);
    assert.equal(r.changed[0].id, "KF_A");
    assert.equal(r.counts.incomparable, 1);
  });

  test("onlyMainTables restricts both maps to their core tables", () => {
    const a = makeMap("A", [
      { extId: "E1", id: "MAIN", grid: [[1]], core: true },
      { extId: "E2", id: "HIDDEN", grid: [[1]] },
    ]);
    const b = makeMap("B", [
      { extId: "E1", id: "MAIN", grid: [[2]], core: true },
      { extId: "E2", id: "HIDDEN", grid: [[2]] },
    ]);

    const all = compareMaps(a, b);
    assert.equal(all.counts.tablesA, 2);
    assert.equal(all.counts.changed, 2);
    assert.equal(all.onlyMainTables, false);

    const main = compareMaps(a, b, { onlyMainTables: true });
    assert.equal(main.counts.tablesA, 1);
    assert.equal(main.counts.tablesB, 1);
    assert.equal(main.counts.changed, 1);
    assert.equal(main.changed[0].id, "MAIN");
    assert.equal(main.onlyMainTables, true);
  });

  test("a hidden table never lands in onlyInA/onlyInB when main-only is set", () => {
    const a = makeMap("A", [
      { extId: "E1", id: "MAIN", grid: [[1]], core: true },
      { extId: "E2", id: "HIDDEN_A", grid: [[1]] },
    ]);
    const b = makeMap("B", [{ extId: "E1", id: "MAIN", grid: [[1]], core: true }]);
    const main = compareMaps(a, b, { onlyMainTables: true });
    assert.equal(main.counts.onlyInA, 0);
    assert.equal(main.counts.onlyInB, 0);
  });

  test("an empty tiers array is rejected instead of matching nothing", () => {
    const a = makeMap("A", [{ extId: "E1", id: "KF_A", grid: [[1]] }]);
    const b = makeMap("B", [{ extId: "E1", id: "KF_A", grid: [[2]] }]);
    assert.throws(() => compareMaps(a, b, { tiers: [] }), /at least one matching tier/);
  });
});

// ---------------------------------------------------------------------------
// real cached maps — skipped when the cache is not present
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = process.env.BOOTMOD3_CACHE_DIR ?? path.join(__dirname, "..", "cache");

/** Two maps of the same ROM that differ only by a handful of tuner edits. */
const SAME_ROM_A = "6a5e49cdb463ec02e5bd5271";
const SAME_ROM_B = "6a5e4bd730cff63e7dd45525";
/** A different ROM entirely — renamed tables, shifted axes, extra tables. */
const OTHER_ROM = "6a174c6a333eba29db0877cf";

function loadCached(mapId: string): TableTreeLike | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `${mapId}.json`), "utf8")) as TableTreeLike;
  } catch {
    return null;
  }
}

const sameA = loadCached(SAME_ROM_A);
const sameB = loadCached(SAME_ROM_B);
const other = loadCached(OTHER_ROM);
const haveSameRom = !!sameA && !!sameB;
const haveCrossRom = !!sameA && !!other;

describe("cached real maps — same ROM", { skip: haveSameRom ? false : "cached maps not available" }, () => {
  const r = haveSameRom ? compareMaps(sameA!, sameB!) : null;

  test("every table matches on extId — no fallback tier is needed", () => {
    assert.equal(r!.counts.onlyInA, 0);
    assert.equal(r!.counts.onlyInB, 0);
    assert.equal(r!.counts.byTier.extId, r!.counts.matched);
    assert.equal(r!.counts.matched, r!.counts.tablesA);
  });

  test("only the handful of tuner-edited tables differ", () => {
    assert.ok(r!.counts.changed > 0, "expected some edited tables");
    assert.ok(r!.counts.changed < 20, `expected a small edit set, got ${r!.counts.changed}`);
    assert.equal(r!.counts.incomparable, 0);
  });

  test("the known edited tables are among the changes", () => {
    const ids = new Set(r!.changed.map((d) => d.id));
    for (const id of ["KF_ZW_PF1", "KF_ZW_S_PF1", "KF_LABAS_2", "FKKVS"]) {
      assert.ok(ids.has(id), `expected ${id} to be reported as changed`);
    }
  });

  test("a map compared against itself reports nothing", () => {
    const self = compareMaps(sameA!, sameA!);
    assert.equal(self.counts.changed, 0);
    assert.equal(self.counts.incomparable, 0);
    assert.equal(self.counts.unchanged, self.counts.matched);
  });

  test("every reported change carries a locatable maximum", () => {
    for (const d of r!.changed) {
      assert.ok(d.maxAt, `${d.id} has no maxAt`);
      assert.ok(d.changedCells > 0);
      assert.ok(d.cells.length > 0);
      assert.notEqual(d.maxDelta, null);
    }
  });
});

describe("cached real maps — cross ROM", { skip: haveCrossRom ? false : "cached maps not available" }, () => {
  const r = haveCrossRom ? compareMaps(sameA!, other!) : null;

  test("matching survives the ROM change on identifiers, not names", () => {
    // Roughly 2/3 of the shared tables are renamed between ROMs, so a
    // name-based comparison would lose most of them.
    assert.ok(r!.counts.matched > 2800, `expected >2800 matched, got ${r!.counts.matched}`);
    const renamed = r!.changed.filter((d) => d.nameB).length;
    assert.ok(renamed > 0, "expected renamed tables among the changes");
  });

  test("the name+shape tier recovers tables whose internal id was reissued", () => {
    // e.g. KFRKRMX1N in one ROM is RKRMX1V6NMAP in the other — same knock
    // threshold table, same shape and name, unrelated id. extId/id matching
    // alone drops these.
    const extIdOnly = compareMaps(sameA!, other!, { tiers: ["extId"] });
    assert.ok(
      r!.counts.matched > extIdOnly.counts.matched,
      "expected the fallback tiers to recover tables extId matching misses"
    );
    assert.ok((r!.counts.byTier["name+shape"] ?? 0) > 0, "expected name+shape matches");
  });

  test("the extra tables of the larger ROM land in onlyInB", () => {
    assert.ok(r!.counts.onlyInB > 1000, `expected many B-only tables, got ${r!.counts.onlyInB}`);
    assert.equal(r!.counts.matched + r!.counts.onlyInA, r!.counts.tablesA);
    assert.equal(r!.counts.matched + r!.counts.onlyInB, r!.counts.tablesB);
  });

  test("axis alignment changes the verdict on a substantial number of tables", () => {
    const naive = compareMaps(sameA!, other!, { alignAxes: false });
    const alignedChanged = new Set(r!.changed.map((d) => d.extId));
    const naiveChanged = new Set(naive.changed.map((d) => d.extId));

    const onlyAligned = [...alignedChanged].filter((k) => !naiveChanged.has(k));
    assert.ok(
      onlyAligned.length > 50,
      `expected axis alignment to expose many differences an index diff misses, got ${onlyAligned.length}`
    );

    // Those extra findings are real: the same cell values sitting on different
    // breakpoints mean the two tables deliver different values at the same
    // operating point. Every one of them must have been genuinely aligned.
    for (const extId of onlyAligned) {
      const d = r!.changed.find((x) => x.extId === extId)!;
      assert.equal(d.axisAligned, true, `${d.id} appeared only in the aligned diff without being aligned`);
      assert.equal(d.axesDiffer, true);
    }
  });

  test("alignment never makes a comparable table incomparable", () => {
    // Falling back to an index diff must keep coverage at least as good as
    // the naive mode's.
    const naive = compareMaps(sameA!, other!, { alignAxes: false });
    assert.ok(
      r!.counts.incomparable <= naive.counts.incomparable,
      `aligned mode lost coverage: ${r!.counts.incomparable} incomparable vs naive ${naive.counts.incomparable}`
    );
    assert.equal(r!.counts.changed + r!.counts.unchanged + r!.counts.incomparable, r!.counts.matched);
  });

  test("breakpoint drift is the common case and is reported as aligned", () => {
    const aligned = r!.changed.filter((d) => d.axisAligned).length;
    assert.ok(aligned > 100, `expected many axis-aligned comparisons, got ${aligned}`);
  });

  test("a same-shape axis-kind mismatch in real data is not silently diffed", () => {
    // KL_EGS_SOUND is 1x10 in both ROMs but only the B side declares an X axis.
    const d = [...r!.changed, ...r!.incomparable].find((t) => t.id === "KL_EGS_SOUND");
    assert.ok(d, "expected KL_EGS_SOUND to be matched");
    assert.equal(d!.comparable, false);
    assert.match(d!.reason ?? "", /axis kinds differ/);
  });

  test("main-tables-only restricts to what bootmod3 actually exposes", () => {
    const main = compareMaps(sameA!, other!, { onlyMainTables: true });
    // core === true is exactly tree membership and exactly the map's declared
    // total in both cached ROMs.
    assert.equal(main.counts.tablesA, 530);
    assert.equal(main.counts.tablesB, 538);
    assert.ok(main.counts.changed < r!.counts.changed);
    for (const d of main.changed) {
      assert.notEqual(d.path, "", `${d.id} is reported as a main table but has no folder path`);
    }
  });

  test("main-tables-only is a strict subset of the full comparison", () => {
    const main = compareMaps(sameA!, other!, { onlyMainTables: true });
    const fullChanged = new Set(r!.changed.map((d) => d.extId));
    for (const d of main.changed) {
      assert.ok(fullChanged.has(d.extId), `${d.id} changed in main-only but not in the full comparison`);
    }
  });

  test("changed tables are ranked by magnitude, so reductions are not buried", () => {
    const decreases = r!.changed.filter((d) => (d.maxDelta ?? 0) < 0);
    assert.ok(decreases.length > 100, `expected many reductions, got ${decreases.length}`);

    // The practical failure this guards: callers truncate to the first N, and
    // a signed sort put all 211 reductions below the default cutoff of 50.
    const top50 = r!.changed.slice(0, 50);
    assert.ok(
      top50.some((d) => (d.maxDelta ?? 0) < 0),
      "no reduction survived into the first 50 results"
    );

    for (let i = 1; i < r!.changed.length; i++) {
      const prev = r!.changed[i - 1];
      const cur = r!.changed[i];
      if (prev.maxDeltaSpanPct === null || cur.maxDeltaSpanPct === null) continue;
      assert.ok(
        prev.maxDeltaSpanPct >= cur.maxDeltaSpanPct,
        `ordering broke at ${i}: ${prev.id} (${prev.maxDeltaSpanPct}) before ${cur.id} (${cur.maxDeltaSpanPct})`
      );
    }
  });

  test("ranking is not hijacked by tables whose baseline is near zero", () => {
    // Percent-of-baseline peaks in the millions on this pair. Span percent is
    // far better behaved but not bounded by 100%: a handful of cross-ROM
    // tables hold values well outside their own declared min/max, so ranking
    // improves without becoming a clean 0-100 scale.
    const worstPct = Math.max(...r!.changed.map((d) => Math.abs(d.maxDeltaPct ?? 0)));
    assert.ok(worstPct > 1e6, "expected the absurd percent outliers to still exist in the data");
    for (const d of r!.changed.slice(0, 20)) {
      assert.notEqual(d.maxDeltaSpanPct, null, `${d.id} ranked in the top 20 without a span`);
    }
  });

  test("every changed table has a span percent, since every cached table has bounds", () => {
    for (const d of r!.changed) {
      assert.notEqual(d.maxDeltaSpanPct, null, `${d.id} has no calibratable span`);
    }
  });

  test("nothing is both matched and listed as unmatched", () => {
    const matchedExtIds = new Set([
      ...r!.changed.map((d) => d.extId),
      ...r!.incomparable.map((d) => d.extId),
    ]);
    for (const s of r!.onlyInA) {
      assert.equal(matchedExtIds.has(s.extId), false, `${s.extId} is both matched and onlyInA`);
    }
  });

  test("no matched pair is a nonsense pairing across unrelated ids", () => {
    // Every match at the id tiers must agree on the normalized id.
    for (const d of [...r!.changed, ...r!.incomparable]) {
      if (d.tier !== "id" && d.tier !== "id-normalized") continue;
      assert.ok(d.id, "id-tier match without an id");
    }
  });
});
