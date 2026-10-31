// Fetches the Oulu region's cycle and pedestrian counters from Oulunliikenne's GraphQL API (Eco-Counter
// devices run by the City of Oulu and the ELY Centre). Hourly sums are merged into one JSON file per
// counter in the same format as scripts/ingest.mjs, plus a station list. Run by
// .github/workflows/ingest.yml, which syncs the output directory with the R2 bucket.
//
//   node scripts/ingest-oulu.mjs [--days 7] [--keep 366] [--out data] [--counters raatti-bike,OULU119-bike]
//
// Output:
//   <out>/oulu/<counter>.json   { id, all, d1, d2 }, each a map YYYYMMDD -> [h00..h23, total]
//   <out>/oulu/stations.json    [{ id, name, source, mode, lat, lon, dirs, last, days }], counters with data
//
// A site that counts both cyclists and pedestrians becomes two counters, "<site>-bike" and
// "<site>-pedestrian". The API's car counters (LAM) are Fintraffic's, which the map already shows.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { addDays, countBy, dateWindow, fetchJson, iso, key, localDayHour, mergeDirs, parseArgs, readJson, throttle } from "./lib.mjs";

const API = "https://api.oulunliikenne.fi/proxy/graphql";
const MIN_GAP_MS = 300;
const CHUNK_DAYS = 120; // a year of hours in one request works, but keep the responses small
const MODES = { 1: "pedestrian", 2: "bike" };
// Who runs the counters in each of the API's domains.
const SOURCES = {
  Oulu_kaupunki: "City of Oulu",
  Oulu_Kapy: "City of Oulu",
  Oulu_TPM: "City of Oulu",
  Oulu_ELY: "ELY Centre",
};
// A day is kept only if every channel reported at least this many hours (23 on the spring DST day).
const MIN_HOURS = 23;

const args = parseArgs(process.argv.slice(2));
const DAYS = Number(args.days ?? 7);
const KEEP = Number(args.keep ?? 366);
const OUT = args.out ?? "data";

// Finnish local days; the API takes local times and answers in UTC.
const { END, START, OLDEST_KEPT } = dateWindow("Europe/Helsinki", DAYS, KEEP);
const dayHour = localDayHour("Europe/Helsinki");

// ---------- fetch ----------
const wait = throttle(MIN_GAP_MS);
// GraphQL errors are not retried: they mean a bad query, not a busy API.
async function gql(query) {
  const body = await fetchJson(API, {
    wait,
    init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }) },
  });
  if (body.errors) throw new Error(body.errors[0].message);
  return body.data;
}

async function listCounters() {
  const { ecoCounterSites } = await gql(`{ ecoCounterSites { siteId name domain channels { siteId name userType sens lat lon } } }`);
  const out = [];
  for (const s of ecoCounterSites) {
    if (!s) continue;
    for (const [userType, mode] of Object.entries(MODES)) {
      const channels = (s.channels ?? []).filter((c) => String(c.userType) === userType);
      if (!channels.length) continue;
      out.push({
        id: `${s.siteId}-${mode}`, name: s.name, domain: s.domain, source: SOURCES[s.domain] ?? s.domain, mode,
        lat: channels[0].lat, lon: channels[0].lon, channels,
      });
    }
  }
  return out;
}

// The two directions of a site. The city's own sites say "towards/from the centre"; elsewhere the
// channels are only IN/OUT or loop names, so the directions get no name.
function direction(c) {
  if (/keskustaan$/i.test(c.name)) return ["d1", "Towards the centre"];
  if (/keskustasta$/i.test(c.name)) return ["d2", "From the centre"];
  // Eco-Counter's direction codes come in pairs (1/2, 6/8, 7/9); the ELY counters have none and say IN/OUT.
  if ([1, 6, 7].includes(c.sens)) return ["d1", null];
  if ([2, 8, 9].includes(c.sens)) return ["d2", null];
  if (/_IN$/i.test(c.name)) return ["d1", null];
  if (/_OUT$/i.test(c.name)) return ["d2", null];
  return ["all", null];
}

