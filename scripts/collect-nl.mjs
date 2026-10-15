// Collects NDW's real-time minute data for Dutch motorway detectors and aggregates it into
// 5-minute intervals per lane, in the same day files as the Finnish fundamental diagrams.
// NDW publishes only the latest minute without an account (history is in Dexter, which needs one),
// so this runs all the time and polls every minute, as a service on a small always-on computer
// (see pi/README.md). The files are read as a stream, so it needs only tens of MB of memory.
//
//   node scripts/collect-nl.mjs [--minutes 0] [--out nl] [--stations 250] [--select] [--keep-days 8]
//                               [--flush-every 30] [--on-flush "cmd"] [--on-live "cmd"]
//
// --minutes 0 (the default) runs until stopped; on SIGTERM or SIGINT the files are written first.
// --select (re)builds the station list; it is also built when <out>/stations.json is missing.
// The list is kept between runs, so the stations (and their history) stay the same.
// --keep-days: day folders older than this many days (today included) are deleted.
// --on-flush runs a shell command after the day files are written (every --flush-every minutes and
// at the end), --on-live after each live.json update (every 5 minutes), e.g. to upload them.
//
// Output:
//   <out>/stations.json         [{ key, name, road, km, lat, lon, sites: { 1: id, 2: id }, lanes: { 1: n, 2: n } }]
//                               direction 1 = right carriageway (hrr), 2 = left carriageway (hrl)
//   <out>/fd/<YYYY-MM-DD>/<key>.json  (gzipped)
//     { key, date, interval: 5, lanes: [{ lane, dir, n, m, nv, vh, va }] }
//     One value per 5-minute interval of the Dutch day (288): n = vehicles, m = minutes with data
//     (0-5, so gaps in the collection can be scaled up or shown), nv = vehicles in minutes with a speed,
//     vh/va = harmonic/arithmetic mean speed in km/h × 10 (0 when nv is 0).
//   <out>/live.json             { updated, stations: { key: [{ dir, lane, q, v, start, end }] } }
//                               the last 5 minutes per lane, for the live dots
//   <out>/state.json            { siteId: last minute counted }, so a minute is never counted twice
//   <out>/meta.json             { updated, end } (end = yesterday, the newest complete day)

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, gunzipSync, gzipSync } from "node:zlib";

// NDW_BASE and NDW_POLL_SECONDS point the script at another copy of the files and poll it faster,
// for testing.
const BASE = process.env.NDW_BASE ?? "https://opendata.ndw.nu";
const MEASURED = `${BASE}/snelheden_en_intensiteiten_meetgegevens.xml.gz`;
const CONFIG = `${BASE}/snelheden_en_intensiteiten_configuratie_meetlocaties.xml.gz`;
const HEADERS = { "User-Agent": "lammap (https://github.com/mlhollestelle/lammap)" };
const INTERVAL = 5; // minutes
const SLOTS = (24 * 60) / INTERVAL;
const POLL_MS = Number(process.env.NDW_POLL_SECONDS ?? 60) * 1000;
const TZ = "Europe/Amsterdam";

const args = parseArgs(process.argv.slice(2));
const MINUTES = Number(args.minutes ?? 0);
const OUT = args.out ?? "nl";
const N_STATIONS = Number(args.stations ?? 250);
const FLUSH_EVERY = Number(args["flush-every"] ?? 30);
const KEEP_DAYS = Number(args["keep-days"] ?? 8);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- fetch ----------
// A copy of a short string cut from a block. V8 keeps the whole string a substring was cut from in
// memory, so a stored id would otherwise keep a whole piece of the file alive.
const own = (s) => s && Buffer.from(s, "latin1").toString("latin1");

// Downloads a gzipped XML file and calls onBlock with the text of each element from `open` to `close`,
// unpacking and scanning it piece by piece, so the whole file (70-150 MB of XML) is never in memory.
// Returns { etag }, or { notModified } when the file has not changed since `etag`. Retries twice;
// a caller that collects blocks must start over on a retry, so it gets onStart before each attempt.
async function streamBlocks(url, open, close, { onStart = () => {}, onBlock, etag, timeout = 50_000 }) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, { headers: { ...HEADERS, ...(etag ? { "If-None-Match": etag } : {}) }, signal: AbortSignal.timeout(timeout) });
      if (res.status === 304) return { notModified: true, etag };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onStart();
      const decoder = new TextDecoder();
      let buf = "";
      await pipeline(Readable.fromWeb(res.body), createGunzip(), async (source) => {
        for await (const chunk of source) {
          buf += decoder.decode(chunk, { stream: true });
          for (;;) {
            const a = buf.indexOf(open);
            if (a < 0) { buf = buf.slice(-open.length); break; } // keep a partial `open` at the end
            const b = buf.indexOf(close, a);
            if (b < 0) { buf = buf.slice(a); break; }
            onBlock(buf.slice(a, b));
            buf = buf.slice(b + close.length);
          }
        }
      });
      return { etag: res.headers.get("etag") };
    } catch (e) {
      if (i >= 2) throw e;
      await sleep(5_000 * 2 ** i);
    }
  }
}

