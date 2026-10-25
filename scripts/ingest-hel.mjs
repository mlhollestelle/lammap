// Fetches the City of Helsinki's traffic counters from its LIDO-TIKU API: the city's own LAM stations
// (motor vehicles, one bicycle station) and the Eco-Counter cycle and pedestrian counters. Hourly sums
// are merged into one JSON file per counter in the same format as scripts/ingest.mjs, plus a station
// list. Run by .github/workflows/ingest.yml, which syncs the output directory with the R2 bucket.
//
//   node scripts/ingest-hel.mjs [--days 7] [--keep 366] [--out data] [--counters 4667,100008546]
//
// Output:
//   <out>/hel/<counter>.json   { id, all, d1, d2 }, each a map YYYYMMDD -> [h00..h23, total]
//   <out>/hel/stations.json    [{ id, name, source, mode, lat, lon, dirs, last, days }], counters with data
//
// The Fintraffic stations in the same API are left out: the map already shows them from Digitraffic.
// So are the traffic light loops (LIVA), the per-lane radar loops (SmartJunction) and the sources
// that no longer report.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const API = "https://lidotiku.api.hel.fi/api";
const SOURCES = ["HEL LAM", "EcoCounter"];
const MIN_GAP_MS = 500;
const CHUNK_DAYS = 60; // 60 days x 24 h x 2 directions stays well below the API's 10,000 rows per page
// The source lists also hold test devices outside Helsinki (e.g. a "Logger" in France).
const BBOX = { south: 60.05, north: 60.4, west: 24.75, east: 25.3 };
// Copies of devices outside Helsinki, which scripts/ingest-eco.mjs shows with their own city:
// "Espoonlahti_Clone" is Espoo's Länsituulenkuja counter in Tapiola.
const SKIP = new Set([100133755]);
// Compass directions as the city reports them; north and east are direction 1.
const DIRECTIONS = {
  Pohjoiseen: ["d1", "Northbound"],
  Itään: ["d1", "Eastbound"],
  Etelään: ["d2", "Southbound"],
  Länteen: ["d2", "Westbound"],
};
// Motor traffic never stops for an hour on these roads, so a day with fewer hours had an outage.
// Cycle and pedestrian counters leave out empty hours, so for them any reported hour counts.
const MIN_CAR_HOURS = 20;
// A day next to a day without data is kept only if it has data at or before EDGE_FIRST_HOUR (after a
// gap) and at or after EDGE_LAST_HOUR (before a gap, or when it is the newest day).
const EDGE_FIRST_HOUR = 6;
const EDGE_LAST_HOUR = 20;

const args = parseArgs(process.argv.slice(2));
const DAYS = Number(args.days ?? 7);
const KEEP = Number(args.keep ?? 366);
const OUT = args.out ?? "data";

// ---------- dates (Finnish local date; the API reports local times with their offset) ----------
function helsinkiToday() {
  const s = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Helsinki" }).format(new Date());
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function addDays(date, n) { return new Date(date.getTime() + n * 86400000); }
function iso(date) { return date.toISOString().slice(0, 10); }
function key(date) { return iso(date).replace(/-/g, ""); }

const END = addDays(helsinkiToday(), -1);
const START = addDays(END, -(DAYS - 1));
const OLDEST_KEPT = key(addDays(END, -(KEEP - 1)));

// ---------- fetch ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastRequest = 0;
async function getJson(url, tries = 4) {
  for (let i = 0; ; i++) {
    const gap = lastRequest + MIN_GAP_MS - Date.now();
    if (gap > 0) await sleep(gap);
    lastRequest = Date.now();
    let err;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (res.ok) return await res.json();
      err = Object.assign(new Error(`HTTP ${res.status}`), { retry: res.status === 429 || res.status >= 500 });
    } catch (e) {
      err = Object.assign(e, { retry: e.name === "TimeoutError" || e.name === "TypeError" });
    }
    if (!err.retry || i + 1 >= tries) throw err;
    const delay = 5_000 * 2 ** i;
    console.log(`  ${err.message}, retrying in ${delay / 1000}s`);
    await sleep(delay);
  }
}

