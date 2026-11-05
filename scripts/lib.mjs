// Helpers shared by the ingest scripts: arguments, local dates, rate-limited fetching with retries,
// and merging fetched days into the stored per-station files.

import { readFile } from "node:fs/promises";

// ---------- arguments ----------
// "--days 7", "--days=7", and flags without a value (e.g. --skip-existing), which are true.
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([\w-]+)(?:=(.*))?$/);
    if (!m) throw new Error(`Unknown argument: ${argv[i]}`);
    out[m[1]] = m[2] ?? (argv[i + 1] === undefined || argv[i + 1].startsWith("--") ? true : argv[++i]);
  }
  return out;
}

// ---------- dates ----------
// Dates are UTC midnights standing for a local calendar day; keys are YYYYMMDD.
export function localToday(timeZone, now = new Date()) {
  // en-CA formats as YYYY-MM-DD
  const s = new Intl.DateTimeFormat("en-CA", { timeZone }).format(now);
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
export function addDays(date, n) { return new Date(date.getTime() + n * 86400000); }
export function iso(date) { return date.toISOString().slice(0, 10); }
export function key(date) { return iso(date).replace(/-/g, ""); }
export function fromKey(k) { return new Date(Date.UTC(+k.slice(0, 4), +k.slice(4, 6) - 1, +k.slice(6, 8))); }

// The days to (re)fetch, ending yesterday, and the oldest day key to keep.
export function dateWindow(timeZone, days, keep, now = new Date()) {
  const END = addDays(localToday(timeZone, now), -1);
  return { END, START: addDays(END, -(days - 1)), OLDEST_KEPT: key(addDays(END, -(keep - 1))) };
}

// Returns a function that gives the local [YYYYMMDD, hour] of an instant. On the autumn DST change
// both repeated hours give the same hour.
export function localDayHour(timeZone) {
  const f = new Intl.DateTimeFormat("sv-SE", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  });
  return (date) => {
    const s = f.format(date); // "2026-10-16 23"
    return [s.slice(0, 10).replace(/-/g, ""), Number(s.slice(11, 13))];
  };
}

// ---------- fetch ----------
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Returns a function to await before each request, which keeps at least minGapMs between them.
export function throttle(minGapMs) {
  let last = 0;
  return async () => {
    const gap = last + minGapMs - Date.now();
    if (gap > 0) await sleep(gap);
    last = Date.now();
  };
}

// fetch with a timeout (which also covers reading the body), after waiting for the throttle if there is one.
export async function timedFetch(url, init = {}, wait, timeoutMs = 120_000) {
  await wait?.();
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

export function httpError(res) {
  return Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, retry: res.status === 429 || res.status >= 500 });
}

// Runs attempt() until it succeeds, retrying errors marked { retry: true } and network errors and
// timeouts, with delay(err) × 1, 2, 4, ... between tries.
export async function withRetry(attempt, { tries = 4, delay = () => 5_000 } = {}) {
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (err) {
      const retry = err.retry ?? (err.name === "TimeoutError" || err.name === "TypeError");
      if (!retry || i + 1 >= tries) throw err;
      const ms = delay(err) * 2 ** i;
      console.log(`  ${err.message}, retrying in ${ms / 1000}s`);
      await sleep(ms);
    }
  }
}

export function fetchJson(url, { init, wait, tries } = {}) {
  return withRetry(async () => {
    const res = await timedFetch(url, init, wait);
    if (!res.ok) throw httpError(res);
    return res.json();
  }, { tries });
}

// ---------- merge ----------
export async function readJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return null; throw e; }
}

