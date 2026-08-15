import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import { buildTreeText, flattenNodes, type TableDef, type TableTreeResponse, type TreeNode } from "./tree.js";

// ---------------------------------------------------------------------------
// synthetic fixtures — exact assertions the real cache can't give us
// ---------------------------------------------------------------------------

let nextUid = 1;

function tbl(name: string, extra: Partial<TableDef> = {}): TableDef {
  return {
    id: `ID_${name.replace(/\s+/g, "_").toUpperCase()}`,
    extId: `ext-${name}`,
    name,
    hasXAxis: false,
    hasYAxis: false,
    min: 0,
    max: 100,
    columns: "1",
    rows: "1",
    ...extra,
  };
}

function node(name: string, tables?: TableDef[], nodes?: TreeNode[]): TreeNode {
  return { uid: nextUid++, name, total: tables?.length ?? 0, tables, nodes };
}

describe("flattenNodes", () => {
  test("a top-level table's path is just its folder name", () => {
    const flat = flattenNodes([node("Boost", [tbl("Wastegate Duty")])]);
    assert.equal(flat.length, 1);
    assert.equal(flat[0].path, "Boost");
    assert.equal(flat[0].extId, "ext-Wastegate Duty");
    assert.equal(flat[0].id, "ID_WASTEGATE_DUTY");
  });

  test("nesting joins folder names with ' > ' at every depth", () => {
    // search_tables reports this path verbatim; it is the only way the caller
    // can tell two same-named tables in different folders apart.
    const tree = [node("Boost", undefined, [node("Boost Control", undefined, [node("Correction Factor", [tbl("Ambient")])])])];
    assert.deepEqual(
      flattenNodes(tree).map((t) => t.path),
      ["Boost > Boost Control > Correction Factor"]
    );
  });

  test("a node carrying both tables and children emits its own tables first", () => {
    const tree = [node("Fuel", [tbl("Injector Scaling")], [node("Lambda", [tbl("Target AFR")])])];
    assert.deepEqual(
      flattenNodes(tree).map((t) => [t.name, t.path]),
      [
        ["Injector Scaling", "Fuel"],
        ["Target AFR", "Fuel > Lambda"],
      ]
    );
  });

  test("sibling subtrees do not inherit each other's paths", () => {
    const tree = [node("A", [tbl("t1")], [node("A1", [tbl("t2")])]), node("B", [tbl("t3")])];
    assert.deepEqual(
      flattenNodes(tree).map((t) => t.path),
      ["A", "A > A1", "B"]
    );
  });

  test("empty input and empty folders contribute nothing", () => {
    assert.deepEqual(flattenNodes([]), []);
    // A folder with neither `tables` nor `nodes` is common in the real payload.
    assert.deepEqual(flattenNodes([node("Empty"), node("AlsoEmpty", [], [])]), []);
  });

  test("axis flags and units are carried through for the search results", () => {
    const flat = flattenNodes([node("Ignition", [tbl("KF", { units: "deg", hasXAxis: true, hasYAxis: true })])]);
    assert.equal(flat[0].units, "deg");
    assert.equal(flat[0].hasXAxis, true);
    assert.equal(flat[0].hasYAxis, true);
  });

  test("a table without units reports undefined rather than an empty string", () => {
    // The flat entries are serialized straight to JSON, where an absent key and
    // an empty string read very differently to the model consuming them.
    const flat = flattenNodes([node("Misc", [tbl("Unitless")])]);
    assert.equal(flat[0].units, undefined);
  });
});

describe("buildTreeText", () => {
  test("a folder line carries its declared total, not its rendered table count", () => {
    // `total` counts the whole subtree, so it deliberately exceeds the number
    // of table lines printed directly beneath the folder.
    const n = node("Boost", [tbl("Wastegate Duty")]);
    n.total = 42;
    assert.equal(buildTreeText([n]), "[Boost] (42)\n  - Wastegate Duty | extId: ext-Wastegate Duty\n");
  });

  test("units are appended only when the table has them", () => {
    const text = buildTreeText([node("Ignition", [tbl("KF", { units: "deg" }), tbl("Flag")])]);
    assert.equal(
      text,
      "[Ignition] (2)\n" +
        "  - KF | extId: ext-KF | deg\n" +
        "  - Flag | extId: ext-Flag\n"
    );
  });

  test("each level of nesting adds two spaces, tables one level deeper than their folder", () => {
    const tree = [node("A", [tbl("t1")], [node("B", [tbl("t2")], [node("C", [tbl("t3")])])])];
    assert.deepEqual(buildTreeText(tree).split("\n").slice(0, -1), [
      "[A] (1)",
      "  - t1 | extId: ext-t1",
      "  [B] (1)",
      "    - t2 | extId: ext-t2",
      "    [C] (1)",
      "      - t3 | extId: ext-t3",
    ]);
  });

  test("an empty folder still prints its own line", () => {
    // get_map_tree is how the caller learns the folder exists at all.
    assert.equal(buildTreeText([node("Empty")]), "[Empty] (0)\n");
  });

  test("no nodes produce no text", () => {
    assert.equal(buildTreeText([]), "");
  });
});

// ---------------------------------------------------------------------------
// real cached maps — skipped when the cache is not present
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = process.env.BOOTMOD3_CACHE_DIR ?? path.join(__dirname, "..", "cache");

/** The same baseline map compare.test.ts uses. */
const BASELINE = "6a5e49cdb463ec02e5bd5271";

function loadCached(mapId: string): TableTreeResponse | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `${mapId}.json`), "utf8")) as TableTreeResponse;
  } catch {
    return null;
  }
}

const baseline = loadCached(BASELINE);

describe("cached real map", { skip: baseline ? false : "cached maps not available" }, () => {
  const map = baseline!;
  const flat = baseline ? flattenNodes(map.nodes) : [];

  test("the flattened tree has exactly the map's declared total, with no duplicates", () => {
    // The folder tree holds only the main tables — the rest of tableData is
    // hidden internals — and `total` is the count bootmod3 itself reports.
    assert.equal(flat.length, map.total);
    assert.equal(new Set(flat.map((t) => t.extId)).size, flat.length);
  });

  test("every flattened table is resolvable in tableData", () => {
    // search_tables hands these extIds back for get_table to look up.
    for (const t of flat) assert.ok(map.tableData[t.extId], `missing tableData for ${t.extId}`);
  });

  test("no path is empty or has a blank segment", () => {
    for (const t of flat) {
      assert.ok(t.path.length > 0);
      for (const seg of t.path.split(" > ")) assert.ok(seg.trim().length > 0, `blank segment in "${t.path}"`);
    }
  });

  test("the tree text prints one line per folder and one per table", () => {
    const lines = buildTreeText(map.nodes).split("\n").slice(0, -1);
    const tableLines = lines.filter((l) => /^ *- /.test(l));
    const folderLines = lines.filter((l) => /^ *\[/.test(l));
    assert.equal(tableLines.length, flat.length);
    assert.equal(folderLines.length + tableLines.length, lines.length);
    const countNodes = (nodes: TreeNode[]): number =>
      nodes.reduce((n, node) => n + 1 + countNodes(node.nodes ?? []), 0);
    assert.equal(folderLines.length, countNodes(map.nodes));
  });
});