async function listCounters() {
  const out = [];
  for (const source of SOURCES) {
    const gj = await getJson(`${API}/counters/?${new URLSearchParams({ source, page_size: "1000" })}`);
    for (const f of gj.results.features) {
      const [lon, lat] = f.geometry.coordinates;
      if (lat < BBOX.south || lat > BBOX.north || lon < BBOX.west || lon > BBOX.east || SKIP.has(f.properties.id)) continue;
      out.push({ id: f.properties.id, name: f.properties.name, source, lat, lon });
    }
  }
  return out;
}

// Hourly sums per direction, all vehicle classes together. Returns [{ startTime, direction, value }].
async function fetchHours(id) {
  const rows = [];
  for (let from = START; from <= END; from = addDays(from, CHUNK_DAYS)) {
    const to = new Date(Math.min(addDays(from, CHUNK_DAYS - 1), END));
    let url = `${API}/observations/aggregate/?${new URLSearchParams({
      counter: String(id), period: "hour", measurement_type: "count",
      start_date: iso(from), end_date: iso(to), order: "start_time", page_size: "10000",
    })}`;
    while (url) {
      const page = await getJson(url);
      // Some dead devices still return rows, with no value.
      for (const r of page.results) if (r.aggregatedValue != null) rows.push({ startTime: r.startTime, direction: r.direction, value: r.aggregatedValue });
      url = page.next;
    }
  }
  return rows;
}

// Eco-Counter devices count either cyclists or pedestrians, which only the raw observations say.
async function ecoMode(id) {
  const page = await getJson(`${API}/observations/?${new URLSearchParams({
    counter: String(id), measurement_type: "count", start_date: iso(addDays(END, -(KEEP - 1))), end_date: iso(END), page_size: "100",
  })}`);
  const types = new Set(page.results.map((r) => r.vehicletype));
  if (types.size !== 1) return null; // nothing reported, or a mix we can't show as one mode
  return { bicycle: "bike", pedestrian: "pedestrian" }[[...types][0]] ?? null;
}

// ---------- parse ----------
// startTime is local time with its offset, e.g. "2026-10-16T23:00:00+03:00", so its date and hour are
// already Finnish. On the autumn DST change both 03:00 hours land in the same slot.
function toDays(rows, mode) {
  const maps = { all: new Map(), d1: new Map(), d2: new Map() };
  const hoursSeen = new Map(); // YYYYMMDD -> Set of hours, to spot outages
  const dirNames = { d1: null, d2: null };
  for (const r of rows) {
    const k = r.startTime.slice(0, 10).replace(/-/g, "");
    const h = Number(r.startTime.slice(11, 13));
    const known = DIRECTIONS[r.direction];
    const dir = known ? known[0] : "all"; // "" for Eco-Counter, "Pyörämittaus" for the LAM bicycle station
    if (known) dirNames[dir] = known[1];
    if (!maps[dir].has(k)) maps[dir].set(k, Array(25).fill(0));
    const v = maps[dir].get(k);
    v[h] += r.value;
    v[24] += r.value;
    if (!hoursSeen.has(k)) hoursSeen.set(k, new Set());
    hoursSeen.get(k).add(h);
  }
  // Days next to an outage are usually cut off on that side: the first day back starts in the
  // afternoon, and the newest day is often still coming in when the API is asked in the morning.
  // Days before START are unknown, so the first fetched day is only checked by its hour count.
  const firstKey = key(START);
  for (const [k, hours] of hoursSeen) {
    const d = new Date(Date.UTC(+k.slice(0, 4), +k.slice(4, 6) - 1, +k.slice(6, 8)));
    const cutStart = k > firstKey && !hoursSeen.has(key(addDays(d, -1))) && Math.min(...hours) > EDGE_FIRST_HOUR;
    const cutEnd = !hoursSeen.has(key(addDays(d, 1))) && Math.max(...hours) < EDGE_LAST_HOUR;
    // A whole day of zeros is a stuck counter, not an empty street.
    const total = Object.values(maps).reduce((t, m) => t + (m.get(k)?.[24] ?? 0), 0);
    if (cutStart || cutEnd || !total || (mode === "car" && hours.size < MIN_CAR_HOURS)) for (const m of Object.values(maps)) m.delete(k);
  }
  return { maps, dirNames };
}