// Fetched days (a Map) replace stored ones (an object); stored days the new fetch lacks are kept.
// Days before oldestKept are dropped, and the result is sorted by day.
export function merge(stored = {}, fetched, oldestKept) {
  const out = {};
  for (const [k, v] of Object.entries(stored)) if (k >= oldestKept) out[k] = v;
  for (const [k, v] of fetched) if (k >= oldestKept) out[k] = v;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

// The same for a station's "all", "d1" and "d2" maps.
export function mergeDirs(stored = {}, maps, oldestKept) {
  const out = {};
  for (const d of ["all", "d1", "d2"]) out[d] = merge(stored[d], maps[d], oldestKept);
  return out;
}

// ---------- station lists ----------
// Some devices are listed twice at the same position with more or less the same data. Keeps the one
// with the most days per mode and position.
export function onePerPlace(list) {
  const best = new Map();
  for (const s of list) {
    const at = `${s.mode}:${s.lat.toFixed(5)},${s.lon.toFixed(5)}`;
    if (!best.has(at) || s.days > best.get(at).days) best.set(at, s);
  }
  const kept = new Set(best.values());
  return list.filter((s) => kept.has(s));
}

// "12 bike, 3 pedestrian" for field "mode".
export function countBy(list, field) {
  const n = list.reduce((a, s) => ({ ...a, [s[field]]: (a[s[field]] ?? 0) + 1 }), {});
  return Object.entries(n).map(([v, c]) => `${c} ${v}`).join(", ");
}

// ---------- local days ----------
// How many times each hour 0..23 occurs on local day k (YYYYMMDD): 1, except 0 for 02 on the spring DST
// day and 2 for 02 on the autumn one. A day is complete when it has a count for each occurrence.
export function localHourCounts(timeZone, k) {
  const dayHour = localDayHour(timeZone);
  const counts = Array(24).fill(0);
  const t0 = fromKey(k).getTime();
  for (let t = t0 - 14 * 3600000; t < t0 + 38 * 3600000; t += 3600000) {
    const [d, h] = dayHour(new Date(t));
    if (d === k) counts[h]++;
  }
  return counts;
}

// ---------- CSV ----------
// Splits a CSV line on sep, with fields optionally in double quotes ("" is a quote inside one).
export function splitCsv(line, sep = ",") {
  const out = [];
  let i = 0;
  while (i <= line.length) {
    if (line[i] === '"') {
      let s = "";
      i++;
      for (;;) {
        const j = line.indexOf('"', i);
        if (j < 0) { s += line.slice(i); i = line.length; break; }
        s += line.slice(i, j);
        if (line[j + 1] === '"') { s += '"'; i = j + 2; } else { i = j + 1; break; }
      }
      out.push(s);
      i++; // the separator
    } else {
      const j = line.indexOf(sep, i);
      const end = j < 0 ? line.length : j;
      out.push(line.slice(i, end));
      i = end + 1;
    }
  }
  return out;
}

// Rows of a CSV response body as objects keyed by the header, streamed, so files of hundreds of MB
// don't have to fit in memory. Fields with line breaks are not supported.
export async function* csvRows(body, sep = ",") {
  const decoder = new TextDecoder();
  let rest = "", header = null;
  const row = (line) => {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line) return null;
    const f = splitCsv(line, sep);
    if (!header) { header = f.map((h) => h.replace(/^﻿/, "")); return null; }
    return Object.fromEntries(header.map((h, i) => [h, f[i] ?? ""]));
  };
  for await (const chunk of body) {
    rest += decoder.decode(chunk, { stream: true });
    const lines = rest.split("\n");
    rest = lines.pop();
    for (const line of lines) { const r = row(line); if (r) yield r; }
  }
  rest += decoder.decode();
  const r = row(rest);
  if (r) yield r;
}

// ---------- coordinates ----------
// Swiss LV95 (EPSG:2056) to WGS84, with swisstopo's approximate formulas (about 1 m off).
export function lv95ToWgs84(e, n) {
  const y = (e - 2600000) / 1e6, x = (n - 1200000) / 1e6;
  const lon = 2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y * y * y;
  const lat = 16.9023892 + 3.238272 * x - 0.270978 * y * y - 0.002528 * x * x - 0.0447 * y * y * x - 0.014 * x * x * x;
  return { lat: Math.round((lat * 100) / 36 * 1e6) / 1e6, lon: Math.round((lon * 100) / 36 * 1e6) / 1e6 };
}

// ---------- hourly tallies ----------
// Counts per counter and slot (a measuring point, lane or direction) per local day and hour, with the
// number of intervals each hour got, to tell which days are complete.
export class HourTally {
  constructor() { this.counters = new Map(); }
  // A row for slot on day k, hour h. A null value is a row that says its count is missing: the slot is
  // still expected that day.
  add(counter, slot, k, h, value) {
    let c = this.counters.get(counter);
    if (!c) this.counters.set(counter, (c = new Map()));
    let s = c.get(slot);
    if (!s) c.set(slot, (s = new Map()));
    let d = s.get(k);
    if (!d) s.set(k, (d = { v: Array(24).fill(0), n: Array(24).fill(0) }));
    if (value != null) { d.v[h] += value; d.n[h]++; }
  }
  // The complete days of a counter between from and to (YYYYMMDD) as { all, d1, d2 } Maps of
  // YYYYMMDD -> [h00..h23, total]. A day is complete when every slot with a row that day has perHour
  // intervals in each local hour. With dirs ({ d1: [slots], d2: [slots] }) both directions need a
  // slot that day, and d1 and d2 sum their slots. Days with no counts at all are a stuck counter.
  days(counter, { timeZone, perHour = 1, from, to, dirs }) {
    const out = { all: new Map(), d1: new Map(), d2: new Map() };
    const slots = this.counters.get(counter);
    if (!slots) return out;
    const keys = new Set();
    for (const s of slots.values()) for (const k of s.keys()) if (k >= from && k <= to) keys.add(k);
    for (const k of [...keys].sort()) {
      const need = localHourCounts(timeZone, k).map((c) => c * perHour);
      const present = [...slots].filter(([, s]) => s.has(k));
      const complete = present.every(([, s]) => s.get(k).n.every((n, h) => n >= need[h]));
      if (!complete) continue;
      if (dirs && !["d1", "d2"].every((d) => dirs[d].some((slot) => slots.get(slot)?.has(k)))) continue;
      const sum = (names) => {
        const v = Array(25).fill(0);
        for (const [name, s] of present) {
          if (!names.includes(name)) continue;
          s.get(k).v.forEach((x, h) => { v[h] += x; v[24] += x; });
        }
        return v;
      };
      const all = sum(present.map(([name]) => name));
      if (!all[24]) continue;
      out.all.set(k, all);
      if (dirs) { out.d1.set(k, sum(dirs.d1)); out.d2.set(k, sum(dirs.d2)); }
    }
    return out;
  }
}
