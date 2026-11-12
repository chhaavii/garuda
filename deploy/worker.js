/**
 * Garuda Worker - live fire-risk engine + dashboard/landing host.
 *
 * Data sources
 *   NASA FIRMS   - needs FIRMS_MAP_KEY secret; otherwise SIMULATED mode, badged.
 *   Open-Meteo   - forecast, air quality, elevation. Free, no key.
 *
 * Routes
 *   GET  /                 landing page (static asset)
 *   GET  /dashboard        dashboard page
 *   GET  /status           full assessment (cached 15 min)
 *   GET  /history          observed session history
 *   POST /simulate         forced HIGH scenario, badged simulated
 *   GET  /fires.geojson    detections in the watch ring
 *   GET  /weather.json     wind/temp at the centre
 *   GET  /config.json      public config (centre, thresholds, Cesium token if set)
 *   GET  /backtest         backtest.json if present, else an honest 501
 *   GET/POST /reports      community smoke/fire reports (D1), Waze-style confirmations
 *   GET/POST /checkin      family "I am safe" / "need help" check-ins (D1)
 *   GET/POST /voice        text-to-speech script, and an Infobip voice call when configured
 */

import {
  DEFAULT_CONFIG,
  assess,
  buildFeatures,
  forecastTimeline,
  timeToHigh,
  haversineKm,
  bearingDeg,
  angleDiff,
  fwiSpinUp,
  terrainFeatures,
  simulatedFires,
  impact,
  alertText,
  routineWindows,
  VOICE_LANGS,
  clamp,
} from "./risk-core.js";

const CACHE_MS = 15 * 60 * 1000;
const STALE_MS = 30 * 60 * 1000;
const CYCLE_MS = 15 * 60 * 1000;

const cache = {
  weather: null,
  air: null,
  terrain: null,
  fires: null,
  fetchedAt: 0,
  lastWatchAt: 0,
  history: [],
};

const round = (v, n = 1) => (v === null || v === undefined ? null : Math.round(v * 10 ** n) / 10 ** n);
const ist = (ms) => new Date(ms + 5.5 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ");
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" },
  });

/* ------------------------------------------------------------ adapters -- */
async function fetchWeather(cfg) {
  const { lat, lng } = cfg.centre;
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
    "&hourly=temperature_2m,relative_humidity_2m,dew_point_2m,vapour_pressure_deficit," +
    "wind_speed_10m,wind_gusts_10m,wind_direction_10m,precipitation,soil_moisture_0_to_1cm" +
    `&past_days=14&forecast_days=2&timezone=${encodeURIComponent(cfg.timezone)}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`open-meteo ${resp.status}`);
  const data = await resp.json();
  return parseWeather(data);
}

function parseWeather(data) {
  const h = data.hourly;
  const rows = h.time.map((time, i) => ({
    time,
    temp: h.temperature_2m[i],
    rh: h.relative_humidity_2m[i],
    dew_point: h.dew_point_2m[i],
    vpd: h.vapour_pressure_deficit[i],
    wind: h.wind_speed_10m[i],
    gust: h.wind_gusts_10m[i],
    wind_dir: h.wind_direction_10m[i],
    rain: h.precipitation[i],
    soil_moisture: h.soil_moisture_0_to_1cm[i],
  }));

  // "now" = the hourly bucket containing the current IST time.
  const nowIso = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 13);
  let idx = rows.findIndex((r) => r.time.slice(0, 13) === nowIso);
  if (idx < 0) idx = Math.max(0, rows.length - 48);

  // Daily noon observations for the FWI spin-up (14 past days + today).
  const byDay = new Map();
  rows.forEach((r) => {
    const day = r.time.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(r);
  });
  const daily = [];
  for (const [, dayRows] of [...byDay.entries()].sort()) {
    const noon = dayRows.find((r) => r.time.slice(11, 13) === "12") || dayRows[Math.floor(dayRows.length / 2)];
    if (!noon) continue;
    daily.push({
      temp: noon.temp,
      rh: noon.rh,
      wind: noon.wind,
      rain: dayRows.reduce((sum, r) => sum + (r.rain || 0), 0),
      month: Number(noon.time.slice(5, 7)),
    });
  }
  return { rows, idx, daily, elevation: data.elevation ?? null };
}

async function fetchAir(cfg) {
  const { lat, lng } = cfg.centre;
  const resp = await fetch(
    `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lng}` +
      "&hourly=pm2_5,carbon_monoxide&forecast_days=1"
  );
  if (!resp.ok) throw new Error(`air ${resp.status}`);
  const data = await resp.json();
  const idx = Math.max(0, data.hourly.time.length - 1);
  return {
    pm2_5: data.hourly.pm2_5[idx],
    co: data.hourly.carbon_monoxide[idx],
    time: data.hourly.time[idx],
  };
}

async function fetchTerrain(cfg) {
  const { lat, lng } = cfg.centre;
  const dLat = 1 / 111;
  const dLng = 1 / (111 * Math.cos((lat * Math.PI) / 180));
  const lats = [];
  const lngs = [];
  for (let row = -1; row <= 1; row++) {
    for (let col = -1; col <= 1; col++) {
      lats.push(round(lat + row * dLat, 5));
      lngs.push(round(lng + col * dLng, 5));
    }
  }
  const resp = await fetch(
    `https://api.open-meteo.com/v1/elevation?latitude=${lats.join(",")}&longitude=${lngs.join(",")}`
  );
  if (!resp.ok) throw new Error(`elevation ${resp.status}`);
  const data = await resp.json();
  return data.elevation.map((elevation, i) => ({ lat: lats[i], lng: lngs[i], elevation }));
}

