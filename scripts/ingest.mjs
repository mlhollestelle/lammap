// Fetches LAM hourly traffic reports from Digitraffic and merges them into one JSON
// file per station, keeping a rolling window of days. Run by .github/workflows/ingest.yml,
// which syncs the output directory with the R2 bucket before and after.
//
//   node scripts/ingest.mjs [--days 7] [--keep 366] [--out data] [--stations 101,102] [--skip-existing]
//
// --skip-existing skips stations that already have a file in <out>, to resume a backfill.
//
// Output:
//   <out>/stations/<tms>.json  { tms, all, d1, d2 }, each a map YYYYMMDD -> [h00..h23, total]
//                              ("all" only holds rows the report did not split by direction)
//   <out>/meta.json            { updated, end, keep }

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { dateWindow, httpError, iso, key, mergeDirs, parseArgs, readJson, throttle, timedFetch, withRetry } from "./lib.mjs";

const API = "https://tie.digitraffic.fi/api/tms/v1";
// Digitraffic throttles per IP, and allows more requests when this header is set
// (https://www.digitraffic.fi/en/support/instructions/). So every request sends it, stations are
// fetched one at a time with a minimum gap, and a 429 backs off for minutes rather than seconds.
const HEADERS = { "Digitraffic-User": "lammap/ingest" };
const MIN_GAP_MS = 1000;
const MAX_CONSECUTIVE_FAILURES = 3; // then stop instead of hammering a throttled API

const args = parseArgs(process.argv.slice(2));
const DAYS = Number(args.days ?? 7);    // how many recent days to (re)fetch
const KEEP = Number(args.keep ?? 366);  // how many days to keep per station
const OUT = args.out ?? "data";
const SKIP_EXISTING = Boolean(args["skip-existing"]);

// Finnish local days, since the reports use Finnish days.
const { END, START, OLDEST_KEPT } = dateWindow("Europe/Helsinki", DAYS, KEEP);

// ---------- fetch ----------
const wait = throttle(MIN_GAP_MS);
// Throttled: wait 1, 2, 4 minutes. Other transient errors: 5, 10, 20 seconds.
function fetchRetry(url, read) {
  return withRetry(async () => {
    const res = await timedFetch(url, { headers: HEADERS }, wait);
    if (!res.ok) throw httpError(res);
    return read(res);
  }, { delay: (err) => (err.status === 429 ? 60_000 : 5_000) });
}

function historyUrl(tms) {
  const p = new URLSearchParams({
    api: "liikennemaara", // corrected traffic volumes
    tyyppi: "h",          // hourly report
    pvm: iso(START),
    loppu: iso(END),
    lam_type: "option1",
    piste: String(tms),
  });
  // Without "suunta" the report sums both directions into one row ("*").
  p.append("suunta", "1");
  p.append("suunta", "2");
  return `${API}/history?${p}`;
}

// Parses the semicolon CSV and keeps only the "Kaikki" (all vehicle classes) rows, split by direction.
// Direction can come from a direction column ("suunta"/"ajosuunta") or from the "jaottelu" value
// itself (e.g. "Suunta 1"). Returns { all, d1, d2 }, each a Map(YYYYMMDD -> [h00..h23, total]).
function parseReport(text) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  const maps = { all: new Map(), d1: new Map(), d2: new Map() };
  if (!lines.length) return maps;
  const header = lines[0].split(";");
  const col = (name) => header.indexOf(name);
  const iDir = header.findIndex((h) => /^(ajo)?suunta$/i.test(h.trim()));
  const iDate = col("pvm"), iSplit = col("jaottelu"), iTotal = col("yhteensa");
  const iHours = [];
  for (let h = 0; h < 24; h++) iHours.push(col(`${String(h).padStart(2, "0")}_${String(h + 1).padStart(2, "0")}`));
  if (iDate < 0 || iSplit < 0 || iHours.includes(-1)) throw new Error("Unexpected report format");

  for (const line of lines.slice(1)) {
    const c = line.split(";");
    const split = (c[iSplit] || "").trim();
    let dir;
    const splitDir = split.match(/suunta\D*([12])/i);
    if (splitDir) dir = `d${splitDir[1]}`;
    else if (split.toLowerCase() !== "kaikki") continue; // vehicle class rows
    else {
      const m = iDir >= 0 ? String(c[iDir]).match(/[12]/) : null;
      dir = m ? `d${m[0]}` : "all";
    }
    const hours = iHours.map((i) => Number(c[i]) || 0); // empty cell = 0 vehicles
    const sumHours = hours.reduce((a, b) => a + b, 0);
    const total = c[iTotal] !== undefined && c[iTotal] !== "" && !isNaN(c[iTotal]) ? Number(c[iTotal]) : sumHours;
    const prev = maps[dir].get(c[iDate]);
    if (prev) { // defensive: sum if the report ever splits "Kaikki" into multiple rows
      maps[dir].set(c[iDate], [...prev.slice(0, 24).map((v, i) => v + hours[i]), prev[24] + total]);
    } else {
      maps[dir].set(c[iDate], [...hours, total]);
    }
  }
  return maps;
}

async function ingestStation(tms) {
  const report = parseReport(await fetchRetry(historyUrl(tms), (res) => res.text()));
  const file = path.join(OUT, "stations", `${tms}.json`);
  const stored = (await readJson(file)) ?? {};
  const data = { tms, ...mergeDirs(stored, report, OLDEST_KEPT) };
  // Written even when empty, so the map never requests a missing file.
  await writeFile(file, JSON.stringify(data));
  return report.d1.size + report.d2.size + report.all.size;
}

// ---------- main ----------
async function main() {
  let tmsList;
  if (args.stations) {
    tmsList = String(args.stations).split(",").map(Number);
  } else {
    tmsList = (await fetchRetry(`${API}/stations`, (res) => res.json())).features.map((f) => f.properties.tmsNumber);
  }
  await mkdir(path.join(OUT, "stations"), { recursive: true });
  console.log(`Fetching ${iso(START)} – ${iso(END)} for ${tmsList.length} stations, keeping ${KEEP} days`);

  const failed = [];
  let rows = 0, skipped = 0, consecutive = 0, stopped = false;
  for (const [i, tms] of tmsList.entries()) {
    if (SKIP_EXISTING && existsSync(path.join(OUT, "stations", `${tms}.json`))) { skipped++; continue; }
    try {
      rows += await ingestStation(tms);
      consecutive = 0;
    } catch (e) {
      failed.push(tms);
      console.error(`Station ${tms}: ${e.message}`);
      if (++consecutive >= MAX_CONSECUTIVE_FAILURES) {
        console.error(`${consecutive} stations failed in a row, stopping`);
        stopped = true;
        break;
      }
    }
    if ((i + 1) % 50 === 0) console.log(`${i + 1}/${tmsList.length}`);
  }

  const ok = tmsList.length - skipped - failed.length;
  console.log(`Done: ${ok} stations fetched, ${skipped} skipped, ${failed.length} failed${stopped ? ", stopped early" : ""}; ${rows} direction-days`);
  // Station files are uploaded either way; only advance the published end date when the run mostly worked.
  if (stopped || failed.length > tmsList.length * 0.1) {
    console.error(`Failed: ${failed.join(", ")}`);
    process.exit(1);
  }
  await writeFile(path.join(OUT, "meta.json"), JSON.stringify({ updated: new Date().toISOString(), end: key(END), keep: KEEP }));
  // Shows up as an annotation on the Actions run; the next daily run refetches these days anyway.
  if (failed.length) console.log(`::warning::${failed.length} stations failed: ${failed.join(", ")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
