// Fetches the Norwegian Public Roads Administration's (Statens vegvesen) traffic registration points from
// its GraphQL API: motor vehicle and bicycle counters on national, county and municipal roads. Hourly
// volumes are merged into one JSON file per point in the same format as scripts/ingest.mjs, plus a
// station list. Run by .github/workflows/ingest.yml, which syncs the output directory with the R2 bucket.
//
//   node scripts/ingest-nor.mjs [--days 7] [--keep 366] [--out data] [--points 52742V2282262,...]
//                               [--skip-existing] [--max-minutes 90]
//
// Output:
//   <out>/nor/<point>.json     { id, all, d1, d2 }, each a map YYYYMMDD -> [h00..h23, total]
//   <out>/nor/stations.json    [{ id, name, source, city, road, mode, lat, lon, dirs, last, days, from }]
//
// Days are Norwegian local days. Only points that reported in the fetched window are fetched; points
// fetched earlier stay in the list while their data is kept. A year for all points takes about 6 hours,
// so --max-minutes stops the run in time and --skip-existing continues it: it skips points already
// fetched from the start of the window ("from" in the station list).

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { addDays, countBy, dateWindow, httpError, iso, key, localDayHour, mergeDirs, parseArgs, readJson, throttle, timedFetch, withRetry } from "./lib.mjs";

const API = "https://trafikkdata-api.atlas.vegvesen.no/";
const MIN_GAP_MS = 300;
// Points per request (as GraphQL aliases) and hours per point per request; the API allows at most 100.
const BATCH = 50;
const PAGE = 100;
// Failed batches in a row (each after its retries) before the run gives up on the API.
const MAX_FAILED_BATCHES = 3;
const MODES = { VEHICLE: "car", BICYCLE: "bike" };
// An hour counts only if the point covered at least this share of it; a day is kept only if every
// hour counts (23 on the spring DST day).
const MIN_COVERAGE = 95;
const MIN_HOURS = 23;

const args = parseArgs(process.argv.slice(2));
const DAYS = Number(args.days ?? 7);
const KEEP = Number(args.keep ?? 366);
const OUT = args.out ?? "data";
const SKIP_EXISTING = Boolean(args["skip-existing"]);
const DEADLINE = args["max-minutes"] ? Date.now() + Number(args["max-minutes"]) * 60_000 : Infinity;

// Norwegian local days.
const { END, START, OLDEST_KEPT } = dateWindow("Europe/Oslo", DAYS, KEEP);
const dayHour = localDayHour("Europe/Oslo");
// A day either side in UTC, so the local days at both ends are whole; the extra hours are dropped.
const FROM = `${iso(addDays(START, -1))}T00:00:00Z`;
const TO = `${iso(addDays(END, 2))}T00:00:00Z`;

// ---------- fetch ----------
const wait = throttle(MIN_GAP_MS);
// Returns { data, errors }: one point's error leaves the other aliases' data in place.
function gql(query) {
  return withRetry(async () => {
    const res = await timedFetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "lammap (github.com/mlhollestelle/lammap)" },
      body: JSON.stringify({ query }),
    }, wait);
    if (!res.ok) throw httpError(res);
    const body = await res.json();
    if (body.data) return body;
    // The API answers a whole query with an error now and then, often for minutes at a time.
    throw Object.assign(new Error(body.errors?.[0]?.message ?? "no data"), { retry: true, slow: true });
  }, { delay: (err) => (err.slow ? 30_000 : 5_000) });
}

// "EV6 S26D1 m1470" -> "E6", "RV4 ..." -> "Rv. 4", "FV7874 ..." -> "Fv. 7874", "KV1012 ..." -> "Kv. 1012".
function roadName(shortForm) {
  const m = shortForm?.match(/^([ERFKPS])V(\d+)/);
  if (!m) return null;
  return m[1] === "E" ? `E${m[2]}` : `${m[1]}v. ${m[2]}`;
}

