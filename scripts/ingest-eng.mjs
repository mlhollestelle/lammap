// Fetches National Highways' traffic counters on England's motorways and major A-roads from the WebTRIS
// API: MIDAS, TMU and TAME loop sites. 15-minute counts are summed to hours and merged into one JSON file
// per station in the same format as scripts/ingest.mjs, plus a station list. Run by
// .github/workflows/ingest.yml, which syncs the output directory with the R2 bucket.
//
//   node scripts/ingest-eng.mjs [--days 7] [--keep 366] [--out data] [--stations 2,14153-14160,...]
//                               (station ids, or WebTRIS site ids in them)
//                               [--max-minutes 60]
//
// Output:
//   <out>/eng/<station>.json   { id, all, d1, d2 }, each a map YYYYMMDD -> [h00..h23, total]
//   <out>/eng/stations.json    [{ id, name, source, city, road, mode, lat, lon, dirs, sites, last, days, from, to }]
//
// WebTRIS publishes a month at a time, weeks or months after the fact, so the window ends at the newest
// day with data, not yesterday. Published data doesn't change, so each station is fetched only from the
// day after the one it was last fetched through ("to"); a run without new data fetches nothing. --days
// sets how far back the window starts (365 for a backfill); --max-minutes stops a long run in time, and
// the next run continues with the stations that are still behind.
//
// A WebTRIS site counts one carriageway. Sites on the same road with opposite directions within MAX_PAIR_M
// become one station with two directions. Slip roads are left out, and so are MIDAS sites beyond the
// first on each road link (junction to junction), where every site counts the same traffic.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { addDays, countBy, fromKey, httpError, iso, key, localToday, mergeDirs, parseArgs, readJson, throttle, timedFetch, withRetry } from "./lib.mjs";

const API = "https://webtris.nationalhighways.co.uk/api/v1.0";
const MIN_GAP_MS = 500;
// The API refuses more than about 30 sites per request, and pages at most 40,000 rows (15-minute intervals).
const BATCH_SITES = 30;
const PAGE = 40000;
const MAX_FAILED_BATCHES = 3;
// Carriageways of one road are mostly 20 to 50 metres apart.
const MAX_PAIR_M = 80;
// An hour counts only with all four 15-minute intervals; a day only if every hour counts (23 on the
// spring DST day). WebTRIS reports local time.
const MIN_HOURS = 23;
// Sites with a direction in the first slot are direction 1 of their station.
const OPPOSITE = {
  Northbound: "Southbound", Eastbound: "Westbound", Clockwise: "Anti-clockwise",
  Southbound: "Northbound", Westbound: "Eastbound", "Anti-clockwise": "Clockwise",
};
const FIRST = new Set(["Northbound", "Eastbound", "Clockwise"]);

const args = parseArgs(process.argv.slice(2));
const DAYS = Number(args.days ?? 7);
const KEEP = Number(args.keep ?? 366);
const OUT = args.out ?? "data";
const DEADLINE = args["max-minutes"] ? Date.now() + Number(args["max-minutes"]) * 60_000 : Infinity;

// ---------- fetch ----------
const wait = throttle(MIN_GAP_MS);
const HEADERS = { "User-Agent": "lammap (github.com/mlhollestelle/lammap)" };
// Returns parsed JSON, or null for 204 (no data in the window).
function get(url) {
  return withRetry(async () => {
    const res = await timedFetch(url, { headers: HEADERS }, wait);
    if (res.status === 204) return null;
    if (!res.ok) throw httpError(res);
    return res.json();
  });
}
const ddmmyyyy = (date) => iso(date).split("-").reverse().join("");

// ---------- sites and stations ----------
const typeOf = (s) => s.Description.split(" ")[0]; // MIDAS, TMU, TAME
const dirOf = (s) => s.Description.split(";").at(-1).trim();
function roadOf(s) {
  if (typeOf(s) === "MIDAS") return s.Name.split("/")[0];
  return s.Description.match(/ on (?:link )?(A\d+\(M\)|A\d+M?|M\d+)\b/)?.[1] ?? null;
}
const linkOf = (s) => (typeOf(s) === "MIDAS" ? s.Description.match(/on link (\d+)/)?.[1] ?? null : null);
// "A21 southbound between B2079 and A268" -> "A21 between B2079 and A268".
function placeOf(s) {
  const m = s.Description.match(/ on (?:link )?(.+?);/);
  return m ? m[1].replace(/ (north|south|east|west)bound| (anti-)?clockwise/gi, "") : s.Name;
}
function metres(a, b) {
  const dx = (a.Longitude - b.Longitude) * 111320 * Math.cos((a.Latitude * Math.PI) / 180);
  return Math.hypot(dx, (a.Latitude - b.Latitude) * 110540);
}

