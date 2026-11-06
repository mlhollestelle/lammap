// Fetches the City of Zürich's traffic counters from its open data portal: the car counts of the
// Dienstabteilung Verkehr (hourly, per measuring point) and the Tiefbauamt's automatic cycle and
// pedestrian counters (15-minute counts per direction). Both are published as one CSV per year, updated
// daily. Hourly sums are merged into one JSON file per counter in the same format as scripts/ingest.mjs,
// plus a station list. Run by .github/workflows/ingest.yml, which syncs the output directory with the
// R2 bucket.
//
//   node scripts/ingest-zh.mjs [--days 7] [--keep 366] [--out data] [--counters Z001,2989-bike]
//
// Output:
//   <out>/zh/<counter>.json    { id, all, d1, d2 }, each a map YYYYMMDD -> [h00..h23, total]
//   <out>/zh/stations.json     [{ id, name, source, mode, lat, lon, dirs, last, days }], counters with data
//
// A car counting site (Zählstelle, "Z001") has one measuring point per direction, or one for a one-way
// street; a day counts when every point has a count, measured or imputed by the city, for each hour.
// A cycle and pedestrian site that counts both becomes two counters, "<site>-bike" and
// "<site>-pedestrian"; an hour counts with all four quarter hours. The car file for a year is about
// 500 MB, so it is streamed rather than loaded, and each run reads the whole of the current year's files.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { HourTally, countBy, csvRows, dateWindow, fetchJson, httpError, key, lv95ToWgs84, parseArgs, readJson, timedFetch, withRetry, mergeDirs } from "./lib.mjs";

const PORTAL = "https://data.stadt-zuerich.ch/dataset";
const CAR_CSV = (year) => `${PORTAL}/sid_dav_verkehrszaehlung_miv_od2031/download/sid_dav_verkehrszaehlung_miv_OD2031_${year}.csv`;
const ECO_CSV = (year) => `${PORTAL}/ted_taz_verkehrszaehlungen_werte_fussgaenger_velo/download/${year}_verkehrszaehlungen_werte_fussgaenger_velo.csv`;
const ECO_SITES = "https://www.ogd.stadt-zuerich.ch/wfs/geoportal/Standorte_der_automatischen_Fuss__und_Velozaehlungen" +
  "?service=WFS&version=1.1.0&request=GetFeature&outputFormat=GeoJSON&typename=view_eco_standorte&srsName=EPSG:4326";
const TZ = "Europe/Zurich";
// The car file's directions: out of and into the city centre; others name where the road leads.
const CAR_DIRECTIONS = { "auswärts": "Outbound", "einwärts": "Inbound" };

const args = parseArgs(process.argv.slice(2));
const DAYS = Number(args.days ?? 7);
const KEEP = Number(args.keep ?? 366);
const OUT = args.out ?? "data";
const WANTED = args.counters ? new Set(String(args.counters).split(",")) : null;

const { END, START, OLDEST_KEPT } = dateWindow(TZ, DAYS, KEEP);
const FROM = key(START), TO = key(END);
const YEARS = [];
for (let y = START.getUTCFullYear(); y <= END.getUTCFullYear(); y++) YEARS.push(y);

// Streams a year's CSV into the row handler that start() returns, retrying the whole file if the
// download breaks off; start() is called again for each try, so it can drop what the last one read. A
// year that has no file yet (early January) is skipped.
async function readCsv(url, start) {
  return withRetry(async () => {
    const res = await timedFetch(url, { headers: { "User-Agent": "lammap (github.com/mlhollestelle/lammap)" } }, null, 900_000);
    if (res.status === 404) { console.log(`  ${url}: not published yet`); return; }
    if (!res.ok) throw httpError(res);
    const handle = start();
    for await (const r of csvRows(res.body)) handle(r);
  }, { delay: () => 30_000 });
}

// "2026-11-04T22:00:00" (local time) -> ["20261104", 22]
const dayHour = (t) => [t.slice(0, 10).replace(/-/g, ""), Number(t.slice(11, 13))];

// ---------- cars ----------
async function cars(tally, meta) {
  for (const year of YEARS) {
    let local, points;
    await readCsv(CAR_CSV(year), () => (local = new HourTally(), points = new Map(), (r) => {
      const [k, h] = dayHour(r.MessungDatZeit);
      if (k < FROM || k > TO) return;
      if (WANTED && !WANTED.has(r.ZSID)) return;
      const measured = r.AnzFahrzeugeStatus !== "Fehlend" && r.AnzFahrzeuge !== "";
      local.add(r.ZSID, r.MSID, k, h, measured ? Number(r.AnzFahrzeuge) : null);
      if (!points.has(r.MSID)) points.set(r.MSID, { site: r.ZSID, name: r.ZSName, dir: r.Richtung, e: Number(r.EKoord), n: Number(r.NKoord) });
    }));
    if (!local) continue;
    mergeTally(tally, local);
    for (const [ms, p] of points) {
      if (!meta.has(p.site)) meta.set(p.site, { id: p.site, name: p.name, mode: "car", source: "Dienstabteilung Verkehr", points: new Map() });
      meta.get(p.site).points.set(ms, p);
    }
    console.log(`  cars ${year}: ${points.size} measuring points`);
  }
}

