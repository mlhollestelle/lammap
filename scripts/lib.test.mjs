// node --test scripts/*.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  countBy, dateWindow, fromKey, key, localDayHour, localToday, merge, mergeDirs, onePerPlace, parseArgs, withRetry,
} from "./lib.mjs";

test("parseArgs takes values, =values and bare flags", () => {
  assert.deepEqual(parseArgs(["--days", "7", "--out=data", "--skip-existing", "--keep", "30"]),
    { days: "7", out: "data", "skip-existing": true, keep: "30" });
  assert.deepEqual(parseArgs(["--skip-existing"]), { "skip-existing": true });
  assert.throws(() => parseArgs(["days"]), /Unknown argument/);
});

test("localToday uses the local calendar day", () => {
  // 21:30 UTC is already the next day in Helsinki (UTC+3 in summer), not yet in Oslo (UTC+2).
  const now = new Date("2026-06-30T21:30:00Z");
  assert.equal(key(localToday("Europe/Helsinki", now)), "20260701");
  assert.equal(key(localToday("Europe/Oslo", now)), "20260630");
});

test("dateWindow ends yesterday and counts days inclusively", () => {
  const w = dateWindow("Europe/Helsinki", 7, 366, new Date("2026-03-10T12:00:00Z"));
  assert.equal(key(w.END), "20260309");
  assert.equal(key(w.START), "20260303");
  assert.equal(w.OLDEST_KEPT, "20250309");
});

test("fromKey is the inverse of key", () => {
  assert.equal(key(fromKey("20261029")), "20261029");
});

test("localDayHour gives local day and hour across DST changes", () => {
  const dayHour = localDayHour("Europe/Helsinki");
  assert.deepEqual(dayHour(new Date("2026-10-16T20:00:00Z")), ["20261016", 23]);
  assert.deepEqual(dayHour(new Date("2026-10-16T21:00:00Z")), ["20261017", 0]);
  // Autumn change on 25 October 2026: both 03:00 hours land in hour 3.
  assert.deepEqual(dayHour(new Date("2026-10-25T00:00:00Z")), ["20261025", 3]);
  assert.deepEqual(dayHour(new Date("2026-10-25T01:00:00Z")), ["20261025", 3]);
});

test("merge replaces fetched days, keeps the rest, drops old days and sorts", () => {
  const stored = { 20240101: [1], 20250105: [5], 20250103: [3] };
  const fetched = new Map([["20250103", [30]], ["20250104", [40]]]);
  const out = merge(stored, fetched, "20250102");
  assert.deepEqual(out, { 20250103: [30], 20250104: [40], 20250105: [5] });
  assert.deepEqual(Object.keys(out), ["20250103", "20250104", "20250105"]);
  assert.deepEqual(merge(undefined, fetched, "20250101"), { 20250103: [30], 20250104: [40] });
});

test("mergeDirs merges all, d1 and d2", () => {
  const maps = { all: new Map(), d1: new Map([["20250102", [1]]]), d2: new Map() };
  assert.deepEqual(mergeDirs({ d2: { 20250101: [2] } }, maps, "20250101"),
    { all: {}, d1: { 20250102: [1] }, d2: { 20250101: [2] } });
});

test("onePerPlace keeps the counter with most days per mode and position", () => {
  const a = { id: 1, mode: "bike", lat: 60.1, lon: 24.9, days: 10 };
  const b = { id: 2, mode: "bike", lat: 60.1000001, lon: 24.9, days: 20 };
  const c = { id: 3, mode: "pedestrian", lat: 60.1, lon: 24.9, days: 5 };
  assert.deepEqual(onePerPlace([a, b, c]), [b, c]);
});

test("countBy summarises a field", () => {
  assert.equal(countBy([{ mode: "bike" }, { mode: "car" }, { mode: "bike" }], "mode"), "2 bike, 1 car");
});

