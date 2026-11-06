// Fetches the cycle and pedestrian counters that cities and regions publish on Eco-Counter's public
// web pages (Eco-Visio's "publicwebpageplus" API, which the pages themselves use; not documented by
// Eco-Counter), in Finland, Norway, Switzerland, France, Spain, Belgium, Poland and Estonia. Hourly
// sums are merged into one JSON file per counter in the same format as scripts/ingest.mjs, plus a
// station list per country. Run by .github/workflows/ingest.yml, which syncs the output directory with
// the R2 bucket.
//
//   node scripts/ingest-eco.mjs [--days 7] [--keep 366] [--out data] [--counters 100146346-bike,100059446-pedestrian]
//                               [--countries fi,no] [--skip-existing] [--max-minutes 45]
//
// Output:
//   <out>/eco/<counter>.json            { id, all }, a map YYYYMMDD -> [h00..h23, total]
//   <out>/eco/stations-<country>.json   [{ id, name, city, country, org, mode, lat, lon, dirs, last, days, from }]
//   <out>/eco/stations.json             the Finnish list again, for pages from before the split
//
// A full year for all of about 1,000 counters takes about an hour, so --max-minutes stops the run in
// time and --skip-existing continues it: it skips counters already fetched from the start of the window
// ("from" in the station list).
//
// A site that counts both cyclists and pedestrians becomes two counters, "<site>-bike" and
// "<site>-pedestrian". The pages don't say which channels are directions and which are separate
// paths, so all channels of a mode are summed. Helsinki's own counters come from scripts/ingest-hel.mjs,
// so the Helsinki region page only adds the ones the city's API lacks.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { addDays, countBy, dateWindow, fetchJson, iso, key, localHourCounts, merge, onePerPlace, parseArgs, readJson, throttle } from "./lib.mjs";

