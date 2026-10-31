// Downloads Digitraffic's raw per-vehicle LAM files and aggregates them into 5-minute
// intervals per lane, for the flow–speed (fundamental) diagrams.
//
//   node scripts/ingest-fd.mjs [--days 7] [--out data] [--stations 101,102] [--existing keys.txt]
//
// Only days that are missing are fetched: a day is skipped when <out>/fd/<date>/<tms>.json exists,
// or when its key appears in --existing (a listing of the bucket, e.g. `aws s3 ls --recursive`),
// so a failed run is caught up by the next one. Files are grouped by date, so that listing only
// needs the last few date prefixes.
//
// Output: <out>/fd/<YYYY-MM-DD>/<tms>.json
//   { tms, date, interval: 5, lanes: [{ lane, dir, n, heavy, vh, va }] }
//   Each array has one value per 5-minute interval of the Finnish day (288):
//   n = vehicles, heavy = trucks and buses, vh/va = harmonic/arithmetic mean speed in km/h × 10
//   (0 when n is 0). Flow is n × 12 veh/h; density can be estimated as flow / harmonic speed.

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { addDays, httpError, iso, localToday, parseArgs, timedFetch, withRetry } from "./lib.mjs";

const API = "https://tie.digitraffic.fi/api/tms/v1";
const HEADERS = { "Digitraffic-User": "lammap/ingest" };
// The raw files are static files behind a CDN, not the throttled report API, so a few
// requests at a time are fine.
const CONCURRENCY = 4;
const INTERVAL = 5; // minutes
const SLOTS = (24 * 60) / INTERVAL;
const HEAVY = new Set([2, 3, 4, 5, 9]); // trucks, buses, semi-trailers, trucks with trailer, HCT

const args = parseArgs(process.argv.slice(2));
const DAYS = Number(args.days ?? 7);
const OUT = args.out ?? "data";

function dayOfYear(date) { return Math.round((date - Date.UTC(date.getUTCFullYear(), 0, 1)) / 86400000) + 1; }

// ---------- fetch ----------
// Returns the file's text, or null when Digitraffic has no file for that station and day
// (the CDN answers 403 or 404).
function fetchRaw(tms, date) {
  const url = `${API}/history/raw/lamraw_${tms}_${date.getUTCFullYear() % 100}_${dayOfYear(date)}.csv`;
  return withRetry(async () => {
    const res = await timedFetch(url, { headers: HEADERS });
    if (res.ok) return res.text();
    if (res.status === 403 || res.status === 404) return null;
    throw httpError(res);
  });
}

// Fields: station; year; day; hour; minute; second; 1/100 s; length; lane; direction; class;
// speed; faulty; ... (https://www.digitraffic.fi/en/road-traffic/lam/)
// On the autumn DST change the hour 03 repeats, so that hour's intervals hold two hours of vehicles.
function aggregate(text) {
  const lanes = new Map();
  for (const line of text.split("\n")) {
    const c = line.split(";");
    if (c.length < 13 || c[12].trim() !== "0") continue; // faulty or incomplete record
    const speed = Number(c[11]);
    if (!(speed > 0)) continue;
    const slot = Math.floor((Number(c[3]) * 60 + Number(c[4])) / INTERVAL);
    if (!(slot >= 0 && slot < SLOTS)) continue;
    const id = `${c[9]}:${c[8]}`;
    let l = lanes.get(id);
    if (!l) {
      l = { lane: Number(c[8]), dir: Number(c[9]), n: new Array(SLOTS).fill(0), heavy: new Array(SLOTS).fill(0),
        inv: new Array(SLOTS).fill(0), sum: new Array(SLOTS).fill(0) };
      lanes.set(id, l);
    }
    l.n[slot]++;
    if (HEAVY.has(Number(c[10]))) l.heavy[slot]++;
    l.inv[slot] += 1 / speed;
    l.sum[slot] += speed;
  }
  return [...lanes.values()]
    .sort((a, b) => a.dir - b.dir || a.lane - b.lane)
    .map(({ lane, dir, n, heavy, inv, sum }) => ({
      lane, dir, n, heavy,
      vh: n.map((k, i) => (k ? Math.round((k / inv[i]) * 10) : 0)),
      va: n.map((k, i) => (k ? Math.round((sum[i] / k) * 10) : 0)),
    }));
}

// Keys like "fd/2026-10-14/101.json" from a bucket listing, so stored days aren't refetched.
async function readExisting(file) {
  if (!file) return new Set();
  const text = await readFile(file, "utf8");
  return new Set(text.match(/fd\/\d{4}-\d{2}-\d{2}\/\d+\.json/g) ?? []);
}

// ---------- main ----------
async function main() {
  let tmsList;
  if (args.stations) {
    tmsList = String(args.stations).split(",").map(Number);
  } else {
    const res = await fetch(`${API}/stations`, { headers: HEADERS });
    if (!res.ok) throw new Error(`Stations: HTTP ${res.status}`);
    tmsList = (await res.json()).features.map((f) => f.properties.tmsNumber);
  }
  const existing = await readExisting(args.existing);
  const end = addDays(localToday("Europe/Helsinki"), -1); // the raw files use Finnish days
  const dates = Array.from({ length: DAYS }, (_, i) => addDays(end, -i));

  const jobs = [];
  for (const tms of tmsList) {
    for (const date of dates) {
      const k = `fd/${iso(date)}/${tms}.json`;
      if (!existing.has(k) && !existsSync(path.join(OUT, k))) jobs.push({ tms, date, file: path.join(OUT, k) });
    }
  }
  console.log(`${iso(dates[dates.length - 1])} – ${iso(end)}, ${tmsList.length} stations: ${jobs.length} station-days to fetch`);

  let done = 0, written = 0, absent = 0;
  const failed = [];
  async function worker() {
    for (let job; (job = jobs.shift()); ) {
      try {
        const text = await fetchRaw(job.tms, job.date);
        if (text === null) absent++;
        else {
          const lanes = aggregate(text);
          await mkdir(path.dirname(job.file), { recursive: true });
          await writeFile(job.file, JSON.stringify({ tms: job.tms, date: iso(job.date), interval: INTERVAL, lanes }));
          written++;
        }
      } catch (e) {
        failed.push(`${job.tms}/${iso(job.date)}`);
        console.error(`Station ${job.tms} ${iso(job.date)}: ${e.message}`);
      }
      if (++done % 500 === 0) console.log(`${done} done`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(`Done: ${written} written, ${absent} not published, ${failed.length} failed`);
  if (failed.length) console.log(`::warning::${failed.length} station-days failed: ${failed.slice(0, 50).join(", ")}`);
  if (failed.length > (written + failed.length) * 0.1) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