test("withRetry retries transient errors and gives up on others", async () => {
  let calls = 0;
  const value = await withRetry(async () => {
    if (++calls < 3) throw Object.assign(new Error("HTTP 503"), { retry: true });
    return "ok";
  }, { delay: () => 1 });
  assert.equal(value, "ok");
  assert.equal(calls, 3);

  calls = 0;
  await assert.rejects(withRetry(async () => { calls++; throw new Error("HTTP 404"); }, { delay: () => 1 }), /404/);
  assert.equal(calls, 1);

  calls = 0;
  await assert.rejects(withRetry(async () => { calls++; throw new TypeError("fetch failed"); }, { tries: 2, delay: () => 1 }), /fetch failed/);
  assert.equal(calls, 2);
});

test("localHourCounts counts each local hour of a day", async () => {
  const { localHourCounts } = await import("./lib.mjs");
  const spring = localHourCounts("Europe/Zurich", "20260329");
  assert.equal(spring[2], 0);
  assert.equal(spring.reduce((a, b) => a + b), 23);
  const autumn = localHourCounts("Europe/Zurich", "20261025");
  assert.equal(autumn[2], 2);
  assert.equal(autumn.reduce((a, b) => a + b), 25);
  assert.deepEqual(localHourCounts("Europe/Zurich", "20260601"), Array(24).fill(1));
});

test("splitCsv handles quotes, empty fields and other separators", async () => {
  const { splitCsv } = await import("./lib.mjs");
  assert.deepEqual(splitCsv('"Z001","Seestrasse (A, B)",2683009.89,,"say ""hi"""'),
    ["Z001", "Seestrasse (A, B)", "2683009.89", "", 'say "hi"']);
  assert.deepEqual(splitCsv("a;b;;", ";"), ["a", "b", "", ""]);
  assert.deepEqual(splitCsv('1;"x;y";2', ";"), ["1", "x;y", "2"]);
});

test("csvRows streams rows across chunk boundaries", async () => {
  const { csvRows } = await import("./lib.mjs");
  const enc = new TextEncoder();
  const body = ["﻿a,b\r\n1,", "2\r\n3,4", "\r\n"].map((s) => enc.encode(s));
  const rows = [];
  for await (const r of csvRows(body)) rows.push(r);
  assert.deepEqual(rows, [{ a: "1", b: "2" }, { a: "3", b: "4" }]);
});

test("lv95ToWgs84 is within a few metres", async () => {
  const { lv95ToWgs84 } = await import("./lib.mjs");
  // swisstopo's worked example: 2700000 / 1100000 is 46°02'38.87" N, 8°43'49.79" E.
  const q = lv95ToWgs84(2700000, 1100000);
  assert.ok(Math.abs(q.lat - 46.04413) < 0.00002 && Math.abs(q.lon - 8.73050) < 0.00002);
});

test("HourTally keeps complete days only", async () => {
  const { HourTally } = await import("./lib.mjs");
  const t = new HourTally();
  for (let h = 0; h < 24; h++) {
    t.add("a", "in", "20260601", h, 2);
    t.add("a", "out", "20260601", h, 1);
    t.add("a", "in", "20260602", h, 2);
    // out misses an hour on the 2nd, and reports its count as missing on the 3rd
    if (h !== 5) t.add("a", "out", "20260602", h, 1);
    t.add("a", "in", "20260603", h, 2);
    t.add("a", "out", "20260603", h, h === 7 ? null : 1);
    // on the 4th only "in" has rows at all
    t.add("a", "in", "20260604", h, 2);
  }
  const dirs = { d1: ["in"], d2: ["out"] };
  const d = t.days("a", { timeZone: "Europe/Zurich", from: "20260601", to: "20260630", dirs });
  assert.deepEqual([...d.all.keys()], ["20260601"]);
  assert.equal(d.all.get("20260601")[24], 72);
  assert.equal(d.d2.get("20260601")[24], 24);
  // without directions, the 4th counts as a day of "in" only
  assert.deepEqual([...t.days("a", { timeZone: "Europe/Zurich", from: "20260601", to: "20260630" }).all.keys()], ["20260601", "20260604"]);
});
