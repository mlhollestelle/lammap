// Fetches the cycle and pedestrian counters that Finnish cities publish on Eco-Counter's public web
// pages (Eco-Visio's "publicwebpageplus" API, which the pages themselves use; not documented by
// Eco-Counter). Hourly sums are merged into one JSON file per counter in the same format as
// scripts/ingest.mjs, plus a station list. Run by .github/workflows/ingest.yml, which syncs the
// output directory with the R2 bucket.
//
//   node scripts/ingest-eco.mjs [--days 7] [--keep 366] [--out data] [--counters 100146346-bike,100059446-pedestrian]
//
// Output:
//   <out>/eco/<counter>.json   { id, all }, a map YYYYMMDD -> [h00..h23, total]
//   <out>/eco/stations.json    [{ id, name, city, org, mode, lat, lon, dirs, last, days }], counters with data
//
// A site that counts both cyclists and pedestrians becomes two counters, "<site>-bike" and
// "<site>-pedestrian". The pages don't say which channels are directions and which are separate
// paths, so all channels of a mode are summed. Helsinki's own counters come from scripts/ingest-hel.mjs,
// so the Helsinki region page only adds the ones the city's API lacks.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const API = "https://www.eco-visio.net/api/aladdin/1.0.0/pbl/publicwebpageplus";
const HEL_API = "https://lidotiku.api.hel.fi/api";
const MIN_GAP_MS = 500;
const CHUNK_DAYS = 120;
// Eco-Counter's "pratique": 1 pedestrians, 2 cyclists. Others (cars, scooters, vehicle classes) are left out.
const MODES = { 1: "pedestrian", 2: "bike" };
// The public pages of Finnish organisations, with the municipality of their counters. The Helsinki
// region page covers several cities, so its sites outside Helsinki are listed in SITE_CITY. Tampere's
// and Turku's counters are not public.
const ORGS = [
  { id: 5589, city: "Helsinki" }, // "Helsingin seutu"
  { id: 26, city: "Lahti" },
  { id: 251, city: "Joensuu" },
  { id: 5040, city: "Vaasa" },
  { id: 6014, city: "Rovaniemi" },
  { id: 6091, city: "Hämeenlinna" },
];
const SITE_CITY = {
  // Espoo
  100135213: "Espoo", 100146337: "Espoo", 100146338: "Espoo", 100146339: "Espoo", 100146340: "Espoo",
  100146341: "Espoo", 100146342: "Espoo", 100146343: "Espoo", 100146344: "Espoo", 100146345: "Espoo",
  100146346: "Espoo", 100155139: "Espoo", 300047495: "Espoo", 300064647: "Espoo", 300064648: "Espoo",
  // Vantaa
  100140125: "Vantaa", 100140126: "Vantaa", 100140127: "Vantaa", 100140128: "Vantaa", 100140130: "Vantaa",
  100146559: "Vantaa", 100146560: "Vantaa", 100146561: "Vantaa", 100146562: "Vantaa",
  // Kauniainen
  100139442: "Kauniainen", 300020890: "Kauniainen", 300020891: "Kauniainen", 300020892: "Kauniainen", 300020893: "Kauniainen",
  // Kerava
  100149341: "Kerava", 300028301: "Kerava", 300028302: "Kerava",
  // on the Joensuu page
  100060277: "Kontiolahti",
};
// Spare devices that are not on a site: "VAPAA" (free, often with a flat battery), "huollossa" (in service).
const SPARE = /^vapaa\b|^huollossa$/i;
// A Helsinki region site with the name of one of the City of Helsinki's own counters, or this close to
// one, is the same device.
const SAME_PLACE_M = 100;
// Counters with fewer days in the kept window are test or spare devices, or long dead.
const MIN_DAYS = 30;

const args = parseArgs(process.argv.slice(2));
const DAYS = Number(args.days ?? 7);
const KEEP = Number(args.keep ?? 366);
const OUT = args.out ?? "data";

