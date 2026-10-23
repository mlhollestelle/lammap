# lammap

An interactive map of Finland's LAM traffic counting stations, plus the City of Helsinki's own car, bicycle and pedestrian counters. Click or search for a counter to see its traffic for the last 30 or 365 days. Data comes from [Fintraffic / Digitraffic](https://www.digitraffic.fi/) and the [City of Helsinki](https://lidotiku.api.hel.fi/api/) (both CC BY 4.0).

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

The Helsinki counters come from the city's [LIDO-TIKU API](https://lidotiku.api.hel.fi/swagger): its own LAM stations (`HEL LAM`, motor vehicles plus one bicycle station) and the Eco-Counter cycle and pedestrian counters. The same workflow runs `scripts/ingest-hel.mjs`, which stores hourly sums per counter in the same format under `hel/<counter>.json`, with the station list in `hel/stations.json`. The API's Fintraffic stations are left out, since the map already has them, as are the traffic light loops and the per-lane radar loops. Days cut short by an outage are dropped rather than shown as low traffic. To try it locally: `node scripts/ingest-hel.mjs --days 30` (all counters, a couple of minutes) or `--counters 4667,100008546`.

Disruptions and roadworks are Digitraffic's [traffic messages](https://www.digitraffic.fi/en/road-traffic/#traffic-messages) (`/api/traffic-message/v2/traffic-announcements` and `/roadworks`), fetched live by the page and limited to the ones valid right now. They refresh every 5 minutes while shown. The roadworks feed is about 1 MB, so it only loads once switched on. The messages are in Finnish; the common restrictions are translated in `FEATURES_EN`.

The fundamental diagrams (flow, speed and density per lane, in 5-minute intervals) come from Digitraffic's raw per-vehicle files, aggregated by `scripts/ingest-fd.mjs` into one file per station per day (`fd/<date>/<tms>.json`, gzipped). To try it locally: `node scripts/ingest-fd.mjs --days 7 --stations 149,160`, copy those stations' files and `meta.json` from the bucket into `data/`, run `python3 -m http.server` in the repository and open `http://localhost:8000/?data=data#149`.