// The active main-carriageway sites: MIDAS sites ending in A or B (J, K, L and M are slip roads), and
// TMU and TAME sites whose description isn't a slip road.
function wanted(s) {
  if (s.Status !== "Active" || !OPPOSITE[dirOf(s)] || !roadOf(s)) return false;
  const type = typeOf(s);
  if (type === "MIDAS") return /\/\d+[AB]$/.test(s.Name);
  if (type === "TMU" || type === "TAME") return !/\b(access|exit|slip|entry)\b/i.test(s.Description);
  return false;
}

// Pairs each site with its nearest opposite-direction site of the same type on the same road, if
// they are each other's nearest. Returns stations as [d1, d2] or [site].
function pairSites(sites) {
  const cell = (s, dy = 0, dx = 0) => `${Math.round(s.Latitude * 100) + dy},${Math.round(s.Longitude * 60) + dx}`;
  const grid = new Map();
  for (const s of sites) {
    const c = cell(s);
    if (!grid.has(c)) grid.set(c, []);
    grid.get(c).push(s);
  }
  const nearest = new Map();
  for (const s of sites) {
    let best = null, bestM = MAX_PAIR_M;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      for (const t of grid.get(cell(s, dy, dx)) ?? []) {
        if (dirOf(t) !== OPPOSITE[dirOf(s)] || roadOf(t) !== roadOf(s) || typeOf(t) !== typeOf(s)) continue;
        const m = metres(s, t);
        if (m <= bestM) { best = t; bestM = m; }
      }
    }
    if (best) nearest.set(s, best);
  }
  const done = new Set();
  const stations = [];
  for (const s of sites) {
    if (done.has(s)) continue;
    const t = nearest.get(s);
    if (t && nearest.get(t) === s) {
      stations.push(FIRST.has(dirOf(s)) ? [s, t] : [t, s]);
      done.add(t);
    } else {
      stations.push([s]);
    }
    done.add(s);
  }
  return stations;
}

// One MIDAS station per road link: pairs first, then single sites for links no pair covers. The order
// only depends on the site list, so the same stations are kept from run to run.
function thinMidas(stations) {
  const sorted = [...stations].sort((a, b) => b.length - a.length || a[0].Name.localeCompare(b[0].Name));
  const covered = new Set();
  return sorted.filter((st) => {
    if (typeOf(st[0]) !== "MIDAS") return true;
    const links = st.map(linkOf).filter(Boolean);
    if (links.length && links.every((l) => covered.has(l))) return false;
    for (const l of links) covered.add(l);
    return true;
  });
}

async function listStations() {
  const { sites } = await get(`${API}/sites`);
  const stations = thinMidas(pairSites(sites.filter(wanted)));
  return stations.map((st) => {
    const [a, b] = st;
    const type = typeOf(a);
    return {
      id: st.map((s) => s.Id).join("-"),
      sites: st.map((s) => ({ id: s.Id, name: s.Name })),
      name: type === "MIDAS" ? (b ? `${a.Name} / ${b.Name.split("/")[1]}` : a.Name) : placeOf(a),
      source: `National Highways ${type}`,
      road: roadOf(a),
      lat: b ? (a.Latitude + b.Latitude) / 2 : a.Latitude,
      lon: b ? (a.Longitude + b.Longitude) / 2 : a.Longitude,
      dirs: b ? [dirOf(a), dirOf(b)] : null,
      // A station counting one carriageway names its direction.
      oneWay: b ? null : dirOf(a),
    };
  });
}

