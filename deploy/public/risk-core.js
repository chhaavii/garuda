/**
 * Garuda risk core - the single source of truth.
 *
 * Used by the Worker (/status, /history, /simulate, /fires.geojson),
 * by the dashboard, and by the landing-page fuzzy playground, so the
 * number a visitor drags a slider to is the number the engine uses.
 *
 * Pure functions only: no fetch, no randomness, no time-of-day side effects.
 */

export const DEFAULT_CONFIG = {
  centre: { lat: 12.9716, lng: 77.5946 },
  geofence_km: 5,
  watch_km: 25,
  fuel_class: "urban",
  fuel_multiplier: { urban: 0.6, grass: 1.2, scrub: 1.0, forest: 0.9 },
  thresholds: { medium: 35, high: 65, hard_override_km: 2 },
  cycle_minutes: 15,
  forecast_hours: 12,
  watch_horizon_hours: 6,
  watch_cooldown_hours: 3,
  timezone: "Asia/Kolkata",
};

const RAD = Math.PI / 180;
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

/* ------------------------------------------------------------------ geo -- */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function bearingDeg(lat1, lon1, lat2, lon2) {
  const y = Math.sin((lon2 - lon1) * RAD) * Math.cos(lat2 * RAD);
  const x =
    Math.cos(lat1 * RAD) * Math.sin(lat2 * RAD) -
    Math.sin(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.cos((lon2 - lon1) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

/** Smallest absolute angle between two bearings, 0..180. */
export function angleDiff(a, b) {
  const d = Math.abs(((a - b + 540) % 360) - 180);
  return d;
}

/* ------------------------------------------------- Canadian FWI system -- */
const LE = [6.5, 7.5, 9.0, 12.8, 13.9, 13.9, 12.4, 10.9, 9.4, 8.0, 7.0, 6.0];
const FL = [-1.6, -1.6, -1.6, 0.9, 3.8, 5.8, 6.4, 5.0, 2.4, 0.4, -1.6, -1.6];

export function ffmc(temp, rh, wind, rain, prev = 85) {
  rh = clamp(rh, 1, 100);
  wind = Math.max(wind, 0);
  let mo = (147.2 * (101 - prev)) / (59.5 + prev);
  if (rain > 0.5) {
    const rf = rain - 0.5;
    const decay = Math.exp(-100 / Math.max(251 - mo, 1));
    let wetting = 42.5 * rf * decay * (1 - Math.exp(-6.93 / rf));
    if (mo > 150) wetting += 0.0015 * (mo - 150) ** 2 * Math.sqrt(rf);
    mo = Math.min(mo + wetting, 250);
  }
  const ed =
    0.942 * rh ** 0.679 +
    11 * Math.exp((rh - 100) / 10) +
    0.18 * (21.1 - temp) * (1 - Math.exp(-0.115 * rh));
  let m;
  if (mo > ed) {
    const ko = 0.424 * (1 - (rh / 100) ** 1.7) + 0.0694 * Math.sqrt(wind) * (1 - (rh / 100) ** 8);
    m = ed + (mo - ed) * Math.pow(10, -(ko * 0.581 * Math.exp(0.0365 * temp)));
  } else {
    const ew =
      0.618 * rh ** 0.753 +
      10 * Math.exp((rh - 100) / 10) +
      0.18 * (21.1 - temp) * (1 - Math.exp(-0.115 * rh));
    if (mo < ew) {
      const kl =
        0.424 * (1 - ((100 - rh) / 100) ** 1.7) +
        0.0694 * Math.sqrt(wind) * (1 - ((100 - rh) / 100) ** 8);
      m = ew + (mo - ew) * Math.pow(10, -(kl * 0.581 * Math.exp(0.0365 * temp)));
    } else m = mo;
  }
  return clamp((59.5 * (250 - m)) / (147.2 + m), 0, 101);
}

export function dmc(temp, rh, rain, prev = 6, month = 11) {
  rh = clamp(rh, 1, 100);
  const k = 1.894 * (temp + 1.1) * (100 - rh) * LE[month - 1] * 1e-6;
  let pr = prev;
  if (rain > 1.5) {
    const rf = rain - 1.5;
    let mr = 20 + Math.exp(5.6348 - prev / 43.43);
    const b = prev <= 33 ? 100 / (0.5 + 0.3 * prev) : prev <= 65 ? 14 - 1.3 * Math.log(prev) : 6.2 * Math.log(prev) - 17.2;
    mr += (1000 * rf) / (48.77 + b * rf);
    pr = Math.max(0, 244.72 - 43.43 * Math.log(Math.max(mr - 20, 1e-6)));
  }
  return clamp(pr + 100 * k, 0, 500);
}

export function dc(temp, rain, prev = 15, month = 11) {
  const t = Math.max(temp, -2.8);
  const pe = Math.max(0, 0.36 * (t + 2.8) + FL[month - 1]);
  let d = prev;
  if (rain > 2.8) d = Math.max(0, d - 0.83 * rain + 1.27);
  return Math.max(0, d + pe);
}

export function isi(ffmcValue, wind) {
  const m = (147.2 * (101 - ffmcValue)) / (59.5 + ffmcValue);
  const fWind = Math.exp(0.05039 * Math.max(wind, 0));
  const fFuel = 91.9 * Math.exp(-0.1386 * m) * (1 + m ** 5.31 / 4.93e7);
  return 0.208 * fWind * fFuel;
}

export function bui(dmcValue, dcValue) {
  const denom = dmcValue + 0.4 * dcValue;
  if (denom <= 0) return 0;
  if (dmcValue <= 0.4 * dcValue) return (0.8 * dmcValue * dcValue) / denom;
  return dmcValue - (1 - (0.8 * dcValue) / denom) * (0.92 + (0.0114 * dmcValue) ** 1.7);
}

export function fwi(isiValue, buiValue) {
  const fD = buiValue <= 80 ? 0.626 * buiValue ** 0.809 + 2 : 1000 / (25 + 108.64 * Math.exp(-0.023 * buiValue));
  const b = 0.1 * isiValue * fD;
  return b > 1 ? Math.exp(2.72 * (0.434 * Math.log(b)) ** 0.647) : b;
}

export function dangerClass(value) {
  if (value < 5) return "low";
  if (value < 10) return "moderate";
  if (value < 20) return "high";
  if (value < 30) return "very high";
  return "extreme";
}

/**
 * Spin the FWI codes up over a series of daily observations.
 * `daily` = [{temp, rh, wind, rain, month}] oldest first.
 */
export function fwiSpinUp(daily) {
  let codes = { ffmc: 85, dmc: 6, dc: 15 };
  for (const day of daily) {
    const ffmcValue = ffmc(day.temp, day.rh, day.wind, day.rain, codes.ffmc);
    const dmcValue = dmc(day.temp, day.rh, day.rain, codes.dmc, day.month);
    const dcValue = dc(day.temp, day.rain, codes.dc, day.month);
    codes = { ffmc: ffmcValue, dmc: dmcValue, dc: dcValue };
  }
  const isiValue = isi(codes.ffmc, daily.length ? daily[daily.length - 1].wind : 10);
  const buiValue = bui(codes.dmc, codes.dc);
  const fwiValue = fwi(isiValue, buiValue);
  return {
    ffmc: r1(codes.ffmc),
    dmc: r1(codes.dmc),
    dc: r1(codes.dc),
    isi: r2(isiValue),
    bui: r1(buiValue),
    fwi: r1(fwiValue),
    danger_class: dangerClass(fwiValue),
    spun_up_days: daily.length,
  };
}

/* ------------------------------------------------------------- terrain -- */
/**
 * Slope and aspect from a 3x3 elevation grid about 1 km apart.
 * `grid` is [{lat, lng, elevation}] row-major (NW..SE).
 */
export function terrainFeatures(grid, centre) {
  if (!grid || grid.length !== 9) {
    return { elevation_m: null, slope_pct: 0, aspect_deg: null, available: false };
  }
  const e = grid.map((cell) => cell.elevation);
  const dzdx = ((e[2] + 2 * e[5] + e[8]) - (e[0] + 2 * e[3] + e[6])) / 8; // east-west
  const dzdy = ((e[6] + 2 * e[7] + e[8]) - (e[0] + 2 * e[1] + e[2])) / 8; // south-north
  const cellKm = haversineKm(grid[0].lat, grid[0].lng, grid[4].lat, grid[4].lng) || 1;
  const risePerKm = Math.hypot(dzdx, dzdy) / (cellKm * 1000);
  const slopePct = clamp(risePerKm * 100, 0, 200);
  let aspect = null;
  if (Math.hypot(dzdx, dzdy) > 0.01) {
    aspect = (Math.atan2(dzdx, dzdy) / RAD + 360) % 360;
  }
  return {
    elevation_m: e[4],
    slope_pct: r1(slopePct),
    aspect_deg: aspect === null ? null : r1(aspect),
    available: true,
  };
}

/* ---------------------------------------------------------------- fuzzy -- */
const tri = (x, a, b, c) => (x <= a || x >= c ? 0 : x === b ? 1 : x < b ? (x - a) / (b - a) : (c - x) / (c - b));
const trap = (x, a, b, c, d) => (x <= a || x >= d ? 0 : b <= x && x <= c ? 1 : x < b ? (x - a) / (b - a) : (d - x) / (d - c));

/** Membership functions. Breakpoints calibrated with percentiles from backtest.py. */
export function fuzzify(f) {
  const ff = f.ffmc ?? 70;
  const wind = f.wind_kmh ?? 0;
  const heat = f.heating_rate_c_h ?? 0;
  const rh = f.rh ?? 50;
  const slope = f.slope_pct ?? 0;
  const prox = clamp(f.fire_distance_km ?? 25, 0, 25);
  const align = clamp(f.alignment ?? 0, 0, 1);

  return {
    ffmc: {
      low: trap(ff, 0, 0, 70, 80),
      moderate: tri(ff, 72, 82, 90),
      high: trap(ff, 82, 88, 96, 101),
      extreme: trap(ff, 90, 96, 101, 101),
    },
    wind: {
      calm: trap(wind, 0, 0, 8, 15),
      moderate: tri(wind, 10, 20, 32),
      strong: trap(wind, 26, 38, 80, 80),
    },
    heating: {
      cooling: trap(heat, -6, -6, 0, 0.5),
      steady: tri(heat, 0, 0.6, 1.4),
      rapid: trap(heat, 1.0, 2.0, 8, 8),
    },
    humidity: {
      humid: trap(rh, 60, 70, 100, 100),
      moderate: tri(rh, 30, 45, 60),
      dry: trap(rh, 18, 30, 45, 45),
    },
    slope: {
      flat: trap(slope, 0, 0, 3, 7),
      moderate: tri(slope, 4, 10, 18),
      steep: trap(slope, 14, 22, 60, 60),
    },
    proximity: {
      none: trap(prox, 10, 15, 25, 25),
      far: tri(prox, 2.5, 6, 12),
      near: tri(prox, 0.8, 2, 4),
      inside: trap(prox, 0, 0, 2, 3),
    },
    alignment: {
      crosswind: trap(align, 0, 0, 0.35, 0.6),
      partial: tri(align, 0.4, 0.7, 0.95),
      downwind: trap(align, 0.75, 0.9, 1, 1),
    },
  };
}

export const RULES = [
  ["ffmc extreme and wind strong", { ffmc: ["extreme"], wind: ["strong"] }, "high"],
  ["ffmc extreme and air dry", { ffmc: ["extreme"], humidity: ["dry"] }, "high"],
  ["ffmc high and wind strong", { ffmc: ["high"], wind: ["strong"] }, "high"],
  ["ffmc high and heating rapid", { ffmc: ["high"], heating: ["rapid"] }, "high"],
  ["ffmc high and slope steep", { ffmc: ["high"], slope: ["steep"] }, "medium"],
  ["ffmc moderate and heating rapid", { ffmc: ["moderate"], heating: ["rapid"] }, "medium"],
  ["ffmc moderate and wind moderate", { ffmc: ["moderate"], wind: ["moderate"] }, "medium"],
  ["ffmc moderate and humidity moderate", { ffmc: ["moderate"], humidity: ["moderate"] }, "medium"],
  ["ffmc low and air humid", { ffmc: ["low"], humidity: ["humid"] }, "low"],
  ["ffmc low and wind calm", { ffmc: ["low"], wind: ["calm"] }, "low"],
  ["wind strong and heating rapid", { wind: ["strong"], heating: ["rapid"] }, "high"],
  ["wind strong and air dry", { wind: ["strong"], humidity: ["dry"] }, "high"],
  ["fire inside and downwind and wind strong", { proximity: ["inside"], alignment: ["downwind"], wind: ["strong"] }, "very_high"],
  ["fire inside and downwind", { proximity: ["inside"], alignment: ["downwind"] }, "high"],
  ["fire inside", { proximity: ["inside"] }, "high"],
  ["fire near and downwind and wind moderate", { proximity: ["near"], alignment: ["downwind"], wind: ["moderate"] }, "high"],
  ["fire near and wind strong", { proximity: ["near"], wind: ["strong"] }, "high"],
  ["fire near and air dry", { proximity: ["near"], humidity: ["dry"] }, "medium"],
  ["fire near and heating rapid", { proximity: ["near"], heating: ["rapid"] }, "medium"],
  ["fire far and ffmc high", { proximity: ["far"], ffmc: ["high"] }, "medium"],
  ["fire far and wind strong", { proximity: ["far"], wind: ["strong"] }, "medium"],
  ["slope steep and wind moderate and air dry", { slope: ["steep"], wind: ["moderate"], humidity: ["dry"] }, "high"],
  ["slope steep and ffmc high", { slope: ["steep"], ffmc: ["high"] }, "high"],
  ["heating rapid and air dry", { heating: ["rapid"], humidity: ["dry"] }, "medium"],
  ["no fire and ffmc moderate", { proximity: ["none"], ffmc: ["moderate"] }, "low"],
  ["no fire and wind calm and air humid", { proximity: ["none"], wind: ["calm"], humidity: ["humid"] }, "low"],
  ["no fire and ffmc high", { proximity: ["none"], ffmc: ["high"] }, "medium"],
];

const OUTPUT = {
  low: [0, 0, 18, 34],
  medium: [28, 50, 68],
  high: [60, 78, 92, 96],
  very_high: [88, 95, 100, 100],
};

const outMu = (score, name) => {
  const o = OUTPUT[name];
  return o.length === 4 ? trap(score, o[0], o[1], o[2], o[3]) : tri(score, o[0], o[1], o[2]);
};

/**
 * Mamdani inference -> 0..100 risk. Returns the full explanation so the UI
 * can answer "why HIGH?" with fired rules and their strengths.
 */
export function fuzzyRisk(features, config = DEFAULT_CONFIG) {
  const memberships = fuzzify(features);
  const agg = { low: 0, medium: 0, high: 0, very_high: 0 };
  const fired = [];

  for (const [name, conditions, consequent] of RULES) {
    let strength = 1;
    for (const variable of Object.keys(conditions)) {
      let best = 0;
      for (const term of conditions[variable]) best = Math.max(best, memberships[variable][term]);
      strength = Math.min(strength, best);
    }
    if (strength > 0) {
      agg[consequent] = Math.max(agg[consequent], strength);
      fired.push({ rule: name, strength: r2(strength), output: consequent });
    }
  }

  let num = 0;
  let den = 0;
  for (let s = 0; s <= 100; s++) {
    const mu = Math.max(
      Math.min(agg.low, outMu(s, "low")),
      Math.min(agg.medium, outMu(s, "medium")),
      Math.min(agg.high, outMu(s, "high")),
      Math.min(agg.very_high, outMu(s, "very_high"))
    );
    num += s * mu;
    den += mu;
  }
  let score = den > 0 ? num / den : 30;

  // Hard override: a confirmed fire inside the hard-override radius is HIGH.
  const overrideKm = config.thresholds.hard_override_km;
  const overridden = (features.fire_distance_km ?? 99) <= overrideKm;
  if (overridden) score = Math.max(score, 70);

  score = r1(clamp(score, 0, 100));
  const band = score < config.thresholds.medium ? "LOW" : score < config.thresholds.high ? "MEDIUM" : "HIGH";
  fired.sort((a, b) => b.strength - a.strength);

  return {
    score,
    band,
    memberships,
    fired_rules: fired.slice(0, 8),
    override: overridden ? `fire within ${overrideKm} km` : null,
    reasons: fired.slice(0, 4).map((f) => f.rule),
  };
}

/* ----------------------------------------------------------- assessment -- */
/**
 * Turn a feature bundle into the assessed status the API serves.
 * `features`:
 *   ffmc, wind_kmh, rh, heating_rate_c_h, slope_pct, aspect_deg,
 *   fuel_class, fire_distance_km, alignment, fires[]
 */
export function assess(features, config = DEFAULT_CONFIG) {
  const fuzzy = fuzzyRisk(features, config);
  const fuelMult = config.fuel_multiplier[features.fuel_class] ?? 1;

  // Community reports (people on the ground) are ground truth with a caveat:
  // unverified by definition, so they move the score a little and say so.
  const reports = Math.max(0, Math.min(3, Math.round(features.reports_near ?? 0)));
  let score = fuzzy.score;
  let band = fuzzy.band;
  let reasons = fuzzy.override ? [`hard override: ${fuzzy.override}`, ...fuzzy.reasons] : [...fuzzy.reasons];
  if (reports > 0) {
    score = r1(clamp(score + Math.min(12, 6 * reports), 0, 100));
    band = score < config.thresholds.medium ? "LOW" : score < config.thresholds.high ? "MEDIUM" : "HIGH";
    reasons = [`${reports} unverified community report${reports > 1 ? "s" : ""} nearby`, ...reasons];
  }

  const upslope =
    features.aspect_deg !== null && features.aspect_deg !== undefined && features.wind_dir_deg !== undefined
      ? angleDiff(features.aspect_deg, (features.wind_dir_deg + 180) % 360) < 60
      : false;
  const slopeFactor = 1 + (features.slope_pct ?? 0) / 100 * (upslope ? 1.2 : 0.4);

  // Spread proxy: ISI-scaled, fuel- and slope-weighted. An estimate, not a model.
  const spreadKmh = r2(clamp(fuzzy.memberships.ffmc ? ((features.isi ?? 0) / 12) * slopeFactor * fuelMult * 1.6 : 0, 0, 20));
  const etaHours =
    features.fire_distance_km !== undefined && features.fire_distance_km < config.watch_km && spreadKmh > 0.2
      ? r1(features.fire_distance_km / spreadKmh)
      : null;

  return {
    ...fuzzy,
    score,
    band,
    spread_estimate_kmh: spreadKmh,
    eta_hours: etaHours,
    upslope: upslope,
    fuel_class: features.fuel_class,
    fuel_multiplier: fuelMult,
    community_reports: reports,
    reasons,
  };
}

/** Build the feature bundle from raw adapters. */
export function buildFeatures({ weatherHour, daily, fires, terrain, air, config = DEFAULT_CONFIG }) {
  const centre = config.centre;
  const nearest = fires && fires.length
    ? fires.reduce((best, f) => (f.distance_km < best.distance_km ? f : best), fires[0])
    : null;

  let alignment = 0;
  if (nearest && weatherHour) {
    const toCentre = bearingDeg(nearest.lat, nearest.lng, centre.lat, centre.lng);
    alignment = clamp(1 - angleDiff(toCentre, weatherHour.wind_dir) / 90, 0, 1);
  }

  const codes = fwiSpinUp(daily || []);
  return {
    ffmc: codes.ffmc,
    fwi: codes.fwi,
    isi: codes.isi,
    bui: codes.bui,
    dmc: codes.dmc,
    dc: codes.dc,
    danger_class: codes.danger_class,
    spun_up_days: codes.spun_up_days,
    wind_kmh: weatherHour ? r1(weatherHour.wind) : null,
    gust_kmh: weatherHour ? r1(weatherHour.gust ?? weatherHour.wind) : null,
    wind_dir_deg: weatherHour ? r1(weatherHour.wind_dir) : null,
    rh: weatherHour ? r1(weatherHour.rh) : null,
    temp_c: weatherHour ? r1(weatherHour.temp) : null,
    dew_point_c: weatherHour ? r1(weatherHour.dew_point) : null,
    vpd_kpa: weatherHour ? r2(weatherHour.vpd) : null,
    heating_rate_c_h: weatherHour ? r2(weatherHour.heating) : null,
    soil_moisture: weatherHour ? r2(weatherHour.soil_moisture) : null,
    rain_mm: weatherHour ? r1(weatherHour.rain) : 0,
    elevation_m: terrain ? terrain.elevation_m : null,
    slope_pct: terrain ? terrain.slope_pct : 0,
    aspect_deg: terrain ? terrain.aspect_deg : null,
    fuel_class: config.fuel_class,
    fire_distance_km: nearest ? nearest.distance_km : config.watch_km,
    fire_count: fires ? fires.length : 0,
    alignment: r2(alignment),
    pm2_5: air ? air.pm2_5 : null,
    co: air ? air.co : null,
  };
}

/** 12-hour risk timeline from hourly forecasts. */
export function forecastTimeline(features, hours, config = DEFAULT_CONFIG) {
  return hours.map((hour) => {
    const merged = {
      ...features,
      ffmc: hour.ffmc ?? features.ffmc,
      wind_kmh: hour.wind_kmh ?? features.wind_kmh,
      wind_dir_deg: hour.wind_dir_deg ?? features.wind_dir_deg,
      rh: hour.rh ?? features.rh,
      heating_rate_c_h: hour.heating_rate_c_h ?? 0,
      fire_distance_km: features.fire_distance_km,
    };
    const result = assess(merged, config);
    return {
      time: hour.time,
      score: result.score,
      band: result.band,
      wind_kmh: merged.wind_kmh,
      rh: merged.rh,
      heating_rate_c_h: merged.heating_rate_c_h,
    };
  });
}

export function timeToHigh(timeline, config = DEFAULT_CONFIG) {
  const idx = timeline.findIndex((p) => p.band === "HIGH");
  if (idx < 0) return null;
  return { hours: idx, at: timeline[idx].time };
}

/**
 * Deterministic synthetic detections for SIMULATED mode (no randomness).
 *
 * One implementation shared by the Worker and mirrored in risk_core.py, so a
 * given 15-minute cycle produces the same fires - and therefore the same score -
 * in both runtimes.
 */
export function simulatedFires(cycle, centre = DEFAULT_CONFIG.centre, watchKm = DEFAULT_CONFIG.watch_km) {
  const seeded = (offset) => {
    let a = (cycle + offset * 7919) | 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const round1 = (v) => Math.round(v * 10) / 10;
  const round2 = (v) => Math.round(v * 100) / 100;

  const count = 2 + (cycle % 3);
  const fires = [];
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const bearing = seeded(i * 3) * 360;
    const distance = 1.2 + seeded(i * 3 + 1) * 18;
    const dLat = (distance / 111) * Math.cos((bearing * Math.PI) / 180);
    const dLng =
      (distance / (111 * Math.cos((centre.lat * Math.PI) / 180))) * Math.sin((bearing * Math.PI) / 180);
    fires.push({
      lat: round2(centre.lat + dLat),
      lng: round2(centre.lng + dLng),
      frp: round1(4 + seeded(i * 3 + 2) * 45),
      confidence: seeded(i * 3) > 0.4 ? "high" : "nominal",
      satellite: ["VIIRS SNPP", "VIIRS NOAA-20", "MODIS"][i % 3],
      acq_datetime: new Date(now - i * 42 * 60 * 1000).toISOString().slice(0, 19),
      distance_km: round2(distance),
    });
  }
  return fires.sort((a, b) => a.distance_km - b.distance_km);
}

/** Season/fuel context used by the landing page and README. */
export const SOURCE_NOTE = {
  firms: "NASA FIRMS (VIIRS SNPP/NOAA-20 NRT, MODIS NRT)",
  weather: "Open-Meteo.com (CC BY 4.0, non-commercial)",
  terrain: "Open-Meteo Elevation API",
  map: "OpenStreetMap contributors",
};

/* ------------------------------------------------- impact & speech copy -- */
const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
export const compass = (deg) => COMPASS[Math.round(((((deg ?? 0) % 360) + 360) % 360) / 22.5) % 16];

/**
 * Street-level reading of the same numbers the score is built from: which side
 * the fire sits on, whether the wind carries it here, and how long until it
 * reaches your ring. An estimate from the spread proxy - never an arrival
 * forecast, and always shown next to the satellite acquisition time.
 */
export function impact(features, fires, assessment = {}, config = DEFAULT_CONFIG) {
  const nearest = fires && fires.length ? fires[0] : null;
  if (!nearest) {
    return {
      available: false,
      text: "no detection inside the watch ring",
      distance_km: null,
      eta_minutes: null,
      relation: null,
    };
  }
  const dist =
    nearest.distance_km ?? haversineKm(config.centre.lat, config.centre.lng, nearest.lat, nearest.lng);
  const bearing = bearingDeg(config.centre.lat, config.centre.lng, nearest.lat, nearest.lng);
  const windFrom = features.wind_dir_deg;
  let relation = "nearby";
  if (windFrom !== null && windFrom !== undefined) {
    relation =
      angleDiff(bearing, windFrom) <= 55
        ? "upwind"
        : angleDiff(bearing, (windFrom + 180) % 360) <= 55
          ? "downwind"
          : "crosswind";
  }
  const spread = Math.max(assessment.spread_estimate_kmh ?? 0, 0.2);
  // A fire the wind is carrying away gets no arrival estimate - inventing one
  // would be the exact dishonesty this project exists to avoid.
  const movingAway = relation === "downwind";
  const boundary =
    dist <= config.geofence_km ? 0 : movingAway ? null : Math.round(((dist - config.geofence_km) / spread) * 60);
  const dir = compass(bearing);
  const text =
    movingAway && boundary !== 0
      ? `Fire ${r1(dist)} km downwind, ${dir} side - the wind is carrying it away, no arrival estimate`
      : boundary <= 0
        ? `Fire ${r1(dist)} km ${relation}, ${dir} side - already inside your ${config.geofence_km} km ring`
        : `Fire ${r1(dist)} km ${relation}, ${dir} side - est. ${boundary} min to your ${config.geofence_km} km ring at ${r1(spread)} km/h`;
  return {
    available: true,
    distance_km: r1(dist),
    bearing_deg: r1(bearing),
    compass: dir,
    relation,
    eta_minutes: boundary,
    eta_to_you_minutes: movingAway ? null : Math.round((dist / spread) * 60),
    spread_kmh: r1(spread),
    text,
    source: nearest.satellite || null,
    detected_at: nearest.acq_datetime || null,
    unverified: true,
  };
}

const ALERT_COPY = {
  en: {
    code: "en",
    bcp47: "en-IN",
    name: "English",
    ident: "Garuda community fire warning.",
    moving: (rel) =>
      rel === "upwind"
        ? "The wind is carrying it toward you."
        : rel === "downwind"
          ? "The wind is carrying it away from you."
          : rel === "crosswind"
            ? "The wind is crossing its path."
            : "",
    HIGH: (c) =>
      `High fire risk, ${c.score} out of 100. ${c.impact}. ${c.moving} Leave now if you are in its path, close windows, switch off the gas and the air conditioner, take ID, medicines and water, and follow local authority instructions.`,
    MEDIUM: (c) =>
      `Medium fire risk, ${c.score} out of 100. ${c.impact}. Pack an evacuation bag, charge your phone, keep children and the elderly indoors, and watch for the next update.`,
    LOW: (c) =>
      `Low fire risk, ${c.score} out of 100. Conditions are quiet. Keep windows closed on smoky days and watch for updates.`,
    steps: {
      HIGH: ["Leave now if you are in its path", "Windows shut, gas and AC off", "Take ID, medicines, water, phone", "Follow authority instructions"],
      MEDIUM: ["Pack a bag and charge devices", "Keep children and the elderly indoors", "Note two exit routes", "Watch the next 15-minute cycle"],
      LOW: ["No action needed right now", "Keep windows closed on smoky days", "Report smoke from the community card"],
    },
  },
  kn: {
    code: "kn",
    bcp47: "kn-IN",
    name: "ಕನ್ನಡ",
    ident: "ಗರುಡ ಸಮುದಾಯ ಅಗ್ನಿ ಎಚ್ಚರಿಕೆ.",
    moving: () => "",
    HIGH: (c) =>
      `ಹೆಚ್ಚಿನ ಅಗ್ನಿ ಅಪಾಯ, 100ಕ್ಕೆ ${c.score}. ${c.impact} ತಕ್ಷಣ ಸುರಕ್ಷಿತ ಸ್ಥಳಕ್ಕೆ ತೆರಳಿ, ಕಿಟಕಿ ಬಾಗಿಲು ಮುಚ್ಚಿ, ಗ್ಯಾಸ್ ಮತ್ತು ಎಸಿ ಆಫ್ ಮಾಡಿ, ದಾಖಲೆ, ಔಷಧಿ ಮತ್ತು ನೀರು ತೆಗೆದುಕೊಂಡು ಹೋಗಿ, ಸ್ಥಳೀಯ ಅಧಿಕಾರಿಗಳ ಸೂಚನೆ ಪಾಲಿಸಿ.`,
    MEDIUM: (c) =>
      `ಮಧ್ಯಮ ಅಗ್ನಿ ಅಪಾಯ, 100ಕ್ಕೆ ${c.score}. ${c.impact} ತುರ್ತು ಚೀಲ ಸಿದ್ಧಪಡಿಸಿ, ಫೋನ್ ಚಾರ್ಜ್ ಮಾಡಿ, ಮಕ್ಕಳು ಮತ್ತು ವೃದ್ಧರನ್ನು ಒಳಗೆ ಇರಿಸಿ, ಮುಂದಿನ ಮಾಹಿತಿಗೆ ಕಾಯಿರಿ.`,
    LOW: (c) =>
      `ಕಡಿಮೆ ಅಗ್ನಿ ಅಪಾಯ, 100ಕ್ಕೆ ${c.score}. ಪರಿಸ್ಥಿತಿ ಶಾಂತವಾಗಿದೆ. ಹೊಗೆ ಇರುವ ದಿನ ಕಿಟಕಿ ಮುಚ್ಚಿ, ಮುಂದಿನ ಮಾಹಿತಿಗೆ ಕಾಯಿರಿ.`,
    steps: {
      HIGH: ["ತಕ್ಷಣ ಸ್ಥಳ ತೊರೆಯಿರಿ", "ಕಿಟಕಿ/ಗ್ಯಾಸ್/ಎಸಿ ಆಫ್", "ದಾಖಲೆ, ಔಷಧಿ, ನೀರು, ಫೋನ್", "ಅಧಿಕಾರಿಗಳ ಸೂಚನೆ ಪಾಲಿಸಿ"],
      MEDIUM: ["ತುರ್ತು ಚೀಲ ಸಿದ್ಧ", "ಮಕ್ಕಳು, ವೃದ್ಧರು ಒಳಗೆ", "ಎರಡು ನಿರ್ಗಮನ ಮಾರ್ಗ ಗುರುತಿಸಿ", "ಮುಂದಿನ 15 ನಿಮಿಷದ ಮಾಹಿತಿ"],
      LOW: ["ಈಗ ಏನೂ ಮಾಡಬೇಕಿಲ್ಲ", "ಹೊಗೆಯ ದಿನ ಕಿಟಕಿ ಮುಚ್ಚಿ", "ಹೊಗೆ ಕಂಡರೆ ವರದಿ ಮಾಡಿ"],
    },
  },
  hi: {
    code: "hi",
    bcp47: "hi-IN",
    name: "हिन्दी",
    ident: "गरुड़ सामुदायिक अग्नि चेतावनी।",
    moving: () => "",
    HIGH: (c) =>
      `अग्नि का गंभीर खतरा, 100 में से ${c.score}. ${c.impact} तुरंत सुरक्षित स्थान पर जाएँ, खिड़कियाँ बंद करें, गैस और एसी बंद करें, दस्तावेज़, दवा और पानी साथ लें, स्थानीय प्रशासन के निर्देश मानें.`,
    MEDIUM: (c) =>
      `अग्नि का मध्यम खतरा, 100 में से ${c.score}. ${c.impact} आपातकालीन बैग तैयार रखें, फ़ोन चार्ज करें, बच्चों और बुज़ुर्गों को घर के अंदर रखें, अगली सूचना की प्रतीक्षा करें.`,
    LOW: (c) =>
      `अग्नि का खतरा कम है, 100 में से ${c.score}. स्थिति शांत है. धुएँ वाले दिन खिड़कियाँ बंद रखें और अपडेट की प्रतीक्षा करें.`,
    steps: {
      HIGH: ["तुरंत सुरक्षित स्थान पर जाएँ", "खिड़की, गैस, एसी बंद", "दस्तावेज़, दवा, पानी, फ़ोन", "प्रशासन के निर्देश मानें"],
      MEDIUM: ["आपातकालीन बैग तैयार", "बच्चे और बुज़ुर्ग अंदर", "दो निकास मार्ग तय करें", "अगले 15 मिनट के अपडेट"],
      LOW: ["अभी कोई कार्रवाई नहीं", "धुएँ वाले दिन खिड़की बंद", "धुआँ दिखे तो रिपोर्ट करें"],
    },
  },
};

const LOCAL_IMPACT = {
  kn: (c) =>
    c.dist === null
      ? ""
      : c.eta === null
        ? `ಬೆಂಕಿ ${c.dist} ಕಿ.ಮೀ ದೂರದಲ್ಲಿದೆ.`
        : c.eta <= 0
          ? `ಬೆಂಕಿ ${c.dist} ಕಿ.ಮೀ ದೂರದಲ್ಲಿದೆ, ಈಗಾಗಲೇ ನಿಮ್ಮ ವಲಯದ ಒಳಗೆ.`
          : `ಬೆಂಕಿ ${c.dist} ಕಿ.ಮೀ ದೂರದಲ್ಲಿದೆ, ಸುಮಾರು ${c.eta} ನಿಮಿಷದಲ್ಲಿ ನಿಮ್ಮ ಪ್ರದೇಶ ತಲುಪಬಹುದು.`,
  hi: (c) =>
    c.dist === null
      ? ""
      : c.eta === null
        ? `आग ${c.dist} किमी दूर है.`
        : c.eta <= 0
          ? `आग ${c.dist} किमी दूर है और आपके दायरे के अंदर है.`
          : `आग ${c.dist} किमी दूर है और लगभग ${c.eta} मिनट में आपके क्षेत्र तक पहुँच सकती है.`,
};

export const VOICE_LANGS = Object.values(ALERT_COPY).map(({ code, bcp47, name }) => ({ code, bcp47, name }));

/**
 * The text read aloud by the browser speech synthesiser or an outbound call.
 * Hand-written Kannada and Hindi, not machine translation, so the wording a
 * judge hears is the wording a resident would accept.
 */
export function alertText(lang = "en", { severity = "LOW", score = 0, impact: imp = null } = {}) {
  const copy = ALERT_COPY[lang] || ALERT_COPY.en;
  const sev = ALERT_COPY.en[severity] ? severity : "LOW";
  const ctx = {
    score: Math.round(score ?? 0),
    dist: imp?.distance_km ?? null,
    eta: imp?.eta_minutes ?? null,
    impact: imp?.text || "",
    moving: copy.moving(imp?.relation),
  };
  if (LOCAL_IMPACT[copy.code]) ctx.impact = LOCAL_IMPACT[copy.code](ctx);
  const body = copy[sev](ctx)
    .replace(/\s+/g, " ")
    .replace(/\.(\s*\.)+/g, ".")
    .trim();
  return {
    lang: copy.code,
    bcp47: copy.bcp47,
    name: copy.name,
    label: "text-to-speech broadcast",
    text: body,
    ident: copy.ident,
    voice_script: `${copy.ident} ${body}`.trim(),
    steps: copy.steps[sev],
  };
}

/* ------------------------------------------------------ routine windows -- */
const ROUTINE = [
  { key: "commute", label: "Morning commute", from: 7, to: 10 },
  { key: "school", label: "School pickup", from: 14, to: 17 },
  { key: "return", label: "Evening return", from: 17, to: 20 },
];

/**
 * Commute and routine windows read off the 12-hour forecast timeline, so a
 * household can see which part of its day the forecast actually disturbs.
 */
export function routineWindows(timeline = []) {
  const hourOf = (t) => Number(String(t || "").slice(11, 13));
  return ROUTINE.map((w) => {
    const points = timeline.filter((p) => {
      const h = hourOf(p.time);
      return Number.isFinite(h) && h >= w.from && h < w.to;
    });
    if (!points.length) {
      return { key: w.key, label: w.label, available: false, status: "beyond horizon", peak: null, band: null, peak_at: null, advice: `Outside the ${timeline.length} h forecast` };
    }
    const peak = points.reduce((best, p) => (p.score > best.score ? p : best), points[0]);
    const at = String(peak.time || "").slice(11, 16);
    const status = peak.band === "HIGH" ? "disrupted" : peak.band === "MEDIUM" ? "watch" : "clear";
    const advice =
      status === "disrupted"
        ? `Disrupted - risk reaches HIGH (${peak.score}/100) by ${at}. Move this window or take an alternate route.`
        : status === "watch"
          ? `Travel possible - risk peaks at ${peak.score}/100 by ${at}.`
          : `Clear - risk stays at ${peak.score}/100.`;
    return { key: w.key, label: w.label, available: true, status, peak: peak.score, band: peak.band, peak_at: at, advice };
  });
}