// ---------- the measurement site table ----------
// MONIBAS ids encode the road, carriageway and hectometre: RWS01_MONIBAS_0021hrr0123ra is road 002
// (the A2; the fourth digit is 1 on all of them), main carriageway right (hrr) or left (hrl), at
// km 12.3; the last letters tell detectors at the same hectometre apart.
const MONIBAS = /^RWS01_MONIBAS_(\d{4})(hr[lr])(\d{4})(r[a-z])$/;

// Main carriageway MONIBAS sites whose values alternate flow, speed per lane, all vehicles (the v3
// table has no lane numbers, so this is how lanes are told apart: index 2k-1 is the flow and 2k the
// speed of lane k).
async function fetchSiteTable() {
  let sites;
  await streamBlocks(CONFIG, "<roa:measurementSite ", "</roa:measurementSite>", {
    timeout: 300_000,
    onStart: () => { sites = []; },
    onBlock: (block) => {
      const id = own(block.match(/id="([^"]+)"/)?.[1]);
      const m = id?.match(MONIBAS);
      if (!m) return;
      if (!/<loc:carriageway>mainCarriageway</.test(block)) return;
      const lanes = Number(block.match(/<roa:measurementSiteNumberOfLanes>(\d+)</)?.[1]);
      const types = [...block.matchAll(/<roa:specificMeasurementValueType>(\w+)</g)].map((x) => x[1]);
      const anyVehicle = (block.match(/<com:vehicleType>anyVehicle</g) ?? []).length;
      if (!(lanes > 0) || types.length !== 2 * lanes || anyVehicle !== types.length) return;
      if (types.some((t, i) => t !== (i % 2 ? "trafficSpeed" : "trafficFlow"))) return;
      const lat = Number(block.match(/<loc:latitude>([\d.]+)</)?.[1]);
      const lon = Number(block.match(/<loc:longitude>([\d.]+)</)?.[1]);
      if (!lat || !lon) return;
      sites.push({ id, road: Number(m[1]), cw: m[2], hm: Number(m[3]), code: `${m[1]}${m[2]}${m[3]}${m[4]}`, lanes, lat, lon });
    },
  });
  return sites;
}

function distM(a, b) {
  const kx = 111_320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot((a.lon - b.lon) * kx, (a.lat - b.lat) * 110_540);
}

// Pairs each right-carriageway site with the nearest left-carriageway site of the same road (within
// 300 m) into a station with two directions, like the Finnish stations, and keeps only sites that are
// reporting now. Then picks stations spread over the country: each next station is the one farthest
// from those already picked.
function selectStations(sites, reporting, n) {
  const ok = sites.filter((s) => reporting.has(s.id));
  const left = ok.filter((s) => s.cw === "hrl");
  const used = new Set();
  const stations = [];
  for (const r of ok.filter((s) => s.cw === "hrr")) {
    let best = null, bd = 300;
    for (const l of left) {
      if (l.road !== r.road || used.has(l.id)) continue;
      const d = distM(r, l);
      if (d < bd) { bd = d; best = l; }
    }
    if (!best) continue;
    used.add(best.id);
    stations.push({
      key: r.code,
      name: `${roadName(r.road)} km ${(r.hm / 10).toFixed(1)}`,
      road: roadName(r.road),
      km: r.hm / 10,
      lat: +((r.lat + best.lat) / 2).toFixed(5),
      lon: +((r.lon + best.lon) / 2).toFixed(5),
      sites: { 1: r.id, 2: best.id },
      lanes: { 1: r.lanes, 2: best.lanes },
    });
  }
  if (!stations.length) return [];
  // Farthest-point sampling, starting from the station nearest the middle of the country.
  const mid = { lat: 52.2, lon: 5.3 };
  const picked = [stations.reduce((a, b) => (distM(a, mid) < distM(b, mid) ? a : b))];
  const dmin = stations.map((s) => distM(s, picked[0]));
  while (picked.length < Math.min(n, stations.length)) {
    let bi = 0;
    for (let i = 1; i < stations.length; i++) if (dmin[i] > dmin[bi]) bi = i;
    picked.push(stations[bi]);
    for (let i = 0; i < stations.length; i++) dmin[i] = Math.min(dmin[i], distM(stations[i], stations[bi]));
  }
  return picked.sort((a, b) => a.key.localeCompare(b.key));
}