// The newest day with data: WebTRIS publishes whole months, so a few sites spread over the list tell.
async function newestDay(stations) {
  const today = localToday("Europe/London");
  const from = ddmmyyyy(addDays(today, -400));
  let newest = null;
  const step = Math.max(1, Math.floor(stations.length / 8));
  for (let i = 0; i < stations.length; i += step) {
    const site = stations[i].sites[0].id;
    const q = await get(`${API}/quality/daily?siteId=${site}&start_date=${from}&end_date=${ddmmyyyy(today)}`);
    for (const d of q?.Qualities ?? []) {
      const k = key(new Date(`${d.Date.slice(0, 10)}T00:00:00Z`));
      if (d.Quality > 0 && (!newest || k > newest)) newest = k;
    }
  }
  return newest;
}

// ---------- parse ----------
// Adds a page of 15-minute rows to per-site hourly sums: Map(site name -> Map(YYYYMMDD -> { v, n })),
// with v the 24 hourly sums and n the intervals counted per hour.
function addRows(acc, rows) {
  for (const r of rows) {
    if (r["Total Volume"] === "" || r["Total Volume"] == null) continue;
    // On the autumn DST day WebTRIS lists the repeated hour's intervals again, without counts.
    const k = r["Report Date"].slice(0, 10).replace(/-/g, "");
    const h = Number(r["Time Period Ending"].slice(0, 2));
    if (!acc.has(r["Site Name"])) acc.set(r["Site Name"], new Map());
    const days = acc.get(r["Site Name"]);
    if (!days.has(k)) days.set(k, { v: Array(24).fill(0), n: Array(24).fill(0) });
    const d = days.get(k);
    d.v[h] += Number(r["Total Volume"]);
    d.n[h]++;
  }
}

// Complete days of one site: Map(YYYYMMDD -> [h00..h23, total]).
function completeDays(days, start, end) {
  const out = new Map();
  for (const [k, { v, n }] of days ?? []) {
    if (k < start || k > end) continue;
    if (n.filter((c) => c >= 4).length < MIN_HOURS) continue;
    const total = v.reduce((a, b) => a + b, 0);
    out.set(k, [...v, total]);
  }
  return out;
}

function toMaps(station, acc, start, end) {
  const [a, b] = station.sites.map((s) => completeDays(acc.get(s.name), start, end));
  const maps = { all: new Map(), d1: new Map(), d2: new Map() };
  if (!b) {
    for (const [k, v] of a) if (v[24]) maps.all.set(k, v);
    return maps;
  }
  for (const [k, v1] of a) {
    const v2 = b.get(k);
    if (!v2 || !(v1[24] + v2[24])) continue; // both carriageways complete, and not a stuck counter
    maps.d1.set(k, v1);
    maps.d2.set(k, v2);
    maps.all.set(k, v1.map((x, i) => x + v2[i]));
  }
  return maps;
}

// Rows for a batch of stations from start to end, page by page. Returns the hourly sums by site name.
async function fetchBatch(batch, start, end) {
  const sites = batch.flatMap((st) => st.sites.map((s) => s.id)).join(",");
  const acc = new Map();
  for (let page = 1; ; page++) {
    const body = await get(`${API}/reports/Daily?sites=${sites}&start_date=${ddmmyyyy(start)}&end_date=${ddmmyyyy(end)}&page=${page}&page_size=${PAGE}`);
    if (!body) break;
    addRows(acc, body.Rows);
    if (page * PAGE >= body.Header.row_count) break;
  }
  return acc;
}

// Batches of stations with at most BATCH_SITES sites and no site name twice (rows only carry the name).
function batches(stations) {
  const out = [];
  let cur = [], n = 0, names = new Set();
  for (const st of stations) {
    if (n + st.sites.length > BATCH_SITES || st.sites.some((s) => names.has(s.name))) {
      out.push(cur);
      cur = []; n = 0; names = new Set();
    }
    cur.push(st);
    n += st.sites.length;
    for (const s of st.sites) names.add(s.name);
  }
  if (cur.length) out.push(cur);
  return out;
}