async function listPoints() {
  const { data } = await gql(`{ trafficRegistrationPoints { id name trafficRegistrationType
    location { coordinates { latLon { lat lon } } municipality { name } roadReference { shortForm } }
    direction { from to } dataTimeSpan { latestData { volumeByHour } } } }`);
  return data.trafficRegistrationPoints
    .filter((p) => MODES[p.trafficRegistrationType] && p.location?.coordinates?.latLon)
    .map((p) => ({
      id: p.id,
      name: p.name.trim(),
      mode: MODES[p.trafficRegistrationType],
      city: p.location.municipality?.name ?? null,
      road: roadName(p.location.roadReference?.shortForm),
      lat: p.location.coordinates.latLon.lat,
      lon: p.location.coordinates.latLon.lon,
      to: p.direction?.to?.trim() || null,
      from: p.direction?.from?.trim() || null,
      latest: p.dataTimeSpan?.latestData?.volumeByHour ?? null,
    }));
}

const HOUR_FIELDS = `edges { node { from total { volumeNumbers { volume } coverage { percentage } }
  byDirection { heading total { volumeNumbers { volume } coverage { percentage } } } } }
  pageInfo { hasNextPage endCursor }`;

// Hourly volumes of a batch of points, paging each point until it is done. Returns Map(id -> nodes),
// without the points that failed (listed in "failed").
async function fetchBatch(points, failed) {
  const nodes = new Map(points.map((p) => [p.id, []]));
  let pending = points.map((p) => ({ id: p.id, after: null }));
  while (pending.length) {
    const query = `{ ${pending.map((p, i) => `p${i}: trafficData(trafficRegistrationPointId: ${JSON.stringify(p.id)}) {
      volume { byHour(from: "${FROM}", to: "${TO}", first: ${PAGE}${p.after ? `, after: ${JSON.stringify(p.after)}` : ""}) { ${HOUR_FIELDS} } } }`).join("\n")} }`;
    const { data, errors } = await gql(query);
    const next = [];
    pending.forEach((p, i) => {
      const byHour = data[`p${i}`]?.volume?.byHour;
      if (!byHour) {
        const e = errors?.find((x) => x.path?.[0] === `p${i}`);
        console.error(`Point ${p.id}: ${e?.message ?? "no data"}`);
        failed.push(p.id);
        nodes.delete(p.id);
        return;
      }
      nodes.get(p.id).push(...byHour.edges.map((e) => e.node));
      if (byHour.pageInfo.hasNextPage) next.push({ id: p.id, after: byHour.pageInfo.endCursor });
    });
    pending = next;
  }
  return nodes;
}

// ---------- parse ----------
// The two directions are named after where they lead: direction 1 towards the point's "to", direction 2
// towards its "from". A heading that matches neither (renamed since) takes the slot that is still free.
function toDays(point, nodes) {
  const maps = { all: new Map(), d1: new Map(), d2: new Map() };
  const hours = { all: new Map(), d1: new Map(), d2: new Map() }; // YYYYMMDD -> Set of complete hours
  const slots = new Map();
  if (point.to) slots.set(point.to.toLowerCase(), "d1");
  if (point.from) slots.set(point.from.toLowerCase(), "d2");
  const dirNames = { d1: point.to, d2: point.from };
  const slotOf = (heading) => {
    const h = heading.trim();
    if (!slots.has(h.toLowerCase())) {
      const used = new Set(slots.values());
      const free = ["d1", "d2"].find((d) => !used.has(d));
      slots.set(h.toLowerCase(), free ?? null);
      if (free) dirNames[free] = h;
    }
    return slots.get(h.toLowerCase());
  };
  const add = (dir, k, h, total) => {
    const volume = total?.volumeNumbers?.volume;
    if (volume == null || (total.coverage?.percentage ?? 0) < MIN_COVERAGE) return;
    if (!maps[dir].has(k)) { maps[dir].set(k, Array(25).fill(0)); hours[dir].set(k, new Set()); }
    const v = maps[dir].get(k);
    v[h] += volume;
    v[24] += volume;
    hours[dir].get(k).add(h);
  };
  for (const n of nodes) {
    // Norwegian day and hour; on the autumn DST change both 02:00 hours land in the same slot.
    const [k, h] = dayHour(new Date(n.from));
    add("all", k, h, n.total);
    for (const d of n.byDirection ?? []) {
      const dir = slotOf(d.heading ?? "");
      if (dir) add(dir, k, h, d.total);
    }
  }
  // Days with a missing or partly covered hour are left out, and so are days outside the window.
  for (const dir of Object.keys(maps)) {
    for (const k of [...maps[dir].keys()]) {
      if (hours[dir].get(k).size < MIN_HOURS || k < key(START) || k > key(END)) maps[dir].delete(k);
    }
  }
  // A whole day of zeros is a stuck counter.
  for (const [k, v] of maps.all) {
    if (!v[24]) for (const m of Object.values(maps)) m.delete(k);
  }
  return { maps, dirNames };
}