// "0021" is the A2, "3251" the N325: the A roads have numbers below 100.
function roadName(code) {
  const n = Math.floor(code / 10);
  return `${n < 100 ? "A" : "N"}${n}`;
}

// ---------- the measured data ----------
// Returns { data: Map(siteId -> { time, values: Map(index -> { flow?, speed?, error }) }), etag } for
// the given sites, or { notModified } when the file has not changed since `etag`.
async function fetchMeasured(wanted, etag) {
  let data;
  const res = await streamBlocks(MEASURED, "<roa:siteMeasurements>", "</roa:siteMeasurements>", {
    etag,
    onStart: () => { data = new Map(); },
    onBlock: (block) => {
      const id = block.match(/<roa:measurementSiteReference[^>]*id="([^"]+)"/)?.[1];
      if (!wanted.has(id)) return;
      const time = own(block.match(/<roa:timeValue>([^<]+)</)?.[1]);
      if (!time) return;
      const values = new Map();
      for (const q of block.split('<roa:physicalQuantity index="').slice(1)) {
        const index = Number(q.slice(0, q.indexOf('"')));
        const error = /<com:dataError>true</.test(q);
        const flow = q.match(/<com:vehicleFlowRate>(-?[\d.]+)</);
        const speed = q.match(/<com:speed>(-?[\d.]+)</);
        values.set(index, { flow: flow ? Number(flow[1]) : undefined, speed: speed ? Number(speed[1]) : undefined, error });
      }
      data.set(own(id), { time, values });
    },
  });
  return { ...res, data };
}

// One lane's minute: vehicles and the minute's mean speed (null when there were no vehicles or the
// detector reported no speed). Returns null when the minute is missing or flagged as an error.
function laneMinute(values, lane) {
  const f = values.get(2 * lane - 1), s = values.get(2 * lane);
  if (!f || f.error || !(f.flow >= 0)) return null;
  const n = f.flow / 60; // the flow is a rate in veh/h over one minute
  const v = s && !s.error && s.speed > 0 ? s.speed : null;
  return { n, v };
}

// ---------- local time ----------
const partsFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
// The Dutch date and 5-minute slot of a minute. On the autumn DST change the hour 02 repeats, so
// that hour's slots hold two hours of vehicles (m shows it: up to 10 minutes per slot).
function localSlot(iso) {
  const p = Object.fromEntries(partsFmt.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, slot: Math.floor((Number(p.hour) * 60 + Number(p.minute)) / INTERVAL) };
}

// ---------- day files ----------
const days = new Map(); // "date/key" -> { key, date, lanes: Map("dir:lane" -> accumulator) }

function newLane(dir, lane) {
  const z = () => new Array(SLOTS).fill(0);
  return { dir, lane, n: z(), m: z(), nv: z(), inv: z(), sum: z() };
}

async function dayFile(date, key) {
  const id = `${date}/${key}`;
  if (days.has(id)) return days.get(id);
  const day = { key, date, lanes: new Map(), dirty: false };
  days.set(id, day);
  // Continue a file an earlier run (or this one) wrote.
  const file = path.join(OUT, "fd", date, `${key}.json`);
  if (existsSync(file)) {
    try {
      for (const l of (await readJson(file)).lanes) {
        const acc = newLane(l.dir, l.lane);
        for (let i = 0; i < SLOTS; i++) {
          acc.n[i] = l.n[i]; acc.m[i] = l.m[i]; acc.nv[i] = l.nv[i];
          if (l.nv[i] && l.vh[i]) acc.inv[i] = l.nv[i] / (l.vh[i] / 10);
          acc.sum[i] = l.nv[i] * (l.va[i] / 10);
        }
        day.lanes.set(`${l.dir}:${l.lane}`, acc);
      }
    } catch (e) {
      log(`Could not read ${file}: ${e.message}`);
    }
  }
  return day;
}

