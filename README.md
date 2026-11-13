# Garuda — ಗರುಡ

Free NASA fire data and live weather, turned into a plain-language warning before it reaches
your street. Landing page at `/`, operator dashboard at `/dashboard`.

**NOVA 2026 Dubai Grand Finale · Track D**

---

## What is live, stale or simulated

Every number in the API and the UI carries one of these badges:

| Badge | Meaning |
|---|---|
| **live** | fetched successfully in the last 15 minutes |
| **stale** | the last fetch failed; the previous good value is shown |
| **simulated** | the adapter has no credential (currently FIRMS without a MAP_KEY) |

- Weather, terrain elevation and air quality come from Open-Meteo. They need no key and are **live**.
- NASA FIRMS needs `FIRMS_MAP_KEY`. Without it detections are **simulated**, clearly badged on the
  map, the landing chip and `/fires.geojson` (`meta.badge`).
- Nothing in this repo contains a credential. If a key was ever committed, rotate it.

## Architecture

```
risk-core.js   one engine: FWI spin-up, terrain, 27 fuzzy rules, hard override, forecast timeline
               used by  ── Worker (/status, /history, /simulate)
                        ── dashboard (gauges, timeline)
                        ── landing playground (sliders call the same function)
risk_core.py   Python mirror of the same engine; parity_test.py asserts identical output
deploy/worker.js     Cloudflare Worker: data adapters, caching, routes, page hosting, D1 tables
deploy/public/       landing (index.html), dashboard (dashboard.html), background (bg.js)
D1 (binding DB)      community reports and family check-ins; created lazily on first write
engine.py            local Flask engine for the Pi / laptop (same core, real channels)
backtest.py          12-month backtest → backtest.json (needs FIRMS_MAP_KEY)
train_baseline.py    optional ML baseline → ml_model.json (OFF by default)
```

`bash deploy/build.sh` copies `risk-core.js` into the Worker bundle and the browser assets.

## Routes

| Route | Purpose |
|---|---|
| `GET /` | landing page |
| `GET /dashboard` | operator dashboard |
| `GET /status` | full assessment: severity, risk score, physics, fired rules, 12 h timeline |
| `GET /history` | session history (per worker isolate) |
| `POST /simulate` | forced HIGH scenario, badged SIMULATED, then dispatches the configured channels and returns `status.dispatch` |
| `GET /fires.geojson` | detections in the 25 km watch ring |
| `GET /weather.json` | wind/temp at the centre |
| `GET /config.json` | public config; exposes the Cesium token only if configured |
| `GET /backtest` | `backtest.json` when generated, otherwise 501 with the reason |
| `GET /reports` | community smoke/fire reports from the last 3 h, with distance from the centre |
| `POST /reports` | body `{lat, lng, kind, note}` → stored in D1, rejected outside 50 km |
| `POST /reports/:id/confirm` (or `/deny`) | Waze-style "still there" / "gone" vote |
| `GET /checkin` | family check-ins from the last 12 h, with safe/help counts |
| `POST /checkin` | body `{name, status: "safe" | "help"}` → stored in D1 |
| `GET /voice?lang=en|kn|hi` | the exact broadcast script, no call placed |
| `POST /voice?lang=…` | places a Twilio or Infobip voice call when credentials are configured |
| `GET /sms-test` | which SMS providers are configured, without sending |
| `GET /sms-test?send=1` or `POST /sms-test` | sends one test SMS and returns every upstream status/body |
| `GET /push/status` | Web Push configuration and subscriber count |
| `POST /push/subscribe` / `POST /push/unsubscribe` | store or remove a browser push subscription in D1 |
| `POST /push/test` | send one browser notification to every subscriber |

## Secrets

Set these as Worker secrets (never in the repo). Everything is optional except the FIRMS key if
you want real detections:

| Name | Used for |
|---|---|
| `FIRMS_MAP_KEY` | NASA FIRMS detections (otherwise SIMULATED) |
| `CESIUM_ION_TOKEN` | Cesium terrain/imagery; without it the map uses OSM on a flat ellipsoid |
| `DISCORD_WEBHOOK_URL` | Discord alerts (Worker and local engine) |
| `ALERT_SMS_TO` | SMS recipient (required for any SMS provider) |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | Twilio credentials (trial accounts must verify the recipient first) |
| `TWILIO_SMS_FROM` | SMS sender when Twilio's SMS trial number differs from the voice number |
| `TWILIO_VOICE_TO` | voice call target for Twilio; defaults to `ALERT_SMS_TO` |
| `TWILIO_VOICE_FROM` | optional voice sender when Twilio's trial number differs per product |
| `SMS_PROVIDER` | optional provider order, e.g. `twilio` (default: twilio, pingram, bulksmsglobal, infobip, textbelt) |
| `PINGRAM_API_KEY` | SMS via Pingram (free tier: 100 SMS/mo, no card) |
| `BULKSMSGLOBAL_API_KEY`, `SMS_SENDER` | SMS via BulkSMSGlobal (UAE free trial: 20 SMS) |
| `TEXTBELT_API_KEY` | SMS via TextBelt (paid key; the free key blocks many countries) |
| `INFOBIP_API_KEY`, `INFOBIP_SENDER` | SMS and voice via Infobip (Worker and local engine) |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_JWK` | Web Push browser notifications (EC P-256 VAPID keypair) |
| `VAPID_SUBJECT` | optional VAPID contact, defaults to `mailto:alerts@example.org` |
| `SENDGRID_API_KEY`, `ALERT_EMAIL_TO`, `SENDGRID_FROM` | Email alerts (Worker and local engine) |
| `INFOBIP_VOICE_TO`, `INFOBIP_VOICE_FROM` | Infobip Voice outbound call target and caller ID; without them `/voice` returns the script only |

The local engine reads the same names from the environment, then from `config.secrets.json`
(gitignored).

## Ground truth, voice and family check-in

**Community reports (Waze-style).** Satellite detections can be hours old, so the dashboard has
"I can see smoke / fire / it is gone" buttons. A report is a row in D1 with a timestamp, a kind and a
distance; it lives for 3 hours and can be confirmed or denied by others. Reports inside the ring add
up to +12 to the score and always name themselves in `reasons` — `1 unverified community report
nearby`. They are never presented as a confirmed fire, and the JSON marks them `unverified: true`.

**Street-level impact.** `/status.impact` turns the same numbers into a sentence a resident can act
on: distance, side (`upwind` / `downwind` / `crosswind`), compass bearing, and minutes to the ring at
the current spread estimate, plus the satellite pass time. A fire the wind carries *away* gets **no
arrival estimate** — the honest answer there is "no ETA", not a big number.

**Voice broadcast (Tier 1, no telephony).** `alertText()` in `risk-core.js` holds hand-written
English, Kannada and Hindi wording. The dashboard's 🔊 Speak button and the landing ladder use the
browser's `speechSynthesis` with `en-IN` / `kn-IN` / `hi-IN`, and the dashboard auto-speaks once per
HIGH transition after the first click (browsers block audio before a gesture). This is labelled
"text-to-speech broadcast", not a phone call.

**Voice call (Tier 2, optional).** `POST /voice` builds the same script and, when `INFOBIP_API_KEY`
and `INFOBIP_VOICE_TO` are set, posts an NCCO `say` action to `/voice/1/calls` in the right language.
Without them it returns `mode: simulated` with the exact script — so a demo never depends on
telephony, and nobody can mistake a simulation for a call that happened.

**Family check-in and routine disruption.** Check-ins are `safe` / `help` rows in D1 for 12 hours,
with counts shown on the dashboard. Routine windows (morning commute, school pickup, evening return)
are read off the 12-hour timeline and marked clear / watch / disrupted.

**Offline behaviour.** Reports and check-ins that fail (or that you file with no signal) go into a
`localStorage` outbox and flush on `online`; the dashboard shows how many are queued. "Copy alert"
puts the full alert text on the clipboard so it can be relayed by whatever chat still works. This is
an offline queue and a copy/relay payload — **not** a radio mesh, and the README does not claim one.

## Physics and decision logic

- **Heating rate** dT/dt over the previous 3 hours, in °C/h.
- **Canadian FWI system** — FFMC, DMC, DC, ISI, BUI, FWI, spun up over the 14 past days. This is a
  standard index calibrated on Canadian fuel types; we say so rather than implying it was tuned
  for Karnataka fuels. The codes are spun up over 16 days (14 days of history plus today), because
  FFMC/DMC/DC are recursive and yesterday's value feeds today's.
- **Terrain** — elevation on a 3×3 grid about 1 km apart, giving slope % and aspect. Wind blowing
  upslope raises the spread estimate.
- **Fuel class** — `urban | grass | scrub | forest` in `config.json`, a user-set multiplier.
- **Wind-aware threat** — bearing from fire to centre versus wind direction; downwind within ~30°
  is drawn as a wedge and scores higher than the same fire upwind.
- **Spread proxy** — `ISI × slope factor × fuel factor`, shown as an estimate in km/h with
  `ETA = distance / spread`. It is labelled an estimate everywhere.
- **Fuzzy engine** — Mamdani inference, 27 readable rules, centroid defuzzification, risk 0–100,
  LOW < 35 ≤ MEDIUM < 65 ≤ HIGH. Hard override: a confirmed fire inside 2 km is HIGH.
  Every response carries `fired_rules` with strengths so "why HIGH?" is answerable.
- **One simulated-detection generator** — `simulatedFires(cycle, centre, watchKm)` lives in
  `risk-core.js` and is mirrored by `risk_core.simulated_fires()` in Python. `engine.py` delegates to
  the Python one instead of generating its own. Given the same 15-minute cycle, both runtimes produce
  identical fires (lat/lng/FRP/confidence/satellite/distance), so SIMULATED-mode scores and timelines
  match exactly rather than drifting apart.
- **Python/JS parity checks** — `python3 parity_test.py` verifies three things in one run:
  1. **scoring** — 220 deterministic feature vectors through `assess()` in both runtimes;
  2. **band agreement** — LOW/MEDIUM/HIGH must match for every vector;
  3. **simulated detections** — 5 fixed cycles through both generators, field by field.
  Current result: max score delta **0.00**, 0 band mismatches, 0 fire mismatches.
  A live cross-check of the deployed Worker against the local engine on the same cycle also returns the
  same score and the same 12-hour timeline.

## Prediction ahead

The engine scores each of the next 12 forecast hours. If the forecast reaches HIGH within 6 hours
while now is LOW or MEDIUM, it records a WATCH pre-alert (at most one per 3 hours). Delivery needs
channel secrets; without them the WATCH is recorded as pending.

## Local preview of the same assets

```bash
python3 engine.py      # Flask engine on :5000 (live data, real channels)
python3 serve.py 3001  # single origin: / landing, /dashboard dashboard
```

`serve.py` serves `deploy/public` (the exact files the Worker hosts), proxies `/status`, `/history`,
`/simulate`, `/fires.geojson`, `/weather.json`, `/reports`, `/checkin` and `/voice` to the engine, and
answers `/config.json` and `/backtest` itself so the UI works even with the engine stopped.
Reports and check-ins are rows in D1 when hosted; locally `engine.py` keeps the same shapes in memory,
so every dashboard panel works on the laptop with no Cloudflare account.

## Backtest

```bash
FIRMS_MAP_KEY=... python3 backtest.py     # writes backtest.json
python3 train_baseline.py                 # optional, writes ml_model.json (disabled)
```

`backtest.py` refuses to run without a FIRMS key and writes nothing: real numbers only. The landing
page and dashboard read `/backtest` and say "not computed yet" until the file exists.

**Before enabling the ML baseline, check your hackathon's rule on model training.** `config.ml.enabled`
is `false`; the baseline never drives alerts unless you change that.

## Oxygen, honestly

Outdoor O₂ sits near 20.9% and does not change with fire risk. An electrochemical sensor on the Pi
(ADS1115 over I²C) would show local combustion context for responders, but the dashboard labels it
"no sensor" when absent and it never affects the score. PM2.5 and CO from Open-Meteo are the smoke
indicators.

## Run locally

```bash
pip install flask requests
python3 engine.py            # http://localhost:5000  (/status /history /simulate)
python3 parity_test.py       # Python vs JS engine parity
python3 backtest.py          # needs FIRMS_MAP_KEY
```

Deploy the hosted app by building the Worker bundle with `bash deploy/build.sh` and publishing
`deploy/manifest.json`.

## Attribution

Fire data: NASA FIRMS. Weather data by Open-Meteo.com (CC BY 4.0, non-commercial). Map:
OpenStreetMap contributors. Imagery: Cesium ion when a token is configured. The landing-page
background terrain, embers and satellite pass are illustrative, generated from noise.