// ---------- main ----------
async function main() {
  const dir = path.join(OUT, "nor");
  await mkdir(dir, { recursive: true });
  const listFile = path.join(dir, "stations.json");
  const previous = new Map(((await readJson(listFile)) ?? []).map((s) => [s.id, s]));
  const all = await listPoints();
  // Points that reported in the window; the rest have nothing new to fetch.
  let points = all.filter((p) => p.latest && p.latest.slice(0, 10) >= iso(START));
  if (args.points) {
    const wanted = new Set(String(args.points).split(","));
    points = points.filter((p) => wanted.has(p.id));
  }
  const skipped = SKIP_EXISTING ? points.filter((p) => previous.get(p.id)?.from <= key(START)) : [];
  points = points.filter((p) => !skipped.includes(p));
  console.log(`Fetching ${iso(START)} – ${iso(END)} for ${points.length} Norwegian points (${skipped.length} skipped), keeping ${KEEP} days`);

  const list = new Map();
  const failed = [];
  let fetched = 0, stopped = false, failedInRow = 0, broken = false;
  for (let i = 0; i < points.length; i += BATCH) {
    if (Date.now() > DEADLINE) { stopped = true; break; }
    const batch = points.slice(i, i + BATCH);
    let nodes;
    try {
      nodes = await fetchBatch(batch, failed);
    } catch (e) {
      console.error(`Batch ${i / BATCH + 1}: ${e.message}`);
      failed.push(...batch.map((p) => p.id));
      // Batches failing even after the retries mean the API is down; the rest waits for the next run.
      if (++failedInRow >= MAX_FAILED_BATCHES) { broken = true; break; }
      continue;
    }
    failedInRow = 0;
    for (const p of batch) {
      if (!nodes.has(p.id)) continue;
      const file = path.join(dir, `${p.id}.json`);
      const stored = (await readJson(file)) ?? {};
      const { maps, dirNames } = toDays(p, nodes.get(p.id));
      const data = { id: p.id, ...mergeDirs(stored, maps, OLDEST_KEPT) };
      fetched++;
      const dayKeys = Object.keys(data.all);
      if (!dayKeys.length) continue; // no complete day in the kept window
      await writeFile(file, JSON.stringify(data));
      const split = Object.keys(data.d1).length && Object.keys(data.d2).length;
      const dirs = split ? [dirNames.d1, dirNames.d2].map((n, j) => (n ? `Towards ${n}` : `Direction ${j + 1}`)) : null;
      const prevFrom = previous.get(p.id)?.from;
      list.set(p.id, {
        id: p.id, name: p.name, source: "Statens vegvesen", city: p.city, road: p.road, mode: p.mode,
        lat: p.lat, lon: p.lon, dirs, last: dayKeys.at(-1), days: dayKeys.length,
        from: prevFrom && prevFrom < key(START) ? prevFrom : key(START),
      });
    }
    console.log(`  ${Math.min(i + BATCH, points.length)} of ${points.length} points`);
  }
  // Points not fetched this time (skipped, failed, past the deadline or without new data) keep their
  // entry while they have data in the kept window.
  for (const [id, s] of previous) if (!list.has(id) && s.last >= OLDEST_KEPT) list.set(id, s);
  await writeFile(listFile, JSON.stringify([...list.values()]));
  const stop = stopped ? ", stopped at the time limit" : broken ? `, stopped after ${MAX_FAILED_BATCHES} failed batches in a row` : "";
  console.log(`Done: ${fetched} points fetched, ${failed.length} failed${stop}; ` +
    `${list.size} points with data (${countBy([...list.values()], "mode")})`);
  if (stopped) console.log(`::warning::Norway: stopped at the time limit, run again with skip_existing to continue`);
  if (broken) console.log(`::warning::Norway: the API kept failing, stopped; run again with skip_existing to continue`);
  if (broken || failed.length > points.length * 0.1) process.exit(1);
  if (failed.length) console.log(`::warning::${failed.length} Norwegian points failed: ${failed.join(", ")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
