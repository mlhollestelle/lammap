// Fetches Basel-Stadt's traffic counters from its open data portal (data.bs.ch, Opendatasoft): the
// car counts (dataset 100006) and the cycle and pedestrian counts (100013) of the Amt für Mobilität,
// hourly per lane and updated daily. Hourly sums are merged into one JSON file per counter in the same
// format as scripts/ingest.mjs, plus a station list. Run by .github/workflows/ingest.yml, which syncs the
// output directory with the R2 bucket.
//
//   node scripts/ingest-bs.mjs [--days 7] [--keep 366] [--out data] [--counters 350-car,354-bike]
//
// Output:
//   <out>/bs/<counter>.json    { id, all, d1, d2 }, each a map YYYYMMDD -> [h00..h23, total]
//   <out>/bs/stations.json     [{ id, name, source, mode, lat, lon, dirs, last, days }], counters with data
//
// A site that counts several modes becomes one counter per mode, "<site>-car", "<site>-bike" and
// "<site>-pedestrian". Lanes whose direction starts with "1 " or "2 " ("1 nach Kleinbasel") are the
// two directions; the pedestrian counters mostly count the two pavements instead, which are summed. A
// day counts when every lane with data that day has all of its hours (Swiss local time).

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { HourTally, addDays, countBy, csvRows, dateWindow, httpError, iso, key, localDayHour, mergeDirs, parseArgs, readJson, timedFetch, withRetry } from "./lib.mjs";

const API = "https://data.bs.ch/api/explore/v2.1/catalog/datasets";
const DATASETS = { 100006: "car", 100013: null }; // 100013 holds both cycles and pedestrians
const TRAFFIC_TYPES = { MIV: "car", Velo: "bike", "Fussgänger": "pedestrian" };
const TZ = "Europe/Zurich";

const args = parseArgs(process.argv.slice(2));
const DAYS = Number(args.days ?? 7);
const KEEP = Number(args.keep ?? 366);
const OUT = args.out ?? "data";
const WANTED = args.counters ? new Set(String(args.counters).split(",")) : null;

const { END, START, OLDEST_KEPT } = dateWindow(TZ, DAYS, KEEP);
const FROM = key(START), TO = key(END);
const dayHour = localDayHour(TZ);

// A lane's direction as [number or null, label]: "1 nach Kleinbasel" -> [1, "Towards Kleinbasel"],
// "2 - von Bahnhof SBB (1=R, 2=Ü)" -> [2, "From Bahnhof SBB"], "1 Basel" and "917_1 Ri Basel" ->
// [1, "Towards Basel"], "Richtung Stadt" -> [null, "Towards Stadt"]. Labels without a number or a word
// for the direction, like the pavements of a pedestrian counter ("Klybeckstrasse 113"), give null.
function direction(name) {
  const m = name.match(/^(?:\d+_)?(?:([12])\s*-?\s+)?(?:(nach|von|richtung|ri\.?)\s+)?(.*?)\s*(\(.*\))?$/i);
  if (!m || !m[3] || (!m[1] && !m[2])) return null;
  return [m[1] ? Number(m[1]) : null, `${/^von$/i.test(m[2] ?? "") ? "From" : "Towards"} ${m[3]}`];
}

// Two directions when every lane has one and there are exactly two: { d1: [lanes], d2: [lanes] } and
// their names, with the one numbered 1 (or else a "towards" one) first.
function directions(lanes) {
  if (!lanes.every(([, d]) => d)) return {};
  const names = [...new Set(lanes.map(([, d]) => d[1]))];
  if (names.length !== 2) return {};
  const rank = (n) => {
    const nums = lanes.filter(([, d]) => d[1] === n && d[0] != null).map(([, d]) => d[0]);
    return nums.length ? Math.min(...nums) : n.startsWith("Towards") ? 1.5 : 1.6;
  };
  names.sort((a, b) => rank(a) - rank(b));
  const of = (n) => lanes.filter(([, d]) => d[1] === n).map(([l]) => l);
  return { dirs: { d1: of(names[0]), d2: of(names[1]) }, dirNames: names };
}

// The site's own name without its number: "354 Wettsteinbrücke" -> "Wettsteinbrücke".
const siteName = (s) => s.replace(/^\d+\s+/, "").trim();
const slug = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// Streams a dataset's export for the window (a day either side in UTC, so the local days at both ends
// are whole) into the handler start() returns; start() is called again for each try. The portal drops
// connections now and then, so it gets a few more tries than usual.
async function readExport(dataset, start) {
  const where = `datetimefrom >= "${iso(addDays(START, -1))}" and datetimefrom < "${iso(addDays(END, 2))}"`;
  const p = new URLSearchParams({
    delimiter: ";",
    select: "zst_id,sitename,datetimefrom,directionname,lanecode,lanename,traffictype,total,geo_point_2d",
    where,
  });
  return readCsv(`${API}/${dataset}/exports/csv?${p}`, start);
}

