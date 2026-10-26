# lammap

An interactive map of Finland's LAM traffic counting stations, plus the City of Helsinki's own car, bicycle and pedestrian counters and cycle and pedestrian counters in Oulu, Espoo, Vantaa, Kerava, Lahti, Joensuu, Hämeenlinna, Vaasa and Rovaniemi. Click or search for a counter to see its traffic for the last 30 or 365 days. Data comes from [Fintraffic / Digitraffic](https://www.digitraffic.fi/), the [City of Helsinki](https://lidotiku.api.hel.fi/api/) and [Oulunliikenne](https://wp.oulunliikenne.fi/avoin-data/) (all CC BY 4.0), and from the cities' public [Eco-Counter](https://www.eco-counter.com/) pages.

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

The Oulu counters come from Oulunliikenne's [GraphQL API](https://wp.oulunliikenne.fi/avoin-data/pyorailykavely/graphql-rajapinnat/) (`ecoCounterSites` and `ecoCounterSiteData`): Eco-Counter devices run by the City of Oulu and the ELY Centre, in Oulu, Kempele, Liminka and Kiiminki. The same workflow runs `scripts/ingest-oulu.mjs`, which stores hourly sums per counter under `oulu/<counter>.json`, with the station list in `oulu/stations.json`. A site that counts both cyclists and pedestrians becomes two counters (`<site>-bike` and `<site>-pedestrian`), and the page shows a button for each. Days where a channel misses hours are dropped. A full year takes about 5 minutes: `node scripts/ingest-oulu.mjs --days 365`, or `--counters raatti-bike,OULU119-bike` for a few.

The other cities' counters come from their public Eco-Counter pages (`https://data.eco-counter.com/ParcPublic/?id=<organisation>`), through the undocumented JSON API those pages use (`eco-visio.net/api/aladdin/1.0.0/pbl/publicwebpageplus`). `scripts/ingest-eco.mjs` reads the pages of the Helsinki region (Espoo, Vantaa, Kerava, and the Helsinki counters the city's own API lacks), Lahti, Joensuu, Vaasa, Rovaniemi and Hämeenlinna, and stores hourly sums per counter under `eco/<site>-<bike|pedestrian>.json`, with the station list in `eco/stations.json`. The region page mixes cities, so the script maps its sites to municipalities in `SITE_CITY`; a new site outside Helsinki shows up as Helsinki until it is added there. The pages don't say which channels are directions, so the channels are summed. Missing hours are left out of the hourly series rather than marked, so only complete days are kept, and days with no counts at all are dropped as outages. Tampere's and Turku's counters are not public. A full year takes about 7 minutes: `node scripts/ingest-eco.mjs --days 365`, or `--counters 100146346-bike,100059446-pedestrian` for a few.

Disruptions and roadworks are Digitraffic's [traffic messages](https://www.digitraffic.fi/en/road-traffic/#traffic-messages) (`/api/traffic-message/v2/traffic-announcements` and `/roadworks`), fetched live by the page and limited to the ones valid right now. They refresh every 5 minutes while shown. The roadworks feed is about 1 MB, so it only loads once switched on. The messages are in Finnish; the common restrictions are translated in `FEATURES_EN`.

The traffic state arrows come from Digitraffic's live station data (`/api/tms/v1/stations/data`, about 150 KB gzipped for all stations), refreshed every 2 minutes while shown. Each LAM station gets an arrow per direction, pointing along the station's `bearing` (the heading of direction 1) and drawn ahead of the dot in that direction, so the two directions sit in front of and behind it, coloured by the `KESKINOPEUS_5MIN_LIUKUVA_SUUNTA*_VVAPAAS*` sensor: the last 5 minutes' average speed as a percentage of the station's free-flow speed. Digitraffic publishes only the percentage, so the classes (≥90, 75–90, 50–75, <50) are lammap's own. Below zoom 9 only the arrows under 90% are drawn.

The same response drives the vehicle pulse: each active LAM station sends out a ring for every vehicle, at the rate of `OHITUKSET_5MIN_LIUKUVA_SUUNTA1` plus `SUUNTA2` (the last 5 minutes' flow in veh/h, all lanes of both directions), so 3600 veh/h is a ring a second. The rate also shows in the station's tooltip. Visitors who ask for reduced motion get no rings.

The fundamental diagrams (flow, speed and density per lane, in 5-minute intervals) come from Digitraffic's raw per-vehicle files, aggregated by `scripts/ingest-fd.mjs` into one file per station per day (`fd/<date>/<tms>.json`, gzipped). To try it locally: `node scripts/ingest-fd.mjs --days 7 --stations 149,160`, copy those stations' files and `meta.json` from the bucket into `data/`, run `python3 -m http.server` in the repository and open `http://localhost:8000/?data=data#149`.
