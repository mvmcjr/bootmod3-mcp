import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import {
  isCorruptHighlightStore,
  parseDatalogCsv,
  parseHighlights,
  removeHighlight,
  resolveColumn,
  serializeHighlights,
  splitColumn,
  type DatalogHighlight,
  type ParsedDatalog,
} from "./datalog.js";

// ---------------------------------------------------------------------------
// synthetic fixtures — exact assertions real logs can't give us
// ---------------------------------------------------------------------------

describe("parseDatalogCsv", () => {
  test("a well-formed log becomes one numeric row per data line", () => {
    const dl = parseDatalogCsv("log1", "Time [s],RPM,Boost [psi]\n0.00,800,0.1\n0.05,1200,2.5\n");
    assert.deepEqual(dl.columns, ["Time [s]", "RPM", "Boost [psi]"]);
    assert.deepEqual(dl.rows, [
      [0, 800, 0.1],
      [0.05, 1200, 2.5],
    ]);
    assert.equal(dl.id, "log1");
  });

  test("header whitespace is trimmed so channel names match what the tools display", () => {
    const dl = parseDatalogCsv("log1", "Time [s] , RPM ,Boost [psi]\n0,800,0.1\n");
    assert.deepEqual(dl.columns, ["Time [s]", "RPM", "Boost [psi]"]);
  });

  test("trailing header tokens beyond the row width are dropped", () => {
    // bootmod3 appends metadata (app version, log hash) to the header line that
    // has no corresponding data column. Keeping them would shift every lookup
    // past the real channels and report a phantom channel in the summary.
    const dl = parseDatalogCsv("log1", "Time,RPM,v2.00.005,ab12cd\n0,800\n1,1500\n");
    assert.deepEqual(dl.columns, ["Time", "RPM"]);
    assert.deepEqual(dl.rows, [
      [0, 800],
      [1, 1500],
    ]);
  });

  test("an empty file yields an empty log instead of throwing", () => {
    // fetchDatalog hands whatever the endpoint returned straight to the parser,
    // so a zero-byte body must not take the tool call down.
    const dl = parseDatalogCsv("log1", "");
    assert.deepEqual(dl.columns, []);
    assert.deepEqual(dl.rows, []);
  });

  test("whitespace-only content yields an empty log", () => {
    const dl = parseDatalogCsv("log1", "\n\n\r\n");
    assert.deepEqual(dl.columns, []);
    assert.deepEqual(dl.rows, []);
  });

  test("a header with no data rows keeps the whole header", () => {
    // There is no row width to trim against, so every token is treated as a
    // channel — a zero-row log still reports what the logger was configured for.
    const dl = parseDatalogCsv("log1", "Time,RPM,Boost\n");
    assert.deepEqual(dl.columns, ["Time", "RPM", "Boost"]);
    assert.deepEqual(dl.rows, []);
  });

  test("CRLF line endings leave no carriage return in names or values", () => {
    // The logs are written on Windows; an unstripped \r would make the last
    // channel name unmatchable by resolveColumn.
    const dl = parseDatalogCsv("log1", "Time,RPM\r\n0,800\r\n1,1500\r\n");
    assert.deepEqual(dl.columns, ["Time", "RPM"]);
    assert.deepEqual(dl.rows, [
      [0, 800],
      [1, 1500],
    ]);
  });

  test("blank lines anywhere produce no phantom rows", () => {
    const dl = parseDatalogCsv("log1", "Time,RPM\n0,800\n\n1,1500\n\n\n");
    assert.equal(dl.rows.length, 2);
    assert.deepEqual(dl.rows[1], [1, 1500]);
  });

  test("a row with fewer fields than the header is padded with NaN", () => {
    // Logs get truncated mid-line when a session ends abruptly. The row must
    // still line up index-for-index with the columns, with the missing tail
    // reading as "no sample" rather than shifting later channels left.
    const dl = parseDatalogCsv("log1", "Time,RPM,Boost\n0,800,0.1\n1,1500\n");
    assert.equal(dl.rows[1].length, 3);
    assert.equal(dl.rows[1][0], 1);
    assert.equal(dl.rows[1][1], 1500);
    assert.ok(Number.isNaN(dl.rows[1][2]));
  });

  test("a non-numeric cell becomes NaN, which the stats tool skips", () => {
    const dl = parseDatalogCsv("log1", "Time,RPM\n0,---\n1,1500\n");
    assert.ok(Number.isNaN(dl.rows[0][1]));
    assert.equal(dl.rows[1][1], 1500);
  });
});

