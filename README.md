# lammap

An interactive map of Finland's LAM traffic counting stations. Click or search for a station to see its traffic for the last 30 or 365 days. Data comes from [Fintraffic / Digitraffic](https://www.digitraffic.fi/) (CC BY 4.0).

The app is a single `index.html` with no build step.

**Live:** https://mlhollestelle.github.io/lammap/

## Data

Traffic history is served as one JSON file per station from a public Cloudflare R2 bucket (`DATA` in `index.html`). The station list and direction names still come straight from Digitraffic.

The [Ingest traffic data](.github/workflows/ingest.yml) workflow keeps the bucket up to date: every morning it downloads the bucket, runs `scripts/ingest.mjs` to refetch the last 7 days for every station, and uploads the result. Run it manually with `days: 365` to backfill a full year. Requests go one station at a time to stay within Digitraffic's rate limits, so that takes about an hour; if a run stops early, run it again with `skip_existing` to continue where it left off.

It needs these repository settings:

| Name | Kind | Value |
|---|---|---|
| `R2_ACCOUNT_ID` | secret | Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | secret | R2 API token access key |
| `R2_SECRET_ACCESS_KEY` | secret | R2 API token secret |
| `R2_BUCKET` | variable | bucket name |

To try the script locally: `node scripts/ingest.mjs --days 30 --stations 101,102` (writes to `data/`).

The fundamental diagrams (flow, speed and density per lane, in 5-minute intervals) come from Digitraffic's raw per-vehicle files, aggregated by `scripts/ingest-fd.mjs` into one file per station per day (`fd/<tms>/<date>.json`). To try it locally: `node scripts/ingest-fd.mjs --days 7 --stations 149,160`, copy those stations' files and `meta.json` from the bucket into `data/`, run `python3 -m http.server` in the repository and open `http://localhost:8000/?data=data#149`.
