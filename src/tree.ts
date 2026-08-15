// The shape of bootmod3's /map/v2/tabletree payload, plus the two pure
// renderings of it that the tools use: a flat list and the folder-tree text.
//
// `compare.ts` deliberately declares its own narrower structural types
// (`TableTreeLike` and friends) rather than importing these. Keeping the two
// independent avoids a cycle and lets the comparison logic accept any
// tree-shaped object; the concrete API types below stay a superset of them.

export interface TableDef {
  id: string;
  extId: string;
  name: string;
  units?: string;
  hasXAxis: boolean;
  hasYAxis: boolean;
  xAxisName?: string;
  yAxisName?: string;
  xAxisUnits?: string;
  yAxisUnits?: string;
  min: number;
  max: number;
  columns: string;
  rows: string;
}

export interface TableEntry {
  def: TableDef & Record<string, unknown>;
  rows: Array<{ values: number[] }>;
  hAxis: { values: number[] };
  vAxis: { values: number[] };
}

export interface TreeNode {
  uid: number;
  name: string;
  total: number;
  nodes?: TreeNode[];
  tables?: TableDef[];
}

export interface TableTreeResponse {
  mapId: string;
  engineType: string;
  total: number;
  nodes: TreeNode[];
  tableData: Record<string, TableEntry>;
}

export interface FlatTable {
  id: string;
  name: string;
  extId: string;
  path: string;
  units?: string;
  hasXAxis: boolean;
  hasYAxis: boolean;
}

export function flattenNodes(nodes: TreeNode[], path = ""): FlatTable[] {
  const out: FlatTable[] = [];
  for (const node of nodes) {
    const p = path ? `${path} > ${node.name}` : node.name;
    for (const t of node.tables ?? []) {
      out.push({ id: t.id, name: t.name, extId: t.extId, path: p, units: t.units, hasXAxis: t.hasXAxis, hasYAxis: t.hasYAxis });
    }
    out.push(...flattenNodes(node.nodes ?? [], p));
  }
  return out;
}

export function buildTreeText(nodes: TreeNode[], indent = 0): string {
  let s = "";
  for (const node of nodes) {
    s += `${"  ".repeat(indent)}[${node.name}] (${node.total})\n`;
    for (const t of node.tables ?? []) {
      s += `${"  ".repeat(indent + 1)}- ${t.name} | extId: ${t.extId}${t.units ? ` | ${t.units}` : ""}\n`;
    }
    s += buildTreeText(node.nodes ?? [], indent + 1);
  }
  return s;
}