// ---------- cycles and pedestrians ----------
async function eco(tally, meta) {
  const sites = new Map((await fetchJson(ECO_SITES)).features.map((f) => [String(f.properties.id1), f]));
  for (const year of YEARS) {
    let local, seen;
    await readCsv(ECO_CSV(year), () => (local = new HourTally(), seen = new Set(), (r) => {
      const [k, h] = dayHour(r.DATUM);
      if (k < FROM || k > TO) return;
      for (const [mode, col] of [["bike", "VELO"], ["pedestrian", "FUSS"]]) {
        const id = `${r.FK_STANDORT}-${mode}`;
        if (r[`${col}_IN`] === "" && r[`${col}_OUT`] === "") continue;
        if (WANTED && !WANTED.has(id)) continue;
        seen.add(id);
        local.add(id, "in", k, h, r[`${col}_IN`] === "" ? null : Number(r[`${col}_IN`]));
        local.add(id, "out", k, h, r[`${col}_OUT`] === "" ? null : Number(r[`${col}_OUT`]));
        if (!meta.has(id)) {
          const f = sites.get(r.FK_STANDORT);
          const pos = f ? { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] } : lv95ToWgs84(Number(r.OST), Number(r.NORD));
          const place = (s) => (s && !/^-+$/.test(s.trim()) ? s.trim() : null);
          meta.set(id, {
            id, name: f?.properties.bezeichnung?.trim() ?? `Counter ${r.FK_STANDORT}`, mode, source: "Tiefbauamt", ...pos,
            to: [place(f?.properties.richtung_in), place(f?.properties.richtung_out)],
          });
        }
      }
    }));
    if (!local) continue;
    mergeTally(tally, local);
    console.log(`  cycles and pedestrians ${year}: ${seen.size} counters`);
  }
}

function mergeTally(into, from) {
  for (const [c, slots] of from.counters) {
    if (!into.counters.has(c)) into.counters.set(c, new Map());
    for (const [s, days] of slots) {
      const target = into.counters.get(c);
      if (!target.has(s)) target.set(s, new Map());
      for (const [k, v] of days) target.get(s).set(k, v);
    }
  }
}

// ---------- main ----------
async function main() {
  const dir = path.join(OUT, "zh");
  await mkdir(dir, { recursive: true });
  const listFile = path.join(dir, "stations.json");
  const previous = new Map(((await readJson(listFile)) ?? []).map((s) => [s.id, s]));
  console.log(`Fetching ${FROM} – ${TO} for Zürich's counters, keeping ${KEEP} days`);

  const tally = new HourTally();
  const meta = new Map();
  let failed = 0;
  for (const [name, part] of [["cars", cars], ["cycles and pedestrians", eco]]) {
    try { await part(tally, meta); }
    catch (e) { console.error(`Zürich ${name}: ${e.message}`); failed++; }
  }

  const list = new Map();
  for (const [id, m] of meta) {
    let dirs = null, dirNames = null, pos = m;
    if (m.mode === "car") {
      const ms = [...m.points.keys()].sort();
      if (ms.length === 2) {
        dirs = { d1: [ms[0]], d2: [ms[1]] };
        dirNames = ms.map((p) => { const d = m.points.get(p).dir; return CAR_DIRECTIONS[d] ?? `Towards ${d}`; });
      }
      const pts = [...m.points.values()];
      pos = lv95ToWgs84(pts.reduce((a, p) => a + p.e, 0) / pts.length, pts.reduce((a, p) => a + p.n, 0) / pts.length);
    } else {
      // A counter whose "out" channel names no place and never counts anything covers one direction.
      const outs = tally.counters.get(id)?.get("out");
      const outCounts = outs && [...outs.values()].some((d) => d.v.some((v) => v > 0));
      if (m.to[1] || outCounts) {
        dirs = { d1: ["in"], d2: ["out"] };
        dirNames = m.to.map((t, i) => (t ? `Towards ${t}` : `Direction ${i + 1}`));
      }
    }
    const maps = tally.days(id, { timeZone: TZ, perHour: m.mode === "car" ? 1 : 4, from: FROM, to: TO, dirs });
    const file = path.join(dir, `${id}.json`);
    const stored = (await readJson(file)) ?? {};
    const data = { id, ...mergeDirs(stored, maps, OLDEST_KEPT) };
    const dayKeys = Object.keys(data.all);
    if (!dayKeys.length) continue;
    await writeFile(file, JSON.stringify(data));
    list.set(id, {
      id, name: m.name, source: m.source, mode: m.mode, lat: pos.lat, lon: pos.lon,
      dirs: Object.keys(data.d1).length && Object.keys(data.d2).length ? dirNames : null,
      last: dayKeys.at(-1), days: dayKeys.length,
    });
  }
  // Counters not in this run's files keep their entry while they have data in the kept window.
  for (const [id, s] of previous) if (!list.has(id) && s.last >= OLDEST_KEPT) list.set(id, s);
  await writeFile(listFile, JSON.stringify([...list.values()]));
  console.log(`Done: ${list.size} Zürich counters with data (${countBy([...list.values()], "mode")})`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