async function writeDays() {
  let written = 0;
  for (const day of days.values()) {
    if (!day.dirty) continue;
    const lanes = [...day.lanes.values()]
      .sort((a, b) => a.dir - b.dir || a.lane - b.lane)
      .map(({ dir, lane, n, m, nv, inv, sum }) => ({
        lane, dir, n, m, nv,
        vh: nv.map((k, i) => (k && inv[i] ? Math.round((k / inv[i]) * 10) : 0)),
        va: nv.map((k, i) => (k ? Math.round((sum[i] / k) * 10) : 0)),
      }));
    const file = path.join(OUT, "fd", day.date, `${day.key}.json`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, gzipSync(JSON.stringify({ key: day.key, date: day.date, interval: INTERVAL, lanes }), { level: 9 }));
    day.dirty = false;
    written++;
  }
  // Days before yesterday are complete; drop them from memory.
  const yesterday = localSlot(new Date(Date.now() - 86_400_000).toISOString()).date;
  for (const [id, day] of days) if (day.date < yesterday && !day.dirty) days.delete(id);
  // And delete the folders the page no longer shows.
  const cutoff = localSlot(new Date(Date.now() - (KEEP_DAYS - 1) * 86_400_000).toISOString()).date;
  for (const dir of await readdir(path.join(OUT, "fd")).catch(() => [])) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(dir) && dir < cutoff) await rm(path.join(OUT, "fd", dir), { recursive: true, force: true });
  }
  return written;
}

// ---------- live ----------
// The last 5 minutes per lane, as the Finnish live dots use the latest 5-minute lane flow.
const recent = new Map(); // "key/dir:lane" -> [{ t, n, v }]
function liveJson(stations) {
  const out = {};
  const now = Date.now();
  for (const st of stations) {
    const lanes = [];
    for (const dir of [1, 2]) {
      for (let lane = 1; lane <= (st.lanes[dir] ?? 0); lane++) {
        const mins = (recent.get(`${st.key}/${dir}:${lane}`) ?? []).filter((x) => now - x.t < 20 * 60_000);
        if (!mins.length) continue;
        const last = mins[mins.length - 1].t;
        const win = mins.filter((x) => x.t > last - INTERVAL * 60_000);
        const n = win.reduce((a, x) => a + x.n, 0);
        const withV = win.filter((x) => x.v);
        const nv = withV.reduce((a, x) => a + x.n, 0);
        const inv = withV.reduce((a, x) => a + x.n / x.v, 0);
        lanes.push({
          dir, lane,
          q: Math.round((n * 60) / win.length),
          v: nv && inv ? +(nv / inv).toFixed(1) : null,
          start: new Date(win[0].t).toISOString(),
          end: new Date(last + 60_000).toISOString(),
        });
      }
    }
    if (lanes.length) out[st.key] = lanes;
  }
  return { updated: new Date().toISOString(), stations: out };
}

// ---------- hooks ----------
let hookBusy = {};
function runHook(name, cmd) {
  if (!cmd || hookBusy[name]) return Promise.resolve();
  hookBusy[name] = true;
  return new Promise((resolve) => {
    execFile("bash", ["-c", cmd], { timeout: 10 * 60_000 }, (err, stdout, stderr) => {
      hookBusy[name] = false;
      if (err) log(`${name} hook failed: ${(stderr || err.message).trim().slice(0, 500)}`);
      resolve();
    });
  });
}

// Reads a JSON file, also when it is gzipped (as the files are stored in the bucket).
async function readJson(file, fallback) {
  let buf;
  try { buf = await readFile(file); }
  catch (e) { if (e.code === "ENOENT") return fallback; throw e; }
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
  return JSON.parse(buf.toString("utf8"));
}