/* --------------------------------------------------------------- FIRMS -- */
const SENSORS = ["VIIRS_SNPP_NRT", "VIIRS_NOAA20_NRT", "MODIS_NRT"];

function firmsBBox(cfg) {
  const { lat, lng } = cfg.centre;
  const dLat = cfg.watch_km / 111;
  const dLng = cfg.watch_km / (111 * Math.cos((lat * Math.PI) / 180));
  return `${(lng - dLng).toFixed(3)},${(lat - dLat).toFixed(3)},${(lng + dLng).toFixed(3)},${(lat + dLat).toFixed(3)}`;
}

async function fetchFirms(cfg, mapKey) {
  const bbox = firmsBBox(cfg);
  const fires = [];
  const results = await Promise.all(
    SENSORS.map(async (sensor) => {
      const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${mapKey}/${sensor}/${bbox}/1`;
      try {
        const resp = await fetch(url);
        if (!resp.ok) return { sensor, rows: [], error: `HTTP ${resp.status}` };
        const text = await resp.text();
        if (/Invalid MAP_KEY/i.test(text)) return { sensor, rows: [], error: "invalid MAP_KEY" };
        return { sensor, rows: parseFirmsCsv(text, sensor), error: null };
      } catch (err) {
        return { sensor, rows: [], error: String(err).slice(0, 80) };
      }
    })
  );

  const errors = [];
  for (const result of results) {
    if (result.error) errors.push(`${result.sensor}: ${result.error}`);
    for (const row of result.rows) {
      const distance = haversineKm(cfg.centre.lat, cfg.centre.lng, row.lat, row.lng);
      if (distance <= cfg.watch_km) fires.push({ ...row, distance_km: round(distance, 2) });
    }
  }

  if (!fires.length && errors.length) throw new Error(errors[0]);
  fires.sort((a, b) => a.distance_km - b.distance_km);
  return fires.slice(0, 2000);
}

function parseFirmsCsv(text, sensor) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const col = (name) => header.indexOf(name);
  const iLat = col("latitude");
  const iLng = col("longitude");
  const iConf = col("confidence");
  const iFrp = col("frp");
  const iDate = col("acq_date");
  const iTime = col("acq_time");
  const iSat = col("satellite");

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",");
    if (cells.length < header.length) continue;
    const rawConf = (cells[iConf] || "").trim().toLowerCase();
    if (["low", "l", "n"].includes(rawConf)) continue;
    const lat = Number(cells[iLat]);
    const lng = Number(cells[iLng]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const conf = Number(rawConf);
    if (Number.isFinite(conf) && conf > 0 && conf < 30) continue;
    rows.push({
      lat,
      lng,
      frp: Number(cells[iFrp]) || 0,
      confidence: Number.isFinite(conf) ? conf : rawConf || "nominal",
      satellite: (cells[iSat] || sensor).trim(),
      acq_datetime: `${cells[iDate]}T${(cells[iTime] || "0000").padStart(4, "0").slice(0, 2)}:${(cells[iTime] || "0000").padStart(4, "0").slice(2)}:00`,
    });
  }
  return rows;
}

/* --------------------------------------------------- D1: community data -- */
let dbReady = false;

async function ensureDb(env) {
  if (!env.DB) return false;
  if (dbReady) return true;
  try {
    await env.DB.batch([
      env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, lat REAL, lng REAL, kind TEXT, note TEXT, name TEXT, client TEXT, created_at INTEGER, confirms INTEGER DEFAULT 0, denies INTEGER DEFAULT 0)"
      ),
      env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS checkins (id TEXT PRIMARY KEY, name TEXT, status TEXT, note TEXT, lat REAL, lng REAL, created_at INTEGER)"
      ),
    ]);
    dbReady = true;
    return true;
  } catch (err) {
    return false;
  }
}

const REPORT_WINDOW_MS = 3 * 3600 * 1000;

async function loadReports(env, cfg, limit = 50) {
  if (!(await ensureDb(env))) return [];
  const rows = await env.DB.prepare(
    "SELECT * FROM reports WHERE created_at > ? ORDER BY created_at DESC LIMIT ?"
  )
    .bind(Date.now() - REPORT_WINDOW_MS, limit)
    .all();
  return (rows.results || []).map((r) => ({
    id: r.id,
    lat: r.lat,
    lng: r.lng,
    kind: r.kind,
    note: r.note,
    name: r.name,
    created_at: r.created_at,
    ago_minutes: Math.round((Date.now() - r.created_at) / 60000),
    confirms: r.confirms || 0,
    denies: r.denies || 0,
    distance_km: round(haversineKm(cfg.centre.lat, cfg.centre.lng, r.lat, r.lng), 2),
    unverified: true,
  }));
}

/* ------------------------------------------------------------- assembly -- */
async function loadData(env, cfg, force = false) {
  const fresh = Date.now() - cache.fetchedAt < CACHE_MS;
  if (!force && fresh && cache.weather) return cache;

  const notes = [];
  const weather = await fetchWeather(cfg).catch((err) => {
    notes.push(`weather: ${err}`);
    return cache.weather;
  });
  const air = await fetchAir(cfg).catch((err) => {
    notes.push(`air: ${err}`);
    return cache.air;
  });
  const terrain = await fetchTerrain(cfg).catch((err) => {
    notes.push(`terrain: ${err}`);
    return cache.terrain;
  });

  let fires = cache.fires || [];
  let firmsSource = env.FIRMS_MAP_KEY ? "live" : "simulated";
  if (env.FIRMS_MAP_KEY) {
    fires = await fetchFirms(cfg, env.FIRMS_MAP_KEY).catch((err) => {
      notes.push(`firms: ${err}`);
      firmsSource = cache.fires ? "stale" : "simulated";
      return cache.fires || simulatedFires(Math.floor(Date.now() / CYCLE_MS), cfg.centre, cfg.watch_km);
    });
  } else {
    fires = simulatedFires(Math.floor(Date.now() / CYCLE_MS), cfg.centre, cfg.watch_km);
  }

  cache.weather = weather || cache.weather;
  cache.air = air || cache.air;
  cache.terrain = terrain || cache.terrain;
  cache.fires = fires;
  cache.fetchedAt = Date.now();
  cache.notes = notes;
  cache.firmsSource = firmsSource;

  if (firmsSource === "simulated") cache.lastSimulatedAt = Date.now();
  return cache;
}

function sourceBadge(kind) {
  const age = Date.now() - cache.fetchedAt;
  if (kind === "firms" && cache.firmsSource === "simulated") return "simulated";
  if (age > STALE_MS) return "stale";
  return "live";
}

async function buildStatus(env, cfg, { forceHigh = false } = {}) {
  const data = await loadData(env, cfg);
  if (!data.weather) {
    return {
      error: "no weather data",
      severity: "LOW",
      risk_score: null,
      sources: { weather: "unavailable", firms: sourceBadge("firms") },
      notes: data.notes || [],
    };
  }

  const hour = data.weather.rows[data.weather.idx];
  const prev3 = data.weather.rows[Math.max(0, data.weather.idx - 3)];
  const heating = (hour.temp - prev3.temp) / 3;

  let fires = data.fires || [];
  if (forceHigh) {
    const dLat = (1.2 / 111) * Math.cos(0.5);
    const dLng = (1.2 / (111 * Math.cos((cfg.centre.lat * Math.PI) / 180))) * Math.sin(0.5);
    fires = [
      {
        lat: round(cfg.centre.lat + dLat, 5),
        lng: round(cfg.centre.lng + dLng, 5),
        frp: 38.2,
        confidence: "high",
        satellite: "SIMULATED",
        acq_datetime: new Date().toISOString().slice(0, 19),
        distance_km: 1.2,
      },
    ];
  }

  const terrain = data.terrain
    ? terrainFeatures(data.terrain, cfg.centre)
    : { elevation_m: null, slope_pct: 0, aspect_deg: null, available: false };

  const features = buildFeatures({
    weatherHour: {
      temp: hour.temp,
      rh: hour.rh,
      dew_point: hour.dew_point,
      vpd: hour.vpd,
      wind: hour.wind,
      gust: hour.gust,
      wind_dir: hour.wind_dir,
      rain: hour.rain,
      soil_moisture: hour.soil_moisture,
      heating,
    },
    daily: data.weather.daily,
    fires,
    terrain,
    air: data.air,
    config: cfg,
  });

  // People on the ground beat a satellite pass that may be hours old, but a
  // report is unverified: it nudges the score and is labelled as such.
  const community = await loadReports(env, cfg).catch(() => []);
  features.reports_near = community.filter((r) => r.distance_km <= cfg.geofence_km).length;

  const assessment = assess(features, cfg);

  const hours = data.weather.rows
    .slice(data.weather.idx, data.weather.idx + cfg.forecast_hours)
    .map((row, i) => ({
      time: row.time,
      wind_kmh: round(row.wind),
      wind_dir_deg: round(row.wind_dir),
      rh: round(row.rh),
      heating_rate_c_h: round(
        (row.temp - data.weather.rows[Math.max(0, data.weather.idx + i - 3)].temp) / 3,
        2
      ),
    }));
  const timeline = forecastTimeline(features, hours, cfg);
  const tth = timeToHigh(timeline, cfg);
  const severity = forceHigh ? "HIGH" : assessment.band;
  const impactData = impact(features, fires, assessment, cfg);
  const alertCopies = Object.fromEntries(
    VOICE_LANGS.map((l) => [
      l.code,
      alertText(l.code, { severity, score: assessment.score, impact: impactData }),
    ])
  );
  const routine = routineWindows(timeline);

  // WATCH pre-alert when the next 6 h reach HIGH while now is not HIGH.
  let watch = null;
  if (
    assessment.band !== "HIGH" &&
    tth &&
    tth.hours <= cfg.watch_horizon_hours &&
    Date.now() - cache.lastWatchAt > cfg.watch_cooldown_hours * 3600 * 1000
  ) {
    cache.lastWatchAt = Date.now();
    watch = {
      issued_at: ist(Date.now()),
      expected_in_hours: tth.hours,
      expected_at: tth.at,
      delivered: false,
      note: "Delivery requires channel secrets; recorded as WATCH pending.",
    };
  }

  const status = {
    timestamp: ist(Date.now()),
    cycle: {
      index: Math.floor(Date.now() / CYCLE_MS),
      minutes: cfg.cycle_minutes,
      seconds_remaining: Math.max(0, Math.round(((Math.floor(Date.now() / CYCLE_MS) + 1) * CYCLE_MS - Date.now()) / 1000)),
    },
    severity,
    risk_score: assessment.score,
    message: alertCopies.en.text,
    impact: impactData,
    alert_text: alertCopies,
    routine,
    community_reports: community,
    reasons: assessment.reasons,
    fired_rules: assessment.fired_rules,
    override: assessment.override,
    spread_estimate_kmh: assessment.spread_estimate_kmh,
    eta_hours: assessment.eta_hours,
    upslope: assessment.upslope,
    fuel_class: assessment.fuel_class,
    fuel_multiplier: assessment.fuel_multiplier,
    features,
    timeline,
    time_to_high: tth,
    watch,
    air: {
      pm2_5: data.air ? round(data.air.pm2_5, 1) : null,
      co: data.air ? round(data.air.co, 0) : null,
      o2_percent: null,
      o2_note: "no sensor attached",
      baseline_percent: 20.9,
      smoke:
        data.air && ((data.air.pm2_5 ?? 0) > 60 || (data.air.co ?? 0) > 4000) ? true : false,
    },
    fires,
    sources: {
      firms: forceHigh ? "simulated" : sourceBadge("firms"),
      weather: cache.notes?.some((n) => n.startsWith("weather")) ? "stale" : "live",
      terrain: terrain.available ? (cache.notes?.some((n) => n.startsWith("terrain")) ? "stale" : "live") : "unavailable",
      air: data.air ? (cache.notes?.some((n) => n.startsWith("air")) ? "stale" : "live") : "unavailable",
      elevation_api: "Open-Meteo",
    },
    notes: cache.notes || [],
    simulated: forceHigh,
    mock_data: sourceBadge("firms") === "simulated" || forceHigh,
    hosted: true,
  };

  cache.history.push({ timestamp: status.timestamp, severity: status.severity, risk_score: status.risk_score });
  if (cache.history.length > 96) cache.history.shift();
  return status;
}

/* ---------------------------------------------------------------- routes -- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cfg = { ...DEFAULT_CONFIG, ...(await loadConfig(env)) };

    if (url.pathname === "/status") {
      const status = await buildStatus(env, cfg, { forceHigh: url.searchParams.get("simulate") === "high" });
      return json(status);
    }

    if (url.pathname === "/history") {
      return json({ cycles: cache.history.slice(-32), note: "session history (per worker isolate)" });
    }

    if (url.pathname === "/simulate") {
      if (request.method !== "POST") return json({ error: "use POST" }, 405);
      const status = await buildStatus(env, cfg, { forceHigh: true });
      return json({ result: "success", simulated: true, status });
    }

    if (url.pathname === "/fires.geojson") {
      const data = await loadData(env, cfg);
      const badge = sourceBadge("firms");
      const features = (data.fires || []).map((fire, i) => ({
        type: "Feature",
        id: `fire-${i}`,
        geometry: { type: "Point", coordinates: [fire.lng, fire.lat] },
        properties: {
          frp: fire.frp,
          confidence: fire.confidence,
          satellite: fire.satellite,
          acq_datetime: fire.acq_datetime,
          distance_km_from_centre: fire.distance_km,
          source: badge === "simulated" ? "SIMULATED" : "NASA FIRMS",
        },
      }));
      return new Response(
        JSON.stringify({
          type: "FeatureCollection",
          features,
          meta: { updated: ist(cache.fetchedAt), age_seconds: Math.round((Date.now() - cache.fetchedAt) / 1000), badge, watch_km: cfg.watch_km, geofence_km: cfg.geofence_km },
        }),
        { headers: { "content-type": "application/geo+json", "cache-control": "no-store" } }
      );
    }

    if (url.pathname === "/weather.json") {
      const data = await loadData(env, cfg);
      const hour = data.weather?.rows[data.weather.idx];
      return json({
        wind_kmh: hour ? round(hour.wind) : null,
        wind_gust_kmh: hour ? round(hour.gust) : null,
        wind_dir_deg: hour ? round(hour.wind_dir) : null,
        temp_c: hour ? round(hour.temp) : null,
        rh: hour ? round(hour.rh) : null,
        updated: ist(cache.fetchedAt),
        badge: sourceBadge("weather"),
      });
    }

    if (url.pathname === "/config.json") {
      return json({
        centre: cfg.centre,
        geofence_km: cfg.geofence_km,
        watch_km: cfg.watch_km,
        thresholds: cfg.thresholds,
        fuel_class: cfg.fuel_class,
        cycle_minutes: cfg.cycle_minutes,
        cesium_ion_token: env.CESIUM_ION_TOKEN || null,
        firms_configured: !!env.FIRMS_MAP_KEY,
        channels_configured: !!(env.DISCORD_WEBHOOK_URL && env.INFOBIP_API_KEY && env.SENDGRID_API_KEY),
        db_ready: !!env.DB,
        voice_configured: !!(env.INFOBIP_API_KEY && env.INFOBIP_VOICE_TO),
        voice_languages: VOICE_LANGS,
        reports_window_hours: 3,
      });
    }

    if (url.pathname === "/reports" || url.pathname.startsWith("/reports/")) {
      if (!(await ensureDb(env))) return json({ error: "storage not ready", reports: [], count_near: 0 }, 503);

      if (url.pathname === "/reports" && request.method === "GET") {
        const reports = await loadReports(env, cfg, 200);
        return json({
          reports,
          count_near: reports.filter((r) => r.distance_km <= cfg.geofence_km).length,
          window_hours: 3,
          source: "community reports (unverified)",
        });
      }

      if (url.pathname === "/reports" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const lat = Number(body.lat);
        const lng = Number(body.lng);
        const kind = ["smoke", "fire", "embers", "clear"].includes(body.kind) ? body.kind : "smoke";
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return json({ error: "lat,lng required" }, 400);
        const distance = haversineKm(cfg.centre.lat, cfg.centre.lng, lat, lng);
        if (distance > cfg.watch_km * 2) return json({ error: `outside the ${cfg.watch_km} km watch ring` }, 400);
        const id = crypto.randomUUID();
        await env.DB.prepare(
          "INSERT INTO reports (id, lat, lng, kind, note, name, client, created_at) VALUES (?,?,?,?,?,?,?,?)"
        )
          .bind(
            id,
            lat,
            lng,
            kind,
            String(body.note || "").slice(0, 160),
            String(body.name || "").slice(0, 40),
            String(body.client || "").slice(0, 64),
            Date.now()
          )
          .run();
        return json({ ok: true, id, kind, distance_km: round(distance, 2), unverified: true, window_hours: 3 }, 201);
      }

      const vote = url.pathname.match(/^\/reports\/([\w-]+)\/(confirm|deny)$/);
      if (vote && request.method === "POST") {
        const column = vote[2] === "confirm" ? "confirms" : "denies";
        await env.DB.prepare(`UPDATE reports SET ${column} = ${column} + 1 WHERE id = ?`).bind(vote[1]).run();
        return json({ ok: true, id: vote[1], vote: vote[2] });
      }

      return json({ error: "unsupported report request" }, 405);
    }

    if (url.pathname === "/checkin") {
      if (!(await ensureDb(env))) return json({ error: "storage not ready", checkins: [] }, 503);

      if (request.method === "GET") {
        const rows = await env.DB.prepare(
          "SELECT * FROM checkins WHERE created_at > ? ORDER BY created_at DESC LIMIT 40"
        )
          .bind(Date.now() - 12 * 3600 * 1000)
          .all();
        const checkins = (rows.results || []).map((c) => ({
          id: c.id,
          name: c.name,
          status: c.status,
          note: c.note,
          ago_minutes: Math.round((Date.now() - c.created_at) / 60000),
        }));
        return json({
          checkins,
          safe: checkins.filter((c) => c.status === "safe").length,
          help: checkins.filter((c) => c.status === "help").length,
          window_hours: 12,
        });
      }

      if (request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const name = String(body.name || "").trim().slice(0, 40);
        if (!name) return json({ error: "name required" }, 400);
        const status = body.status === "help" ? "help" : "safe";
        const id = crypto.randomUUID();
        await env.DB.prepare(
          "INSERT INTO checkins (id, name, status, note, lat, lng, created_at) VALUES (?,?,?,?,?,?,?)"
        )
          .bind(
            id,
            name,
            status,
            String(body.note || "").slice(0, 120),
            Number.isFinite(Number(body.lat)) ? Number(body.lat) : null,
            Number.isFinite(Number(body.lng)) ? Number(body.lng) : null,
            Date.now()
          )
          .run();
        return json({ ok: true, id, name, status }, 201);
      }

      return json({ error: "unsupported checkin request" }, 405);
    }

    if (url.pathname === "/voice") {
      const lang = (url.searchParams.get("lang") || "en").toLowerCase();
      const status = await buildStatus(env, cfg, { forceHigh: url.searchParams.get("simulate") === "high" });
      const copy = alertText(lang, {
        severity: status.severity,
        score: status.risk_score,
        impact: status.impact,
      });
      const to = env.INFOBIP_VOICE_TO;
      const configured = !!(env.INFOBIP_API_KEY && to);

      if (!configured || request.method !== "POST") {
        return json({
          mode: configured ? "configured" : "simulated",
          language: copy.bcp47,
          text: copy.text,
          script: copy.voice_script,
          steps: copy.steps,
          label: copy.label,
          reason: configured
            ? "POST to place the call"
            : "INFOBIP_API_KEY and INFOBIP_VOICE_TO not set - script generated, no call placed",
        });
      }

      const voiceLang = copy.bcp47.split("-")[0];
      const resp = await fetch("https://api.infobip.com/voice/1/calls", {
        method: "POST",
        headers: { authorization: `App ${env.INFOBIP_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({
          destinations: [{ to }],
          from: env.INFOBIP_VOICE_FROM || "Garuda",
          language: voiceLang,
          ncco: [{ action: "say", text: copy.voice_script, language: voiceLang }],
        }),
      });
      const detail = (await resp.text()).slice(0, 300);
      return json(
        {
          mode: resp.ok ? "live" : "failed",
          language: copy.bcp47,
          text: copy.text,
          script: copy.voice_script,
          upstream_status: resp.status,
          detail,
        },
        resp.ok ? 200 : 502
      );
    }

    if (url.pathname === "/backtest") {
      const asset = await env.ASSETS.fetch(new URL("/backtest.json", url));
      const isJson = (asset.headers.get("content-type") || "").includes("json");
      if (!asset.ok || !isJson) {
        return json(
          { status: "unavailable", reason: "Run backtest.py with FIRMS_MAP_KEY set to generate backtest.json." },
          501
        );
      }
      return new Response(asset.body, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }

    if (url.pathname === "/dashboard" || url.pathname === "/dashboard/") {
      return env.ASSETS.fetch(new URL("/dashboard.html", url));
    }

    return env.ASSETS.fetch(request);
  },
};

let configCache = null;
let configCacheAt = 0;
async function loadConfig() {
  if (configCache && Date.now() - configCacheAt < 60000) return configCache;
  configCache = {};
  configCacheAt = Date.now();
  return configCache;
}