const API = "https://www.eco-visio.net/api/aladdin/1.0.0/pbl/publicwebpageplus";
const HEL_API = "https://lidotiku.api.hel.fi/api";
const MIN_GAP_MS = 500;
const CHUNK_DAYS = 120;
// Eco-Counter's "pratique": 1 pedestrians, 2 cyclists. Others (cars, scooters, vehicle classes) are left out.
const MODES = { 1: "pedestrian", 2: "bike" };
// The public pages of organisations, with the municipality of their counters and their country (Finland
// when not given). The Helsinki region page covers several cities, so its sites outside Helsinki are
// listed in SITE_CITY. Tampere's and Turku's counters are not public, and the City of Helsinki's own
// page (3886) holds the counters scripts/ingest-hel.mjs already fetches.
//
// Norway: the municipal and county pages. Left out are the Oslo "public" page (4054), whose sites are
// mostly Statens vegvesen's counters, the vegvesen pages themselves (4058, 5674), and the hiking trail,
// pilgrim route, museum and sports ground pages (4334, 4984, 5039, 5065, 5403). Statens vegvesen's
// cycle counters are on the map from scripts/ingest-nor.mjs, so municipal cycle counters at the same
// place are skipped. Public pages were found by trying organisation ids 1 to 12000 (November 2026).
const ORGS = [
  { id: 5589, city: "Helsinki" }, // "Helsingin seutu"
  { id: 26, city: "Lahti" },
  { id: 251, city: "Joensuu" },
  { id: 5040, city: "Vaasa" },
  { id: 6014, city: "Rovaniemi" },
  { id: 6091, city: "Hämeenlinna" },
  // Switzerland; Köniz names its devices "K6-VV Schwarzenburgstrasse ...".
  { id: 3964, city: "Köniz", country: "ch", strip: /^[A-Z]\d+-VV\s+/ },
  { id: 4951, city: "Kriens", country: "ch" },
  // Norway
  { id: 3936, city: "Oslo", country: "no" },
  { id: 4173, city: "Bergen", country: "no" },
  { id: 6359, city: "Trondheim", country: "no" },
  { id: 3751, city: "Tromsø", country: "no" },
  { id: 4754, city: "Bærum", country: "no" },
  { id: 7576, city: "Fredrikstad", country: "no" },
  { id: 3655, city: "Lillehammer", country: "no" },
  { id: 6286, city: "Stjørdal", country: "no" },
  { id: 3782, city: "Malvik", country: "no" },
  { id: 4217, city: "Lier", country: "no" },
  { id: 5435, city: "Rælingen", country: "no" },
  { id: 5790, city: "Haugesund", country: "no" },
  { id: 6777, city: "Ørland", country: "no" },
  { id: 7542, city: "Austevoll", country: "no" },
  { id: 4043, city: "Trøndelag", country: "no" }, // the county's counters, in several municipalities
  // France. Grand Lyon names its sites "<commune>_<place>". The national page of the Réseau vélo et
  // marche (891, about 2,000 counters) only serves data up to the end of 2025; Meurthe-et-Moselle's
  // (5542) is a study of hiking trails, mostly ended.
  { id: 3902, city: "Grand Lyon", country: "fr", cityFromName: true },
  { id: 6062, city: "Hauts-de-Seine", country: "fr" },
  { id: 236, city: "Var", country: "fr" },
  { id: 873, city: "Annecy", country: "fr" },
  // Spain
  { id: 5568, city: "Barcelona area", country: "es" },
  { id: 6840, city: "Sant Cugat", country: "es" },
  { id: 6818, city: "Benidorm", country: "es" },
  // Belgium; Fietsflow covers Flanders.
  { id: 8910, city: "Flanders", country: "be" },
  { id: 5872, city: "Kortrijk", country: "be" },
  { id: 8698, city: "Liège", country: "be" },
  // Poland
  { id: 6113, city: "Poznań", country: "pl" },
  { id: 6296, city: "Małopolska", country: "pl" },
  { id: 8068, city: "Świętokrzyskie", country: "pl" },
  { id: 8000, city: "Olsztyn", country: "pl" },
  // Estonia
  { id: 5327, city: "Tallinn", country: "ee" },
  { id: 5736, city: "Tartu", country: "ee" },
  { id: 6280, city: "Pärnu", country: "ee" },
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
const SKIP_EXISTING = Boolean(args["skip-existing"]);
const DEADLINE = args["max-minutes"] ? Date.now() + Number(args["max-minutes"]) * 60_000 : Infinity;
const COUNTRIES = args.countries ? new Set(String(args.countries).split(",")) : null;
// Requests in flight at once; the throttle still spaces their starts.
const PARALLEL = 3;

// Countries the map shows, with their time zone; the pages report the organisation's local days and hours.
const TIME_ZONES = {
  fi: "Europe/Helsinki", no: "Europe/Oslo", ch: "Europe/Zurich", fr: "Europe/Paris", es: "Europe/Madrid",
  be: "Europe/Brussels", pl: "Europe/Warsaw", ee: "Europe/Tallinn",
};
const NOR_API = "https://trafikkdata-api.atlas.vegvesen.no/";
// The window in Finnish days. Elsewhere yesterday is the same day by the time the workflow runs, and
// the local days are kept as the page reports them.
const { END, START, OLDEST_KEPT } = dateWindow("Europe/Helsinki", DAYS, KEEP);
function dmy(date) { const [y, m, d] = iso(date).split("-"); return `${d}/${m}/${y}`; }

const wait = throttle(MIN_GAP_MS);
const getJson = (url) => fetchJson(url, { wait });

function metres(a, b) {
  const dy = (a.lat - b.lat) * 111_320;
  const dx = (a.lon - b.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

// Statens vegvesen's cycle counters, which the Norwegian map already shows.
async function norwegianCycleCounters() {
  const body = await fetchJson(NOR_API, { wait, init: {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "lammap (github.com/mlhollestelle/lammap)" },
    body: JSON.stringify({ query: "{ trafficRegistrationPoints { trafficRegistrationType location { coordinates { latLon { lat lon } } } } }" }),
  } });
  return body.data.trafficRegistrationPoints
    .filter((p) => p.trafficRegistrationType === "BICYCLE" && p.location?.coordinates?.latLon)
    .map((p) => p.location.coordinates.latLon);
}

// One counter per site and mode, with the flows that count it.
async function listCounters() {
  const hel = (await getJson(`${HEL_API}/counters/?${new URLSearchParams({ source: "EcoCounter", page_size: "1000" })}`))
    .results.features.map((f) => ({ name: f.properties.name.toLowerCase(), lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] }));
  const orgs = ORGS.filter((o) => !COUNTRIES || COUNTRIES.has(o.country ?? "fi"));
  const nor = orgs.some((o) => o.country === "no") ? await norwegianCycleCounters() : [];
  const out = [];
  const seen = new Set();
  for (const org of orgs) {
    for (const s of await getJson(`${API}/${org.id}?withNull=true`)) {
      if (SPARE.test(s.nom.trim())) continue;
      const city = SITE_CITY[s.idPdc] ?? org.city;
      if (org.id === 5589 && city === "Helsinki" && hel.some((h) => h.name === s.nom.trim().toLowerCase() || metres(h, s) < SAME_PLACE_M)) continue;
      for (const [pratique, mode] of Object.entries(MODES)) {
        const flows = (s.pratique ?? []).filter((p) => String(p.pratique) === pratique).map((p) => p.id);
        if (!flows.length) continue;
        if (org.country === "no" && mode === "bike" && nor.some((p) => metres(p, s) < SAME_PLACE_M)) continue;
        // A device on two pages (a city's and its region's) is fetched once.
        if (seen.has(`${s.idPdc}-${mode}`)) continue;
        seen.add(`${s.idPdc}-${mode}`);
        let name = s.nom.trim().replace(org.strip ?? /^$/, ""), place = city;
        const m = org.cityFromName && name.match(/^([^_]+)_(.+)$/);
        if (m) [place, name] = [m[1].trim(), m[2].trim()];
        out.push({ id: `${s.idPdc}-${mode}`, site: s.idPdc, name, city: place, country: org.country ?? "fi", org: org.id, mode, lat: s.lat, lon: s.lon, flows });
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
// Local hours as the page reports them: one row per hour, without the hour the clocks skip in spring
// and usually with the repeated hour twice in autumn, which are summed.
function toDays(rows, timeZone) {
  const byDay = new Map();
  for (const [date, count] of rows) {
    const [m, d, y] = date.split("/");
    const k = `${y}${m}${d}`;
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(Number(count));
  }
  const all = new Map();
  for (const [k, counts] of byDay) {
    // 24 rows are the day's hours, also on the autumn DST day, where the pages now and then merge the
    // repeated hour themselves; otherwise the rows have to match the day's local hours.
    const expected = counts.length === 24 ? Array(24).fill(1) : localHourCounts(timeZone, k);
    if (counts.length !== expected.reduce((a, b) => a + b, 0)) continue; // a day cut short
    let i = 0;
    const hours = expected.map((n) => { let v = 0; for (let j = 0; j < n; j++) v += counts[i++]; return v; });
    const total = hours.reduce((a, b) => a + b, 0);
    // The pages report outages as zeros, so a whole day of zeros is left out.
    if (!total || k < key(START) || k > key(END)) continue;
    all.set(k, [...hours, total]);
  }
  return all;
}

// ---------- main ----------
async function main() {
  const dir = path.join(OUT, "eco");
  await mkdir(dir, { recursive: true });
  const countries = Object.keys(TIME_ZONES);
  const listFile = (c) => path.join(dir, `stations-${c}.json`);
  // The lists of the last run: one per country, or the single list from before the split.
  const previous = new Map();
  for (const s of (await readJson(path.join(dir, "stations.json"))) ?? []) previous.set(s.id, { country: "fi", ...s });
  for (const c of countries) for (const s of (await readJson(listFile(c))) ?? []) previous.set(s.id, s);

  let counters = await listCounters();
  if (args.counters) {
    const wanted = new Set(String(args.counters).split(","));
    counters = counters.filter((c) => wanted.has(c.id));
  }
  const skipped = SKIP_EXISTING ? counters.filter((c) => previous.get(c.id)?.from <= key(START)) : [];
  counters = counters.filter((c) => !skipped.includes(c));
  console.log(`Fetching ${iso(START)} – ${iso(END)} for ${counters.length} Eco-Counter counters (${skipped.length} skipped), keeping ${KEEP} days`);

  const list = new Map();
  const failed = [];
  let next = 0, done = 0, stopped = false;
  async function worker() {
    while (next < counters.length) {
      if (Date.now() > DEADLINE) { stopped = true; return; }
      const c = counters[next++];
      try {
        const file = path.join(dir, `${c.id}.json`);
        const rows = await fetchHours(c);
        const stored = (await readJson(file)) ?? {};
        const data = { id: c.id, all: merge(stored.all, toDays(rows, TIME_ZONES[c.country]), OLDEST_KEPT) };
        const dayKeys = Object.keys(data.all);
        if (dayKeys.length >= MIN_DAYS) {
          await writeFile(file, JSON.stringify(data));
          const prevFrom = previous.get(c.id)?.from;
          list.set(c.id, {
            id: c.id, name: c.name, city: c.city, country: c.country, org: c.org, mode: c.mode, lat: c.lat, lon: c.lon,
            dirs: null, last: dayKeys.at(-1), days: dayKeys.length, from: prevFrom && prevFrom < key(START) ? prevFrom : key(START),
          });
        }
      } catch (e) {
        failed.push(c.id);
        console.error(`Counter ${c.id} ${c.name}: ${e.message}`);
      }
      if (++done % 100 === 0) console.log(`  ${done} of ${counters.length} counters`);
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  // Counters not fetched this time (skipped, failed or past the deadline) keep their entry while they
  // have data in the kept window.
  for (const [id, s] of previous) if (!list.has(id) && s.last >= OLDEST_KEPT) list.set(id, s);
  // Some sites are listed twice at the same position (e.g. two "Wolffintie" in Vaasa). Only the one
  // with the most days goes on the map.
  const shown = onePerPlace([...list.values()]);
  for (const c of countries) await writeFile(listFile(c), JSON.stringify(shown.filter((s) => s.country === c)));
  await writeFile(path.join(dir, "stations.json"), JSON.stringify(shown.filter((s) => s.country === "fi")));
  const stop = stopped ? ", stopped at the time limit" : "";
  console.log(`Done: ${shown.length} counters with data (${countBy(shown, "country")}), ${failed.length} failed${stop}`);
  if (stopped) console.log("::warning::Eco-Counter: stopped at the time limit, run again with skip_existing to continue");
  if (failed.length > counters.length * 0.1) process.exit(1);
  if (failed.length) console.log(`::warning::${failed.length} Eco-Counter counters failed: ${failed.join(", ")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
