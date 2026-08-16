# AGENTS.md

Guidance for coding agents working in this repository.

## What this is

A stdio MCP server wrapping the [bootmod3](https://www.bootmod3.net) ECU map editor
for a BMW N20. It exposes 15 tools: 7 for maps and tables, 1 for comparing two
maps, and 7 for OBD datalogs. See `docs/tools-architecture.html` for the shape of
the whole thing.

- `src/index.ts` — every tool registration, HTTP, and file caching.
- `src/compare.ts` — pure comparison logic, no I/O. Exists separately so it is testable.
- `src/datalog.ts` — pure CSV parsing, channel resolution, highlight (de)serialization.
- `src/tree.ts` — the tabletree payload types plus `flattenNodes` / `buildTreeText`.
- `src/*.test.ts` — `node:test`, 117 tests with a populated map cache, plus 5
  real-datalog invariants that run only when `cache/datalogs` is populated.
  Run `npm test` for the current count rather than trusting this line.

```
npm run build     # tsc → dist/
npm test          # tsc, then node --test on dist/**/*.test.js
```

## Credentials — read this before touching anything

Two env vars are required and the server exits without them:

| Var | Source |
|---|---|
| `BOOTMOD3_token` | browser `localStorage.token` → `Authorization: Bearer` |
| `BOOTMOD3_access_token` | browser `localStorage.access_token` → `jwt` header |

Both are Auth0 JWTs with year-long expiries that decode to the owner's email and
Auth0 subject. Treat them as live secrets.

`methods.md` is raw curl captures from the bootmod3 web app and **contains real
tokens in plaintext**. It is gitignored. Do not un-ignore it, do not paste
excerpts from it into commits, issues, or tool output, and do not add new capture
files without scrubbing them first.

`cache/` is also gitignored — the map payloads carry the vehicle's VIN and ROM
identifiers, and the directory runs to several hundred MB.

## Working with the cache

`cache/` holds real fetched map trees, and they are the best test fixtures in the
project. Two maps of the same ROM differ by a handful of tuner edits; a map from a
different ROM differs structurally. Tests read them directly and skip when absent,
so a fresh clone still passes.

Named in `src/compare.test.ts`:

| Map id | Engine | Role |
|---|---|---|
| `6a5e49cdb463ec02e5bd5271` | N20-EWG-H-P | baseline |
| `6a5e4bd730cff63e7dd45525` | N20-EWG-H-P | same ROM, ~6 tuner edits |
| `6a174c6a333eba29db0877cf` | N20-EWG-L-9 | different ROM, 4839 tables |

Prefer real cached maps over invented fixtures when validating comparison
behavior. Twice during development a change looked correct against synthetic data
and was wrong against the cache. Synthetic fixtures are still right for asserting
exact numbers — use both.

## Facts about the data that are not obvious

These were established by measurement against the cache, not by reading docs.
They are easy to get wrong from first principles.

- **`extId` and `id` are both stable across ROMs.** On 2919 id-matched pairs
  between two different ROMs, zero had a differing `extId`.
- **Names are not identifiers.** They are translated descriptions and ~2/3 of
  them differ between ROMs for the same table. Never match on name alone without
  a shape and units guard; distinct tables genuinely share names (two "Torque"
  entries differing only by scale-code index).
- **Axis breakpoints drift constantly.** 2525 of 2919 cross-ROM matched pairs
  have different axes. Comparing `cell[i][j]` across them compares unrelated
  operating points. This is why `compare_maps` resamples before diffing.
- **Only `hasXAxis` / `hasYAxis` mark real axes.** Every table carries `hAxis` and
  `vAxis` arrays; when the flag is false the contents are padding (repeated `48`s
  and similar). Never interpolate on an unflagged axis.
- **`def.core === true` marks the "main" tables** — exactly the ones bootmod3
  shows in its folder tree, and exactly `map.total`. 530 of 3046 in one ROM, 538
  of 4839 in another. The rest is hidden internals.
- **Percent-of-baseline is useless for ranking across tables.** Near-zero
  baselines produce values in the millions, and a zero baseline produces none at
  all. Rank by `def.max - def.min` span instead.
- **`rows.length === vAxis.length`** and `rows[i].values.length === hAxis.length`.

## Conventions

- Comments explain **why**, especially where a simpler implementation was
  rejected for a measured reason. Do not add comments that restate the code.
- Tool descriptions are the only documentation the model calling them ever sees.
  State what the tool does *and* the non-obvious constraint (`rename_map` must
  pass through unchanged fields because the API overwrites the whole record).
- Output is capped and the cap is reported. A cross-ROM comparison finds 400+
  changed tables; truncating silently reads as "that's all of them". When you add
  a limit, add the "N more not shown" line with it.
- Keep comparison logic in `compare.ts` pure. If it needs `fs` or `fetch`, it
  belongs in `index.ts`.

## Cautions

- **`save_tables` writes to a real vehicle's tune.** It is not a sandbox. Do not
  call it to test something; use the cache. It is also the only cache invalidator.
- **Endpoints answer HTTP 200 with bodies that mean failure.** Two known cases,
  both guarded, and both guards should stay:
  - `save` returns 200 without a `saveId` when the save did not apply.
  - `tabletree` returns `{"uid":1,"locked":true}` for a locked map. Caching that
    made every tool fail on that map forever with "nodes is not iterable", since
    the cache is only cleared by a successful save and a locked map cannot be
    saved. `isTableTree` now rejects it on both the network and disk-read paths.
  Assume any new endpoint does the same. Validate the shape before caching.
- Datalog highlights are a local invention stored in `cache/datalogs/*.highlights.json`.
  No bootmod3 endpoint backs them.
- Nothing in this project has been exercised against the live API by an agent so
  far; every validation to date used the disk cache. Say so plainly rather than
  implying otherwise.
