# lammap

An interactive map of Finland's LAM traffic counting stations. Click or search for a station to see its traffic for the last 30 or 365 days. Data comes from [Fintraffic / Digitraffic](https://www.digitraffic.fi/) (CC BY 4.0).

A dropdown in the header switches to the Netherlands (`?country=nl`), with the detectors on national roads from [NDW](https://www.ndw.nu/) open data and their last 7 days, collected by a Raspberry Pi. See [The Netherlands](#the-netherlands) below.

The app is a single `index.html` with no build step.

**Live:** https://mlhollestelle.github.io/lammap/

## Data

Traffic history is served as one JSON file per station from a public Cloudflare R2 bucket (`DATA` in `index.html`). The station list and direction names still come straight from Digitraffic.

The [Ingest traffic data](.github/workflows/ingest.yml) workflow keeps the bucket up to date: every morning it downloads the bucket, runs `scripts/ingest.mjs` to refetch the last 7 days for every station, and uploads the result. Run it manually with `days: 365` to backfill a full year. Requests go one station at a time to stay within Digitraffic's rate limits, so that takes about an hour; if a run stops early, run it again with `skip_existing` to continue where it left off. The same workflow then keeps the 5-minute lane data for the last `fd_days` days (default 7): it fetches only the days that are not in the bucket yet, so a missed run is caught up the next day, and deletes older days.

It needs these repository settings:

| Name | Kind | Value |
|---|---|---|
| `R2_ACCOUNT_ID` | secret | Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | secret | R2 API token access key |
| `R2_SECRET_ACCESS_KEY` | secret | R2 API token secret |
| `R2_BUCKET` | variable | bucket name |

To try the script locally: `node scripts/ingest.mjs --days 30 --stations 101,102` (writes to `data/`).

The fundamental diagrams (flow, speed and density per lane, in 5-minute intervals) come from Digitraffic's raw per-vehicle files, aggregated by `scripts/ingest-fd.mjs` into one file per station per day (`fd/<date>/<tms>.json`, gzipped). To try it locally: `node scripts/ingest-fd.mjs --days 7 --stations 149,160`, copy those stations' files and `meta.json` from the bucket into `data/`, run `python3 -m http.server` in the repository and open `http://localhost:8000/?data=data#149`.

## The Netherlands

NDW publishes the minute values of about 20,000 Dutch detectors at <https://opendata.ndw.nu/> without an account, but only the latest minute. History is in [Dexter](https://dexter.ndw.nu/), which needs a login. So lammap collects the minute data itself and keeps the last 7 days.

`scripts/collect-nl.mjs` runs all the time on a small always-on computer: a Raspberry Pi, see [pi/README.md](pi/README.md) for the setup. (Not on GitHub Actions: a job running around the clock is not what Actions is meant for.) Every minute it downloads `snelheden_en_intensiteiten_meetgegevens.xml.gz` (DATEX II v3, about 1 MB gzipped) and adds each detector's new minute to 5-minute intervals per lane. It reads the file as a stream and keeps the counts in typed arrays, so all national roads fit in about 250 MB of memory. Every hour it writes the day files, and every 2 hours `scripts/upload-nl.sh` uploads them to `nl/fd/<date>/<station>.json` in the same bucket (with rclone) and deletes days older than a week; that keeps the uploads within R2's free tier. Every 5 minutes `nl/live.json` holds the last 5 minutes of every lane for the live dots. Minutes it misses (a restart, a failed download) are recorded per interval (`m`, minutes with data), and the page scales hours up from the minutes it has, or leaves out a day with an hour under 30 minutes.

The stations are pairs of Rijkswaterstaat MONIBAS loop detectors on the two main carriageways of a motorway (`hrr`, with the hectometre numbering, and `hrl`, against it), at most 300 m apart. Their ids give the road and position: `RWS01_MONIBAS_0021hrr0123ra` is the A2 (road `002`), right carriageway, km 12.3. The DATEX II v3 site table has no lane numbers, but MONIBAS sites list a flow and a speed per lane in lane order, and lane 1 is the left lane (in a sample of all 3-lane carriageways, lanes 1, 2 and 3 averaged 120, 110 and 100 km/h). MONIBAS reports no vehicle classes, so there is no heavy-vehicle share for the Netherlands. It takes all of them on national roads, about 2,600 (`--stations N` picks fewer, spread over the country), and keeps that list (`stations.json`), so their history stays continuous. The daily and hourly charts are built from the same 5-minute files as the fundamental diagram.

To try it without the bucket: `node scripts/collect-nl.mjs --minutes 10 --stations 20 --out data/nl`, then `python3 -m http.server` and open `http://localhost:8000/?data=data&country=nl`.