async function readCsv(url, start) {
  return withRetry(async () => {
    const res = await timedFetch(url, { headers: { "User-Agent": "lammap (github.com/mlhollestelle/lammap)" } }, null, 1_800_000);
    if (!res.ok) throw httpError(res);
    const handle = start();
    for await (const r of csvRows(res.body, ";")) handle(r);
  }, { tries: 6, delay: () => 15_000 });
}

// Positions from the list of counting sites (dataset 100038), for counters whose rows have none.
async function sitePositions() {
  const pos = new Map();
  try {
    await readCsv(`${API}/100038/exports/csv?${new URLSearchParams({ delimiter: ";", select: "id_zst,geo_point_2d" })}`, () => (r) => {
      const [lat, lon] = r.geo_point_2d.split(",").map(Number);
      if (lat && lon) pos.set(r.id_zst, { lat, lon });
    });
  } catch (e) { console.error(`Basel counting sites: ${e.message}`); }
  return pos;
}

async function main() {
  const dir = path.join(OUT, "bs");
  await mkdir(dir, { recursive: true });
  const listFile = path.join(dir, "stations.json");
  const previous = new Map(((await readJson(listFile)) ?? []).map((s) => [s.id, s]));
  console.log(`Fetching ${FROM} – ${TO} for Basel's counters, keeping ${KEEP} days`);

  const tally = new HourTally();
  const meta = new Map();
  let failed = 0;
  for (const dataset of Object.keys(DATASETS)) {
    let local, seen;
    try {
      await readExport(dataset, () => (local = new HourTally(), seen = new Map(), (r) => {
        // The Eisenbahnbrücke counter has neither a site number nor a traffic type; its lanes are
        // named "Spur 1 Velo Grossbasel", "Spur 3 Fuss Grossbasel" and so on.
        const mode = TRAFFIC_TYPES[r.traffictype] ?? DATASETS[dataset] ??
          (/\bVelo\b/.test(r.lanename) ? "bike" : /\bFuss\b/.test(r.lanename) ? "pedestrian" : null);
        if (!mode || r.total === "") return;
        const site = r.zst_id || slug(r.sitename);
        const id = `${site}-${mode}`;
        if (WANTED && !WANTED.has(id)) return;
        const [k, h] = dayHour(new Date(r.datetimefrom));
        const lane = r.lanecode || r.lanename;
        local.add(id, lane, k, h, Number(r.total));
        if (!seen.has(id)) {
          const [lat, lon] = r.geo_point_2d.split(",").map(Number);
          seen.set(id, { id, site, name: siteName(r.sitename), mode, lat: lat || null, lon: lon || null, lanes: new Map() });
        }
        seen.get(id).lanes.set(lane, direction(r.directionname));
      }));
    } catch (e) {
      console.error(`Basel dataset ${dataset}: ${e.message}`);
      failed++;
      continue;
    }
    for (const [c, slots] of local.counters) tally.counters.set(c, slots);
    for (const [id, m] of seen) meta.set(id, m);
    console.log(`  dataset ${dataset}: ${seen.size} counters`);
  }

  const positions = [...meta.values()].some((m) => !m.lat || !m.lon) ? await sitePositions() : new Map();
  const list = new Map();
  for (const [id, m] of meta) {
    if (!m.lat || !m.lon) Object.assign(m, positions.get(m.site));
    if (!m.lat || !m.lon) { console.log(`  ${id}: no position, left out`); continue; }
    const { dirs = null, dirNames = null } = directions([...m.lanes]);
    const maps = tally.days(id, { timeZone: TZ, from: FROM, to: TO, dirs });
    const file = path.join(dir, `${id}.json`);
    const stored = (await readJson(file)) ?? {};
    const data = { id, ...mergeDirs(stored, maps, OLDEST_KEPT) };
    const dayKeys = Object.keys(data.all);
    if (!dayKeys.length) continue;
    await writeFile(file, JSON.stringify(data));
    list.set(id, {
      id, name: m.name, source: "Amt für Mobilität", mode: m.mode, lat: m.lat, lon: m.lon,
      dirs: Object.keys(data.d1).length && Object.keys(data.d2).length ? dirNames : null,
      last: dayKeys.at(-1), days: dayKeys.length,
    });
  }
  // Counters not in this run's export keep their entry while they have data in the kept window.
  for (const [id, s] of previous) if (!list.has(id) && s.last >= OLDEST_KEPT) list.set(id, s);
  await writeFile(listFile, JSON.stringify([...list.values()]));
  console.log(`Done: ${list.size} Basel counters with data (${countBy([...list.values()], "mode")})`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
