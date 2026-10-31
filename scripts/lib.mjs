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

// fetch with a timeout, after waiting for the throttle if there is one.
export async function timedFetch(url, init = {}, wait) {
  await wait?.();
  return fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
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