// ---------- main ----------
async function main() {
  await mkdir(OUT, { recursive: true });
  const stationsFile = path.join(OUT, "stations.json");
  let stations = await readJson(stationsFile, null);
  if (!stations || args.select) {
    log("Selecting stations");
    const sites = await fetchSiteTable();
    // Reporting now: at least one lane with a valid minute.
    const { data } = await fetchMeasured(new Set(sites.map((s) => s.id)));
    const lanesOf = new Map(sites.map((s) => [s.id, s.lanes]));
    const reporting = new Set([...data].filter(([id, d]) =>
      Array.from({ length: lanesOf.get(id) }, (_, i) => laneMinute(d.values, i + 1)).some(Boolean)).map(([id]) => id));
    stations = selectStations(sites, reporting, N_STATIONS);
    log(`${sites.length} MONIBAS main carriageway sites, ${reporting.size} reporting, ${stations.length} stations selected`);
    if (!stations.length) throw new Error("No stations selected");
    await writeFile(stationsFile, JSON.stringify(stations));
  }

  const bySite = new Map(); // siteId -> { st, dir }
  for (const st of stations) for (const dir of [1, 2]) if (st.sites[dir]) bySite.set(st.sites[dir], { st, dir });
  const stateFile = path.join(OUT, "state.json");
  const lastTime = new Map(Object.entries(await readJson(stateFile, {})));

  const stopAt = MINUTES > 0 ? Date.now() + MINUTES * 60_000 : Infinity;
  let etag = null, polls = 0, minutes = 0, failures = 0, lastFlush = Date.now(), lastLive = 0;
  log(`Collecting ${stations.length} stations (${bySite.size} sites) ${MINUTES > 0 ? `for ${MINUTES} minutes` : "until stopped"}`);

  // A service is stopped with SIGTERM: write what was collected since the last flush, then exit.
  let stopping = false;
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, async () => {
      if (stopping) return;
      stopping = true;
      log(`${sig}, writing the files`);
      await finish(stations, stateFile, lastTime, polls, minutes);
      process.exit(0);
    });
  }

  while (Date.now() < stopAt && !stopping) {
    const started = Date.now();
    try {
      const res = await fetchMeasured(bySite, etag);
      failures = 0;
      if (!res.notModified && !stopping) {
        etag = res.etag;
        const data = res.data;
        let added = 0;
        for (const [id, { time, values }] of data) {
          if (lastTime.has(id) && time <= lastTime.get(id)) continue; // already counted
          lastTime.set(id, time);
          const { st, dir } = bySite.get(id);
          const { date, slot } = localSlot(time);
          const day = await dayFile(date, st.key);
          for (let lane = 1; lane <= st.lanes[dir]; lane++) {
            const x = laneMinute(values, lane);
            if (!x) continue;
            const k = `${dir}:${lane}`;
            if (!day.lanes.has(k)) day.lanes.set(k, newLane(dir, lane));
            const acc = day.lanes.get(k);
            acc.n[slot] += x.n;
            acc.m[slot]++;
            if (x.v) { acc.nv[slot] += x.n; acc.inv[slot] += x.n / x.v; acc.sum[slot] += x.n * x.v; }
            day.dirty = true;
            const rk = `${st.key}/${k}`;
            const list = recent.get(rk) ?? [];
            list.push({ t: Date.parse(time), n: x.n, v: x.v });
            recent.set(rk, list.slice(-10));
          }
          added++;
        }
        minutes += added;
        if (++polls % 30 === 1) log(`poll ${polls}: ${data.size} sites, ${added} new site-minutes, ${Date.now() - started} ms`);
      }
    } catch (e) {
      log(`Poll failed: ${e.message}`);
      if (++failures >= 30) throw new Error("30 polls failed in a row");
    }

    if (Date.now() - lastLive >= INTERVAL * 60_000) {
      lastLive = Date.now();
      await writeFile(path.join(OUT, "live.json"), JSON.stringify(liveJson(stations)));
      runHook("live", args["on-live"]);
    }
    if (Date.now() - lastFlush >= FLUSH_EVERY * 60_000) {
      lastFlush = Date.now();
      await flush(stateFile, lastTime);
      runHook("flush", args["on-flush"]);
    }
    // NDW writes a new file about 10 seconds past each minute.
    const wait = POLL_MS - (Date.now() - started);
    if (wait > 0 && Date.now() + wait < stopAt) await sleep(wait);
    else if (wait > 0) break;
  }

  if (!stopping) await finish(stations, stateFile, lastTime, polls, minutes);
}

async function finish(stations, stateFile, lastTime, polls, minutes) {
  await flush(stateFile, lastTime);
  await writeFile(path.join(OUT, "live.json"), JSON.stringify(liveJson(stations)));
  log(`Done: ${polls} polls, ${minutes} site-minutes`);
  // Wait for an upload that is still running, then upload once more.
  while (hookBusy.flush || hookBusy.live) await sleep(500);
  await runHook("flush", args["on-flush"]);
  await runHook("live", args["on-live"]);
}

async function flush(stateFile, lastTime) {
  const written = await writeDays();
  await writeFile(stateFile, JSON.stringify(Object.fromEntries(lastTime)));
  const yesterday = localSlot(new Date(Date.now() - 86_400_000).toISOString()).date;
  // "end" is the newest complete day, like the Finnish meta.json.
  await writeFile(path.join(OUT, "meta.json"), JSON.stringify({ updated: new Date().toISOString(), end: yesterday.replace(/-/g, "") }));
  log(`Flushed ${written} day files`);
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
