# bootmod3-mcp

An MCP server for the [bootmod3](https://www.bootmod3.net) ECU map editor. Gives an
MCP client read and write access to your BMW's tuning tables and OBD datalogs, so
you can ask questions like *"what changed between these two maps?"* or *"where did
this log knock?"* instead of clicking through the web editor.

Built against an N20 (`N20-EWG-*`). Other engines will likely work — nothing is
hardcoded to a ROM — but they are untested.

> **This writes to a real vehicle's tune.** `save_tables` is not a sandbox. Read
> [Safety](#safety) before using it.

## Tools

Fifteen tools in three groups. See `docs/tools-architecture.html` for how they fit
together.

### Maps and tables

| Tool | What it does |
|---|---|
| `list_maps` | All maps on your account: id, name, engine, stock flag, tuner |
| `get_map_tree` | Folder tree of tables for one map |
| `search_tables` | Find tables by display name |
| `find_table_by_id` | Find tables by internal id (`KF_ZW_PF1`) |
| `get_table` | One table's values, axes, units, and bounds |
| `save_tables` | Write modified values back |
| `rename_map` | Rename a map or change its description |

### Comparison

| Tool | What it does |
|---|---|
| `compare_maps` | Diff two maps, table by table |

### Datalogs

| Tool | What it does |
|---|---|
| `list_datalogs` | All saved OBD logs |
| `get_datalog_summary` | Row count, duration, available channels |
| `get_datalog_stats` | min/max/avg per channel, with the timestamp of each extreme |
| `get_datalog_series` | Time-series values, windowed and downsampled |
| `add_datalog_highlight` | Annotate a moment (knock event, boost spike) |
| `list_datalog_highlights` | List annotations |
| `delete_datalog_highlight` | Remove one |

## Requirements

- Node.js 22 or newer
- A bootmod3 account with at least one map

## Install

```bash
git clone https://github.com/mvmcjr/bootmod3-mcp.git
cd bootmod3-mcp
npm install
npm run build
```

## Credentials

The server needs two values that bootmod3's web app keeps in browser
`localStorage`. There is no OAuth flow — you copy them out by hand.

1. Log in at [bootmod3.net](https://www.bootmod3.net).
2. Open DevTools → **Application** → **Local Storage** → `https://www.bootmod3.net`.
3. Copy the values of `token` and `access_token`.

| Env var | localStorage key | Sent as |
|---|---|---|
| `BOOTMOD3_token` | `token` | `Authorization: Bearer …` |
| `BOOTMOD3_access_token` | `access_token` | `jwt: …` |

The server exits immediately if either is missing, and verifies them against the
API on startup.

Both are Auth0 JWTs that decode to your email and account id, and they stay valid
for a long time. Treat them like passwords — don't commit them, don't paste them
into issues.

Optional:

| Env var | Effect |
|---|---|
| `BOOTMOD3_CACHE_DIR` | Where to keep cached maps and logs (default: `./cache`) |
| `BOOTMOD3_DEBUG=1` | Log every request and response to stderr |

## Connect it to a client

### Claude Code

```bash
claude mcp add bootmod3 \
  --env BOOTMOD3_token=YOUR_TOKEN \
  --env BOOTMOD3_access_token=YOUR_ACCESS_TOKEN \
  -- node /absolute/path/to/bootmod3-mcp/dist/index.js
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "bootmod3": {
      "command": "node",
      "args": ["/absolute/path/to/bootmod3-mcp/dist/index.js"],
      "env": {
        "BOOTMOD3_token": "YOUR_TOKEN",
        "BOOTMOD3_access_token": "YOUR_ACCESS_TOKEN"
      }
    }
  }
}
```

Use an absolute path — the server is launched from an arbitrary working directory.

### Run it directly

```bash
BOOTMOD3_token=… BOOTMOD3_access_token=… npm start
```

It speaks MCP over stdio, so on its own it will just sit there waiting. Useful for
checking that auth works: it prints `[bootmod3] auth OK` to stderr.

## Comparing maps

`compare_maps` is the reason this project exists, and it is doing more than a
field-by-field diff.

**Tables are matched in tiers**, strongest identifier first: `extId`, then `id`,
then a normalized `id`, then name + units + shape. A single identifier is not
enough — between two ROMs a table's internal id can be reissued while the table
itself is unchanged (`KFRKRMX1N` in one ROM is `RKRMX1V6NMAP` in another; same
4×16 knock threshold table). Matching on display name alone is off by default,
because names are translated descriptions and distinct tables share them.

**Values are compared at the same operating points, not the same array indices.**
Axis breakpoints drift constantly between maps — on one cross-ROM pair, 2525 of
2919 matched tables had different axes. Map B is bilinearly resampled onto map A's
axes before diffing, clamped at the edges so nothing is extrapolated past its
calibrated range.

**Changed tables are ranked by how far a value moved through its own calibratable
range**, not by percent change. Percent is unusable for ranking across tables: a
near-zero baseline produces percentages in the millions, and a baseline of exactly
zero produces none at all.

Useful arguments:

| Argument | Why you'd use it |
|---|---|
| `onlyMainTables: true` | Restrict to the ~530 tables bootmod3 shows in its UI, skipping ~2500 hidden internals |
| `mode: "cells"` | Include individual changed cells with their RPM/load coordinates |
| `filter: "ignition"` | Only tables whose id, name, or folder matches |
| `alignAxes: false` | Compare strictly by cell index instead |

Example — comparing two revisions of the same tune:

```
6 changed tables of 3046

KF_ZW_S_PF1  Base Ignition Timing (Full Load - Cold)  51/320  max -10.500 (-80.8%) at 6950rpm, 200
KF_ZW_PF1    Base Ignition Timing (Full Load - Warm)  55/320  max  -2.000 (-20.0%) at 2750rpm, 130
FKKVS        Correction Factor                        96/96   max  -0.053  (-4.8%)
KF_LABAS_2   Lambda Target Bank 2                     60/306  max  -0.035  (-3.9%)
```

## Caching

Map trees are large (25–35 MB of JSON each), so they are cached per map id in
memory and on disk under `cache/`. `save_tables` is the only thing that
invalidates them. Datalog CSVs are cached permanently, since a log never changes
once recorded.

Datalog highlights are a local invention — they live in
`cache/datalogs/<id>.highlights.json` and no bootmod3 endpoint backs them.

`cache/` is gitignored. The map payloads contain your VIN and ROM identifiers.

## Development

```bash
npm run build     # tsc → dist/
npm run dev       # tsc --watch
npm test          # build, then run the test suite
```

117 tests. The pure logic lives in `src/compare.ts` (map diffing), `src/datalog.ts`
(CSV parsing, channel resolution) and `src/tree.ts` (tabletree types and
traversal) — none of them touch `fs` or `fetch`, which is what makes them
testable. Everything that does I/O stays in `src/index.ts`.

Tests run against both synthetic fixtures and real cached maps. The cached-map
tests skip automatically when `cache/` is empty, so a fresh clone passes — but if
you have maps cached, they will run and they are the ones that catch real bugs.

If you are working on this with a coding agent, `AGENTS.md` documents the
non-obvious properties of bootmod3's data model.

## Safety

- `save_tables` writes to your actual vehicle's tune. Verify what you're sending.
- The save endpoint can return HTTP 200 on a failed save. A real success always
  includes a `saveId`; this server treats a missing one as an error rather than
  reporting a save that didn't happen.
- Nothing here validates that a value is *safe* for your engine — only that it is
  within the table's declared bounds. Bad ignition timing destroys engines.
- Keep a known-good map on your account to roll back to.

## License

None specified. Not affiliated with or endorsed by bootmod3.