// ---------- dates (Finnish local date; the pages report local days and hours) ----------
function helsinkiToday() {
  const s = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Helsinki" }).format(new Date());
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function addDays(date, n) { return new Date(date.getTime() + n * 86400000); }
function iso(date) { return date.toISOString().slice(0, 10); }
function key(date) { return iso(date).replace(/-/g, ""); }
function dmy(date) { const [y, m, d] = iso(date).split("-"); return `${d}/${m}/${y}`; }

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

function metres(a, b) {
  const dy = (a.lat - b.lat) * 111_320;
  const dx = (a.lon - b.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

// One counter per site and mode, with the flows that count it.
async function listCounters() {
  const hel = (await getJson(`${HEL_API}/counters/?${new URLSearchParams({ source: "EcoCounter", page_size: "1000" })}`))
    .results.features.map((f) => ({ name: f.properties.name.toLowerCase(), lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] }));
  const out = [];
  for (const org of ORGS) {
    for (const s of await getJson(`${API}/${org.id}?withNull=true`)) {
      if (SPARE.test(s.nom.trim())) continue;
      const city = SITE_CITY[s.idPdc] ?? org.city;
      if (org.id === 5589 && city === "Helsinki" && hel.some((h) => h.name === s.nom.trim().toLowerCase() || metres(h, s) < SAME_PLACE_M)) continue;
      for (const [pratique, mode] of Object.entries(MODES)) {
        const flows = (s.pratique ?? []).filter((p) => String(p.pratique) === pratique).map((p) => p.id);
        if (!flows.length) continue;
        out.push({ id: `${s.idPdc}-${mode}`, site: s.idPdc, name: s.nom.trim(), city, org: org.id, mode, lat: s.lat, lon: s.lon, flows });
      }
    }
  }
  return out;
}

// Hourly sums of all the counter's flows. Returns [[MM/DD/YYYY, count], ...], one row per local hour in
// order: 24 a day, 23 on the spring DST day.
async function fetchHours(c) {
  const rows = [];
  for (let from = START; from <= END; from = addDays(from, CHUNK_DAYS)) {
    const to = new Date(Math.min(addDays(from, CHUNK_DAYS), addDays(END, 1))); // "fin" is exclusive
    rows.push(...await getJson(`${API}/data/${c.site}?${new URLSearchParams({
      idOrganisme: String(c.org), idPdc: String(c.site), interval: "3", flowIds: c.flows.join(";"),
      debut: dmy(from), fin: dmy(to),
    })}`));
  }
  return rows;
}

// ---------- parse ----------
function toDays(rows) {
  const byDay = new Map();
  for (const [date, count] of rows) {
    const [m, d, y] = date.split("/");
    const k = `${y}${m}${d}`;
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(Number(count));
  }
  const all = new Map();
  for (const [k, counts] of byDay) {
    let hours;
    if (counts.length === 24) hours = counts;
    else if (counts.length === 23) hours = [...counts.slice(0, 3), 0, ...counts.slice(3)]; // 03:00 skipped
    else if (counts.length === 25) hours = [...counts.slice(0, 3), counts[3] + counts[4], ...counts.slice(5)];
    else continue; // a day cut short
    const total = hours.reduce((a, b) => a + b, 0);
    // The pages report outages as zeros, so a whole day of zeros is left out.
    if (!total || k < key(START) || k > key(END)) continue;
    all.set(k, [...hours, total]);
  }
  return all;
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
  const dir = path.join(OUT, "eco");
  await mkdir(dir, { recursive: true });
  const listFile = path.join(dir, "stations.json");
  const previous = new Map(((await readJson(listFile)) ?? []).map((s) => [s.id, s]));
  let counters = await listCounters();
  if (args.counters) {
    const wanted = new Set(String(args.counters).split(","));
    counters = counters.filter((c) => wanted.has(c.id));
  }
  console.log(`Fetching ${iso(START)} – ${iso(END)} for ${counters.length} Eco-Counter counters, keeping ${KEEP} days`);

  const list = [];
  const failed = [];
  for (const c of counters) {
    try {
      const file = path.join(dir, `${c.id}.json`);
      const stored = (await readJson(file)) ?? {};
      const data = { id: c.id, all: merge(stored.all, toDays(await fetchHours(c))) };
      const dayKeys = Object.keys(data.all);
      if (dayKeys.length < MIN_DAYS) continue;
      await writeFile(file, JSON.stringify(data));
      list.push({ id: c.id, name: c.name, city: c.city, org: c.org, mode: c.mode, lat: c.lat, lon: c.lon, dirs: null, last: dayKeys.at(-1), days: dayKeys.length });
    } catch (e) {
      failed.push(c.id);
      console.error(`Counter ${c.id} ${c.name}: ${e.message}`);
      // Keep it on the map with its stored data; the next run tries again.
      if (previous.has(c.id)) list.push(previous.get(c.id));
    }
  }
  // Some sites are listed twice at the same position (e.g. two "Wolffintie" in Vaasa). Only the one
  // with the most days goes on the map.
  const best = new Map();
  for (const s of list) {
    const at = `${s.mode}:${s.lat.toFixed(5)},${s.lon.toFixed(5)}`;
    if (!best.has(at) || s.days > best.get(at).days) best.set(at, s);
  }
  const shown = list.filter((s) => best.get(`${s.mode}:${s.lat.toFixed(5)},${s.lon.toFixed(5)}`) === s);
  await writeFile(listFile, JSON.stringify(shown));
  const byCity = shown.reduce((a, s) => ({ ...a, [s.city]: (a[s.city] ?? 0) + 1 }), {});
  console.log(`Done: ${shown.length} counters with data (${Object.entries(byCity).map(([m, n]) => `${n} ${m}`).join(", ")}), ${failed.length} failed`);
  if (failed.length > counters.length * 0.1) process.exit(1);
  if (failed.length) console.log(`::warning::${failed.length} Eco-Counter counters failed: ${failed.join(", ")}`);
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