describe("splitColumn", () => {
  test("a trailing bracket is the unit", () => {
    assert.deepEqual(splitColumn("Boost [psi]"), { name: "Boost", unit: "psi" });
  });

  test("a column with no bracket has no unit at all", () => {
    // The key part is that `unit` is absent rather than an empty string — the
    // summary tool serializes these straight to JSON.
    assert.deepEqual(splitColumn("RPM"), { name: "RPM" });
  });

  test("a bracket in the middle stays part of the name", () => {
    // Only a trailing bracket denotes a unit. bootmod3 emits parenthetical
    // qualifiers like "(Target)" after a bracketed term, and splitting there
    // would leave a name that no longer matches the raw column.
    assert.deepEqual(splitColumn("Boost pressure [psi] (Target)"), {
      name: "Boost pressure [psi] (Target)",
    });
  });

  test("the leading name is trimmed of the space before the bracket", () => {
    assert.deepEqual(splitColumn("Ignition angle   [deg]"), { name: "Ignition angle", unit: "deg" });
  });
});

describe("resolveColumn", () => {
  const dl: ParsedDatalog = {
    id: "log1",
    columns: ["Time [s]", "Boost", "Boost pressure (Target)", "RPM"],
    rows: [],
  };

  test("an exact match wins over the substring matches it is contained in", () => {
    // "Boost" is a substring of "Boost pressure (Target)" too, so without the
    // exact-match pass first this query would be rejected as ambiguous and the
    // shorter channel would be unaddressable.
    assert.equal(resolveColumn(dl, "Boost"), 1);
  });

  test("matching is case-insensitive in both directions", () => {
    assert.equal(resolveColumn(dl, "rpm"), 3);
    assert.equal(resolveColumn(dl, "TIME [S]"), 0);
    assert.equal(resolveColumn(dl, "target"), 2);
  });

  test("a substring uniquely identifying one channel resolves to it", () => {
    assert.equal(resolveColumn(dl, "pressure"), 2);
  });

  test("no match throws and lists the available columns", () => {
    // The model calling the tool has no other way to discover the channel names
    // once it has guessed wrong, so the error has to carry them.
    assert.throws(
      () => resolveColumn(dl, "Knock"),
      (e: Error) => {
        assert.match(e.message, /No datalog column matching "Knock"/);
        for (const c of dl.columns) assert.ok(e.message.includes(c), `missing "${c}" in: ${e.message}`);
        return true;
      }
    );
  });

  test("an ambiguous substring throws rather than silently picking the first", () => {
    // Picking arbitrarily would report stats for a channel the caller did not
    // ask for, labelled with a name that looks right.
    assert.throws(
      () => resolveColumn(dl, "oost"),
      (e: Error) => {
        assert.match(e.message, /matches multiple columns/);
        assert.ok(e.message.includes("Boost"));
        assert.ok(e.message.includes("Boost pressure (Target)"));
        return true;
      }
    );
  });

  test("an empty log has no columns and every query fails", () => {
    assert.throws(() => resolveColumn({ id: "x", columns: [], rows: [] }, "Time"), /No datalog column/);
  });
});