// ---------- merge ----------
async function readJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return null; throw e; }
}

// Fetched days replace stored ones; stored days the new fetch lacks are kept.
function merge(stored = {}, fetched) {
  const out = {};
  for (const [k, v] of Object.entries(stored)) if (k >= OLDEST_KEPT) out[k] = v;
  for (const [k, v] of fetched) if (k >= OLDEST_KEPT) out[k] = v;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

// ---------- main ----------
async function main() {
  const dir = path.join(OUT, "hel");
  await mkdir(dir, { recursive: true });
  const listFile = path.join(dir, "stations.json");
  const previous = new Map(((await readJson(listFile)) ?? []).map((s) => [s.id, s]));
  let counters = await listCounters();
  if (args.counters) {
    const wanted = new Set(String(args.counters).split(",").map(Number));
    counters = counters.filter((c) => wanted.has(c.id));
  }
  console.log(`Fetching ${iso(START)} – ${iso(END)} for ${counters.length} Helsinki counters, keeping ${KEEP} days`);

  const list = [];
  const failed = [];
  for (const c of counters) {
    try {
      const rows = await fetchHours(c.id);
      const prev = previous.get(c.id);
      let mode = prev?.mode;
      if (c.source === "HEL LAM") mode = rows.some((r) => r.direction === "Pyörämittaus") ? "bike" : "car";
      else if (rows.length || !mode) mode = (await ecoMode(c.id)) ?? mode;
      const file = path.join(dir, `${c.id}.json`);
      const stored = (await readJson(file)) ?? {};
      const { maps, dirNames } = toDays(rows, mode);
      const data = { id: c.id };
      for (const d of ["all", "d1", "d2"]) data[d] = merge(stored[d], maps[d]);
      const dayKeys = [...new Set(["all", "d1", "d2"].flatMap((d) => Object.keys(data[d])))].sort();
      if (!dayKeys.length || !mode) continue; // never reported in the kept window
      await writeFile(file, JSON.stringify(data));
      const dirs = dirNames.d1 && dirNames.d2 ? [dirNames.d1, dirNames.d2] : (prev?.dirs ?? null);
      list.push({ id: c.id, name: c.name, source: c.source, mode, lat: c.lat, lon: c.lon, dirs, last: dayKeys.at(-1), days: dayKeys.length });
    } catch (e) {
      failed.push(c.id);
      console.error(`Counter ${c.id} ${c.name}: ${e.message}`);
      // Keep it on the map with its stored data; the next run tries again.
      if (previous.has(c.id)) list.push(previous.get(c.id));
    }
  }
  // Some devices are listed twice, under another name with the same position (e.g. "Formula : ..."),
  // with more or less the same data. Only the one with the most days goes on the map.
  const best = new Map();
  for (const s of list) {
    const at = `${s.mode}:${s.lat.toFixed(5)},${s.lon.toFixed(5)}`;
    if (!best.has(at) || s.days > best.get(at).days) best.set(at, s);
  }
  const kept = new Set(best.values());
  for (const s of list) if (!kept.has(s)) console.log(`  ${s.id} ${s.name}: same place as a counter with more data, left off the map`);
  const shown = list.filter((s) => kept.has(s));
  await writeFile(listFile, JSON.stringify(shown));
  const byMode = shown.reduce((a, s) => ({ ...a, [s.mode]: (a[s.mode] ?? 0) + 1 }), {});
  console.log(`Done: ${shown.length} counters with data (${Object.entries(byMode).map(([m, n]) => `${n} ${m}`).join(", ")}), ${failed.length} failed`);
  if (failed.length > counters.length * 0.1) process.exit(1);
  if (failed.length) console.log(`::warning::${failed.length} Helsinki counters failed: ${failed.join(", ")}`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([\w-]+)(?:=(.*))?$/);
    if (!m) throw new Error(`Unknown argument: ${argv[i]}`);
    out[m[1]] = m[2] ?? (argv[i + 1] === undefined || argv[i + 1].startsWith("--") ? true : argv[++i]);
  }
  return out;
}

main().catch((e) => { console.error(e); process.exit(1); });