// ---------- main ----------
async function main() {
  const dir = path.join(OUT, "eng");
  await mkdir(dir, { recursive: true });
  const listFile = path.join(dir, "stations.json");
  const previous = new Map(((await readJson(listFile)) ?? []).map((s) => [s.id, s]));
  let stations = await listStations();
  const newest = await newestDay(stations);
  if (args.stations) {
    // Station ids, or the WebTRIS site ids in them.
    const wantedIds = new Set(String(args.stations).split(","));
    stations = stations.filter((s) => wantedIds.has(s.id) || s.sites.some((x) => wantedIds.has(x.id)));
  }
  if (!newest) {
    console.log("::warning::England: no WebTRIS data found in the last 400 days");
    process.exit(1);
  }
  const END = fromKey(newest);
  const START = addDays(END, -(DAYS - 1));
  const OLDEST_KEPT = key(addDays(END, -(KEEP - 1)));

  // Each station's own window: from the day after it was last fetched through, or the whole window if
  // it doesn't reach back to START yet. Published data doesn't change, so fetched days aren't refetched.
  const groups = new Map(); // start key -> stations
  for (const st of stations) {
    const prev = previous.get(st.id);
    let from = key(START);
    if (prev?.to && prev.from <= key(START)) {
      if (prev.to >= newest) continue;
      from = [key(addDays(fromKey(prev.to), 1)), OLDEST_KEPT].sort().at(-1);
    }
    if (!groups.has(from)) groups.set(from, []);
    groups.get(from).push(st);
  }
  const todo = [...groups.values()].reduce((a, g) => a + g.length, 0);
  console.log(`WebTRIS data up to ${iso(END)}; ${todo} of ${stations.length} English stations to fetch ` +
    `(window from ${iso(START)}), keeping ${KEEP} days`);

  const list = new Map();
  const failed = [];
  let fetched = 0, batchNo = 0, stopped = false, failedInRow = 0, broken = false;
  outer:
  for (const [fromK, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const start = fromKey(fromK);
    for (const batch of batches(group)) {
      if (Date.now() > DEADLINE) { stopped = true; break outer; }
      let acc;
      try {
        acc = await fetchBatch(batch, start, END);
      } catch (e) {
        console.error(`Batch from ${fromK} (${batch.map((s) => s.id).join(",")}): ${e.message}`);
        failed.push(...batch.map((s) => s.id));
        if (++failedInRow >= MAX_FAILED_BATCHES) { broken = true; break outer; }
        continue;
      }
      failedInRow = 0;
      for (const st of batch) {
        const file = path.join(dir, `${st.id}.json`);
        const stored = (await readJson(file)) ?? {};
        const maps = toMaps(st, acc, fromK, newest);
        const data = { id: st.id, ...mergeDirs(stored, maps, OLDEST_KEPT) };
        fetched++;
        const prev = previous.get(st.id);
        const keepsFrom = prev?.from && prev.from <= fromK && prev.from >= OLDEST_KEPT;
        const entry = {
          id: st.id, name: st.name, source: st.source, city: null, road: st.road, mode: "car",
          lat: st.lat, lon: st.lon, dirs: st.dirs, oneWay: st.oneWay, sites: st.sites.map((s) => s.id),
          from: keepsFrom ? prev.from : fromK, to: newest,
        };
        const dayKeys = Object.keys(data.all);
        if (dayKeys.length) {
          await writeFile(file, JSON.stringify(data));
          Object.assign(entry, { last: dayKeys.at(-1), days: dayKeys.length });
        }
        list.set(st.id, entry);
      }
      if (++batchNo % 10 === 0) console.log(`  ${fetched} of ${todo} stations`);
    }
  }
  // Stations not fetched this time (up to date, failed or past the deadline) keep their entry.
  for (const [id, s] of previous) if (!list.has(id)) list.set(id, s);
  // Stations without a complete day in the kept window stay in the list without "last", so they aren't
  // fetched again; the page skips them.
  const out = [...list.values()].map((s) => {
    if (!s.last || s.last >= OLDEST_KEPT) return s;
    const { last, days, ...rest } = s;
    return rest;
  });
  await writeFile(listFile, JSON.stringify(out));
  const withData = out.filter((s) => s.last);
  const stop = stopped ? ", stopped at the time limit" : broken ? `, stopped after ${MAX_FAILED_BATCHES} failed batches in a row` : "";
  console.log(`Done: ${fetched} stations fetched, ${failed.length} failed${stop}; ` +
    `${withData.length} stations with data (${countBy(withData, "source")})`);
  if (stopped) console.log("::warning::England: stopped at the time limit, the next run continues");
  if (broken) console.log("::warning::England: the API kept failing, stopped; the next run continues");
  if (broken || failed.length > todo * 0.1) process.exit(1);
  if (failed.length) console.log(`::warning::${failed.length} English stations failed: ${failed.join(", ")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