describe("highlight store core", () => {
  const one: DatalogHighlight = {
    uid: "u1",
    time: 12.5,
    column: "Boost [psi]",
    value: 18.2,
    note: "overshoot",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const two: DatalogHighlight = { uid: "u2", time: 30, note: "knock", createdAt: "2026-01-01T00:01:00.000Z" };

  test("a missing file reads as no highlights, not as an error", () => {
    // readHighlights passes null when the file does not exist; highlights are a
    // local invention with no server behind them, so "never annotated" is the
    // normal state and must not fail list_datalog_highlights.
    assert.deepEqual(parseHighlights(null), []);
    assert.deepEqual(parseHighlights(undefined), []);
  });

  test("an unparseable file reads as no highlights", () => {
    assert.deepEqual(parseHighlights("{ truncated"), []);
  });

  test("valid JSON that is not an array also reads as no highlights", () => {
    // A file truncated to `null`, or hand-edited into an object, parses cleanly.
    // Passing it through would hand a non-array to add_datalog_highlight, which
    // pushes to it, and to list_datalog_highlights, which would print `null`.
    for (const raw of ["null", "{}", "5", '"a string"', "true"]) {
      assert.deepEqual(parseHighlights(raw), [], `expected [] for ${raw}`);
    }
  });

  test("a non-highlight element is dropped rather than reaching removeHighlight", () => {
    // removeHighlight reads h.uid, so one null element in an otherwise valid
    // array would throw a TypeError on delete.
    assert.deepEqual(parseHighlights(JSON.stringify([null, one, 5])), [one]);
  });

  test("corruption is distinguished from emptiness, so only real data is preserved", () => {
    // readHighlights renames the file aside when this is true. It must not fire
    // for a legitimately empty store, or every read would move the file.
    assert.equal(isCorruptHighlightStore(null), false);
    assert.equal(isCorruptHighlightStore(""), false);
    assert.equal(isCorruptHighlightStore("[]"), false);
    assert.equal(isCorruptHighlightStore(serializeHighlights([one, two])), false);

    assert.equal(isCorruptHighlightStore("{ truncated"), true);
    assert.equal(isCorruptHighlightStore("null"), true);
    assert.equal(isCorruptHighlightStore("{}"), true);
    assert.equal(isCorruptHighlightStore(JSON.stringify([null, one])), true);
  });

  test("a corrupt store still accepts a new highlight instead of throwing", () => {
    // The regression this guards: the result of parseHighlights is pushed to
    // directly by the add_datalog_highlight handler.
    const recovered = parseHighlights("null");
    recovered.push(one);
    assert.deepEqual(recovered, [one]);
  });

  test("serialize then parse round-trips the records unchanged", () => {
    assert.deepEqual(parseHighlights(serializeHighlights([one, two])), [one, two]);
  });

  test("the stored form is indented JSON, since it is hand-inspectable on disk", () => {
    assert.ok(serializeHighlights([one]).includes("\n  "));
  });

  test("removing a highlight returns the rest and leaves the input alone", () => {
    const before = [one, two];
    assert.deepEqual(removeHighlight(before, "u1", "log1"), [two]);
    assert.deepEqual(before, [one, two]);
  });

  test("removing a uid that is not there is an error naming the uid and log", () => {
    // Silently succeeding would tell the caller a highlight was deleted when
    // nothing changed — most likely because they had the wrong datalog id.
    assert.throws(() => removeHighlight([one], "nope", "log1"), (e: Error) => {
      assert.match(e.message, /No highlight with uid "nope" found for datalog log1/);
      return true;
    });
  });

  test("removing from an empty list is an error too", () => {
    assert.throws(() => removeHighlight([], "u1", "log1"), /No highlight with uid/);
  });
});

// ---------------------------------------------------------------------------
// real cached datalogs — skipped when the cache is not present
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = process.env.BOOTMOD3_CACHE_DIR ?? path.join(__dirname, "..", "cache");
const DATALOG_DIR = path.join(CACHE_DIR, "datalogs");

function loadCachedDatalogs(): Array<{ file: string; raw: string }> {
  try {
    return fs
      .readdirSync(DATALOG_DIR)
      .filter((f) => f.endsWith(".csv"))
      .map((f) => ({ file: f, raw: fs.readFileSync(path.join(DATALOG_DIR, f), "utf8") }));
  } catch {
    return [];
  }
}

const cachedLogs = loadCachedDatalogs();

describe(
  "cached real datalogs",
  { skip: cachedLogs.length > 0 ? false : "cached datalogs not available" },
  () => {
    const parsed = cachedLogs.map(({ file, raw }) => ({ file, raw, dl: parseDatalogCsv(file, raw) }));

    test("every row is exactly as wide as the column list", () => {
      // The whole point of trimming the header to the row width; if a real log
      // violates it, every index-based lookup downstream is off.
      for (const { file, dl } of parsed) {
        for (const row of dl.rows) assert.equal(row.length, dl.columns.length, `${file}: ragged row`);
      }
    });

    test("the column list never exceeds the raw header token count", () => {
      // Trimming may only remove tokens, never invent them.
      for (const { file, raw, dl } of parsed) {
        const headerTokens = raw.split("\n")[0].split(",").length;
        assert.ok(dl.columns.length <= headerTokens, `${file}: grew the header`);
      }
    });

    test("every channel name resolves to its own index by exact name", () => {
      for (const { file, dl } of parsed) {
        dl.columns.forEach((c) => {
          // Duplicate names can only resolve to the first occurrence, which is
          // what the exact-match pass promises.
          assert.equal(resolveColumn(dl, c), dl.columns.indexOf(c), `${file}: ${c}`);
        });
      }
    });

    test("splitting a real channel never produces an empty name", () => {
      for (const { file, dl } of parsed) {
        for (const c of dl.columns) {
          assert.ok(splitColumn(c).name.length > 0, `${file}: empty name from "${c}"`);
        }
      }
    });

    test("the time channel is first and non-decreasing", () => {
      // get_datalog_summary computes duration as last[0] - first[0] and the
      // series tool windows on column 0, both of which assume this.
      for (const { file, dl } of parsed) {
        if (dl.rows.length === 0) continue;
        for (let i = 1; i < dl.rows.length; i++) {
          assert.ok(dl.rows[i][0] >= dl.rows[i - 1][0], `${file}: time went backwards at row ${i}`);
        }
      }
    });
  }
);