// Hourly counts of one channel. Returns [{ date (UTC ISO), counts }], counts null for missing hours.
async function fetchHours(channel, domain) {
  const rows = [];
  for (let from = START; from <= END; from = addDays(from, CHUNK_DAYS)) {
    const to = new Date(Math.min(addDays(from, CHUNK_DAYS), addDays(END, 1))); // end is exclusive
    const data = await gql(`{ ecoCounterSiteData(id: ${JSON.stringify(channel.siteId)}, domain: ${domain}, step: hour,
      begin: "${iso(from)}T00:00:00", end: "${iso(to)}T00:00:00") { date counts } }`);
    rows.push(...(data.ecoCounterSiteData ?? []));
  }
  return rows;
}

// ---------- parse ----------
function toDays(perChannel) {
  const maps = { all: new Map(), d1: new Map(), d2: new Map() };
  const dirNames = { d1: null, d2: null };
  const hoursSeen = perChannel.map(() => new Map()); // per channel: YYYYMMDD -> Set of hours
  perChannel.forEach(({ channel, rows }, i) => {
    const [dir, name] = direction(channel);
    if (name) dirNames[dir] = name;
    for (const r of rows) {
      if (r.counts == null) continue;
      // Finnish day and hour; on the autumn DST change both 03:00 hours land in the same slot.
      const [k, h] = dayHour(new Date(r.date));
      if (!maps[dir].has(k)) maps[dir].set(k, Array(25).fill(0));
      const v = maps[dir].get(k);
      v[h] += r.counts;
      v[24] += r.counts;
      if (!hoursSeen[i].has(k)) hoursSeen[i].set(k, new Set());
      hoursSeen[i].get(k).add(h);
    }
  });
  // A day is shown only if every channel reported it in full. A whole day of zeros is a stuck counter.
  const allKeys = new Set(Object.values(maps).flatMap((m) => [...m.keys()]));
  for (const k of allKeys) {
    const complete = hoursSeen.every((seen) => (seen.get(k)?.size ?? 0) >= MIN_HOURS);
    const total = Object.values(maps).reduce((t, m) => t + (m.get(k)?.[24] ?? 0), 0);
    if (!complete || !total || k < key(START) || k > key(END)) for (const m of Object.values(maps)) m.delete(k);
  }
  return { maps, dirNames };
}

// ---------- main ----------
async function main() {
  const dir = path.join(OUT, "oulu");
  await mkdir(dir, { recursive: true });
  const listFile = path.join(dir, "stations.json");
  const previous = new Map(((await readJson(listFile)) ?? []).map((s) => [s.id, s]));
  let counters = await listCounters();
  if (args.counters) {
    const wanted = new Set(String(args.counters).split(","));
    counters = counters.filter((c) => wanted.has(c.id));
  }
  console.log(`Fetching ${iso(START)} – ${iso(END)} for ${counters.length} Oulu counters, keeping ${KEEP} days`);

  const list = [];
  const failed = [];
  for (const c of counters) {
    try {
      const perChannel = [];
      for (const channel of c.channels) perChannel.push({ channel, rows: await fetchHours(channel, c.domain) });
      const file = path.join(dir, `${c.id}.json`);
      const stored = (await readJson(file)) ?? {};
      const { maps, dirNames } = toDays(perChannel);
      const data = { id: c.id, ...mergeDirs(stored, maps, OLDEST_KEPT) };
      const dayKeys = [...new Set(["all", "d1", "d2"].flatMap((d) => Object.keys(data[d])))].sort();
      if (!dayKeys.length) continue; // never reported in the kept window
      await writeFile(file, JSON.stringify(data));
      const split = Object.keys(data.d1).length && Object.keys(data.d2).length;
      const dirs = split ? [dirNames.d1 ?? "Direction 1", dirNames.d2 ?? "Direction 2"] : null;
      list.push({ id: c.id, name: c.name, source: c.source, mode: c.mode, lat: c.lat, lon: c.lon, dirs, last: dayKeys.at(-1), days: dayKeys.length });
    } catch (e) {
      failed.push(c.id);
      console.error(`Counter ${c.id} ${c.name}: ${e.message}`);
      // Keep it on the map with its stored data; the next run tries again.
      if (previous.has(c.id)) list.push(previous.get(c.id));
    }
  }
  await writeFile(listFile, JSON.stringify(list));
  console.log(`Done: ${list.length} counters with data (${countBy(list, "mode")}), ${failed.length} failed`);
  if (failed.length > counters.length * 0.1) process.exit(1);
  if (failed.length) console.log(`::warning::${failed.length} Oulu counters failed: ${failed.join(", ")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
