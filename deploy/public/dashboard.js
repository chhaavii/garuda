/**
 * Dashboard: Cesium threat map + panels driven by /status, /fires.geojson,
 * /weather.json, /config.json, /history and /backtest.
 */
const $ = (id) => document.getElementById(id);
const STATUS_MS = 60000;
const FIRES_MS = 15 * 60 * 1000;

let cfg = null;
let viewer = null;
let firesSource = null;
let statusData = null;
let countdown = null;
let lastLogLine = null;
let mapHome = null;
let flashTimer = null;

/* --------------------------------------------------------------- boot ---- */
init();

async function init() {
  cfg = await fetch("/config.json").then((r) => r.json()).catch(() => null);
  if (cfg?.cesium_ion_token) Cesium.Ion.defaultAccessToken = cfg.cesium_ion_token;
  initMap();
  initVoice();
  wireActions();
  await refreshStatus();
  await refreshFires();
  await refreshHistory();
  await renderBacktest();
  await loadReports();
  await loadCheckins();
  flushOutbox();
  setInterval(refreshStatus, STATUS_MS);
  setInterval(refreshFires, FIRES_MS);
  setInterval(() => {
    loadReports();
    loadCheckins();
  }, STATUS_MS);
  setInterval(tick, 1000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshStatus();
  });
}

/* ---------------------------------------------------------------- map ---- */
function initMap() {
  if (typeof Cesium === "undefined") {
    $("cesium").innerHTML = '<p class="tiny muted" style="padding:16px">Cesium failed to load.</p>';
    return;
  }
  const lat = cfg?.centre?.lat ?? 12.9716;
  const lng = cfg?.centre?.lng ?? 77.5946;

  viewer = new Cesium.Viewer("cesium", {
    terrainProvider: cfg?.cesium_ion_token ? Cesium.createWorldTerrain() : new Cesium.EllipsoidTerrainProvider(),
    baseLayer: cfg?.cesium_ion_token
      ? undefined
      : new Cesium.ImageryLayer(new Cesium.OpenStreetMapImageryProvider({ url: "https://tile.openstreetmap.org/" })),
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    animation: false,
    timeline: false,
    shouldAnimate: true,
  });
  viewer.scene.globe.depthTestAgainstEarth = true;

  const centre = Cesium.Cartesian3.fromDegrees(lng, lat, 20);
  mapHome = new Cesium.BoundingSphere(centre, Math.max(2000, (cfg?.geofence_km ?? 5) * 1000 * 2.6));
  flyHome(0);

  viewer.entities.add({
    position: Cesium.Cartesian3.fromDegrees(lng, lat),
    ellipse: {
      semiMajorAxis: (cfg?.geofence_km ?? 5) * 1000,
      semiMinorAxis: (cfg?.geofence_km ?? 5) * 1000,
      material: Cesium.Color.fromCssColorString("#ff6b2b").withAlpha(0.15),
      outline: true,
      outlineColor: Cesium.Color.fromCssColorString("#ff6b2b"),
      outlineWidth: 2,
      height: 20,
    },
  });
  viewer.entities.add({
    position: Cesium.Cartesian3.fromDegrees(lng, lat),
    ellipse: {
      semiMajorAxis: (cfg?.watch_km ?? 25) * 1000,
      semiMinorAxis: (cfg?.watch_km ?? 25) * 1000,
      fill: false,
      outline: true,
      outlineColor: Cesium.Color.fromCssColorString("#e8c547").withAlpha(0.45),
      outlineWidth: 1,
      height: 20,
    },
  });

  viewer.screenSpaceEventHandler.setInputAction((click) => {
    const picked = viewer.scene.pick(click.position);
    if (picked?.id?.properties?.frp) showFireInfo(picked.id);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}

function flyHome(duration = 2) {
  if (!viewer || !mapHome) return;
  viewer.camera.flyToBoundingSphere(mapHome, {
    duration,
    offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-52), mapHome.radius * 3.2),
  });
}

async function drawWedge() {
  if (!viewer) return;
  try {
    const weather = await fetch("/weather.json").then((r) => r.json());
    if (weather.wind_dir_deg === null) return;
    const windTo = (weather.wind_dir_deg + 180) % 360;
    const lat = cfg.centre.lat;
    const lng = cfg.centre.lng;
    const radius = (cfg.watch_km ?? 25) * 1000;
    const pts = [lng, lat, 30];
    for (let a = -30; a <= 30; a += 5) {
      const bearing = Cesium.Math.toRadians(windTo + a);
      const dLat = (radius / 111000) * Math.cos(bearing);
      const dLng = (radius / (111000 * Math.cos(Cesium.Math.toRadians(lat)))) * Math.sin(bearing);
      pts.push(lng + dLng, lat + dLat, 30);
    }
    viewer.entities.add({
      polygon: {
        hierarchy: Cesium.Cartesian3.fromDegreesArrayHeights(pts),
        material: Cesium.Color.fromCssColorString("#ff9a3c").withAlpha(0.13),
        height: 30,
      },
    });
  } catch (err) {
    /* wedge is optional */
  }
}

async function refreshFires() {
  if (!viewer) return;
  try {
    const geo = await fetch("/fires.geojson", { cache: "no-store" }).then((r) => r.json());
    if (firesSource) viewer.dataSources.remove(firesSource, true);
    firesSource = new Cesium.GeoJsonDataSource("fires");
    await firesSource.load(geo, {
      clampToGround: false,
      markerSize: 0,
      markerColor: Cesium.Color.fromCssColorString("#ff4438"),
      markerSymbol: "",
    });

    const now = Cesium.JulianDate.now();
    const entities = firesSource.entities.values;
    entities.forEach((entity, i) => {
      const p = entity.properties;
      const frp = p.frp?.getValue() ?? 0;
      const acquired = p.acq_datetime?.getValue();
      const start = acquired ? Cesium.JulianDate.fromIso8601(acquired) : now;
      const stop = Cesium.JulianDate.addHours(start, 24, new Cesium.JulianDate());
      entity.availability = new Cesium.TimeInterval({ start, stop });
      const size = Math.min(22, 8 + frp / 4);
      entity.point = new Cesium.PointGraphics({
        pixelSize: size,
        color: Cesium.Color.fromCssColorString("#ff4438").withAlpha(0.92),
        outlineColor: Cesium.Color.fromCssColorString("#ffd2ae"),
        outlineWidth: 1,
        heightReference: Cesium.HeightReference.NONE,
      });
      if (i < 3) {
        // pulse the newest few detections for 5 s
        const born = performance.now();
        entity.point.pixelSize = new Cesium.CallbackProperty(() => {
          const age = (performance.now() - born) / 1000;
          if (age > 5) return size;
          return size + Math.sin(age * 6) * 4 + 4;
        }, false);
      }
      entity.description = undefined;
    });

    if (!viewer.entities.getById("wedge")) {
      const wedge = viewer.entities.add({ id: "wedge" });
      viewer.entities.remove(wedge);
      drawWedge();
    }

    const meta = geo.meta || {};
    const minutes = Math.round((meta.age_seconds || 0) / 60);
    const badge = (meta.badge || "unknown").toUpperCase();
    $("map-badge").textContent = `${badge} · ${geo.features.length} detections`;
    $("map-badge").className = "source-badge " + (meta.badge || "");
    $("map-updated").textContent = `updated ${minutes} min ago · watch ${meta.watch_km} km`;
  } catch (err) {
    $("map-badge").textContent = "detections unavailable";
  }
}

function showFireInfo(entity) {
  const p = entity.properties;
  const frp = p.frp?.getValue();
  const conf = p.confidence?.getValue();
  const sat = p.satellite?.getValue();
  const acq = p.acq_datetime?.getValue();
  const dist = p.distance_km_from_centre?.getValue();
  const src = p.source?.getValue();
  toast(
    `FRP ${frp} MW · ${conf} confidence · ${sat} · ${acq} · ${dist} km from centre · Source: ${src}`,
    "info",
    9000
  );
}

/* -------------------------------------------------------------- panels --- */
async function refreshStatus() {
  try {
    const resp = await fetch("/status", { cache: "no-store" });
    const s = await resp.json();
    if (!resp.ok || s.error) throw new Error(s.error || "HTTP " + resp.status);
    renderStatus(s);
  } catch (err) {
    $("engine-status").textContent = "disconnected";
    $("live-dot").className = "dot off";
    toast("Engine unreachable: " + err.message, "error");
  }
}

function renderStatus(s) {
  statusData = s;
  $("engine-status").textContent = s.simulated ? "simulated run" : "connected";
  $("live-dot").className = "dot on";
  $("last-updated").textContent = "checked " + s.timestamp;
  document.body.dataset.sev = s.severity;

  const badge = $("severity-badge");
  badge.className = "badge " + s.severity.toLowerCase();
  badge.textContent = s.severity;
  $("risk-score").textContent = Math.round(s.risk_score ?? 0);
  $("risk-meter").style.width = (s.risk_score ?? 0) + "%";
  $("severity-sub").textContent =
    s.severity === "HIGH" ? "evacuate now" : s.severity === "MEDIUM" ? "prepare" : "monitoring";
  $("alert-message").textContent = s.message;

  const drivers = $("drivers");
  drivers.innerHTML = "";
  (s.reasons || []).forEach((reason) => {
    const chip = document.createElement("span");
    chip.className = "driver" + (String(reason).includes("hard override") ? " guard" : "");
    chip.textContent = reason;
    drivers.appendChild(chip);
  });

  if (s.cycle) {
    countdown = s.cycle.seconds_remaining;
    tick();
  }

  $("kpi-risk").textContent = s.risk_score === null ? "—" : Math.round(s.risk_score);
  $("kpi-fires").textContent = s.fires?.length ?? 0;
  $("kpi-fwi").textContent = s.features?.fwi ?? "—";
  $("kpi-tth").textContent = s.time_to_high ? s.time_to_high.hours + " h" : "—";

  renderRules(s);
  renderTimeline(s);
  renderPhysics(s);
  renderAir(s);
  renderSources(s);
  renderChannels(s);
  renderImpact(s);
  renderRoutine(s);
  renderVoice(s);
  renderRaw(s);

  // Auto-speak once per HIGH transition, and only after a real user gesture:
  // browsers refuse to play audio before one.
  if (s.severity === "HIGH" && lastSpokenSeverity !== "HIGH" && voiceArmed) speak(s, "auto");
  lastSpokenSeverity = s.severity;

  if (s.severity === "HIGH" && s.fires?.length) {
    const nearest = s.fires[0];
    viewer?.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(nearest.lng, nearest.lat, 0),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-45), roll: 0 },
      offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-45), 8000),
      duration: 2,
    });
    flashBorder();
  }

  const line = `[${new Date().toLocaleTimeString()}] ${s.severity} · ${Math.round(s.risk_score)}/100 · fires ${s.fires?.length ?? 0}`;
  if (line !== lastLogLine) {
    lastLogLine = line;
    addLog(line, s.severity.toLowerCase());
  }
}

function flashBorder() {
  document.body.classList.add("alert-flash");
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => document.body.classList.remove("alert-flash"), 2400);
}

function renderRules(s) {
  const list = $("fired-rules");
  list.innerHTML = "";
  (s.fired_rules || []).slice(0, 6).forEach((rule) => {
    const li = document.createElement("li");
    li.innerHTML = `<span>${rule.rule}</span><b>${rule.strength.toFixed(2)}</b>`;
    list.appendChild(li);
  });
  if (!s.fired_rules?.length) list.innerHTML = '<li><span>no rule fired</span><b>0.00</b></li>';
  const note = $("override-note");
  note.hidden = !s.override;
  note.textContent = s.override ? `Hard override: ${s.override}` : "";
}

function renderTimeline(s) {
  const svg = $("timeline");
  const timeline = s.timeline || [];
  svg.innerHTML = "";
  if (!timeline.length) return;

  const w = 320;
  const h = 96;
  const pad = 8;
  const threshold = cfg?.thresholds?.high ?? 65;
  const x = (i) => pad + (i / Math.max(1, timeline.length - 1)) * (w - pad * 2);
  const y = (v) => h - pad - (v / 100) * (h - pad * 2);

  const NS = "http://www.w3.org/2000/svg";
  const line = document.createElementNS(NS, "line");
  line.setAttribute("x1", pad);
  line.setAttribute("x2", w - pad);
  line.setAttribute("y1", y(threshold));
  line.setAttribute("y2", y(threshold));
  line.setAttribute("stroke", "#ff4438");
  line.setAttribute("stroke-dasharray", "3 4");
  line.setAttribute("stroke-width", "1");
  svg.appendChild(line);

  const label = document.createElementNS(NS, "text");
  label.setAttribute("x", pad);
  label.setAttribute("y", y(threshold) - 4);
  label.setAttribute("fill", "#ff9a8f");
  label.setAttribute("font-size", "7");
  label.textContent = `HIGH ${threshold}`;
  svg.appendChild(label);

  const points = timeline.map((p, i) => `${x(i)},${y(p.score)}`).join(" ");
  const poly = document.createElementNS(NS, "polyline");
  poly.setAttribute("points", points);
  poly.setAttribute("fill", "none");
  poly.setAttribute("stroke", "#ff9a3c");
  poly.setAttribute("stroke-width", "2");
  svg.appendChild(poly);

  timeline.forEach((p, i) => {
    if (i % 4) return;
    const t = document.createElementNS(NS, "text");
    t.setAttribute("x", x(i));
    t.setAttribute("y", h - 1);
    t.setAttribute("fill", "#6f7d76");
    t.setAttribute("font-size", "6");
    t.setAttribute("text-anchor", "middle");
    t.textContent = (p.time || "").slice(11, 16);
    svg.appendChild(t);
  });

  const chip = $("tth-chip");
  if (s.time_to_high) {
    chip.className = "badge high";
    chip.textContent = `HIGH in ${s.time_to_high.hours} h`;
  } else {
    chip.className = "badge low";
    chip.textContent = "no HIGH in 12 h";
  }
  $("timeline-note").textContent = `model forecast from Open-Meteo hourly · ${timeline.length} h`;
}

function renderPhysics(s) {
  const f = s.features || {};
  const cells = [
    ["FFMC", f.ffmc, "fuel moisture code"],
    ["ISI", f.isi, "initial spread"],
    ["FWI", f.fwi, f.danger_class],
    ["dT/dt", f.heating_rate_c_h, "°C/h, 3 h"],
    ["wind", f.wind_kmh, "km/h"],
    ["wind dir", f.wind_dir_deg, "°"],
    ["RH", f.rh, "%"],
    ["slope", f.slope_pct, "% / " + (f.aspect_deg ?? "—") + "°"],
    ["fuel class", f.fuel_class, "×" + (s.fuel_multiplier ?? 1)],
    ["spread est.", s.spread_estimate_kmh, "km/h (est.)"],
    ["ETA", s.eta_hours, "h to centre"],
    ["FWI spin-up", f.spun_up_days, "days"],
  ];
  $("physics-grid").innerHTML = cells
    .map(
      ([code, value, unit]) =>
        `<div class="physics-cell"><span class="code">${code}</span><span class="value">${
          value === null || value === undefined ? "—" : value
        }</span><span class="muted tiny">${unit ?? ""}</span></div>`
    )
    .join("");

  const chips = [
    `${f.temp_c ?? "—"} °C`,
    `${f.gust_kmh ?? "—"} km/h gusts`,
    `${f.rh ?? "—"}% RH`,
    `${f.vpd_kpa ?? "—"} kPa VPD`,
    `${f.rain_mm ?? 0} mm rain`,
    `${f.elevation_m ?? "—"} m`,
    `${f.soil_moisture ?? "—"} m³/m³ soil`,
    s.upslope ? "wind blowing upslope" : "not upslope",
  ];
  $("weather-chips").innerHTML = chips.map((c) => `<span class="chip">${c}</span>`).join("");
}

function renderAir(s) {
  const air = s.air || {};
  const cells = [
    ["PM2.5", air.pm2_5, "µg/m³"],
    ["CO", air.co, "µg/m³"],
    ["O₂", air.o2_percent, air.o2_note || "no sensor"],
    ["baseline O₂", air.baseline_percent, "% outdoor"],
  ];
  $("air-grid").innerHTML = cells
    .map(
      ([code, value, unit]) =>
        `<div class="physics-cell"><span class="code">${code}</span><span class="value">${
          value === null || value === undefined ? "—" : value
        }</span><span class="muted tiny">${unit ?? ""}</span></div>`
    )
    .join("");
  const chip = $("smoke-chip");
  chip.className = air.smoke ? "chip" : "chip muted";
  chip.textContent = air.smoke ? "smoke indicator high" : "no smoke flag";
}

function renderSources(s) {
  const src = s.sources || {};
  const rows = Object.entries(src).filter(([k]) => k !== "elevation_api");
  $("source-badges").innerHTML = rows
    .map(([name, state]) => `<span class="source-badge ${state}">${name}: ${state}</span>`)
    .join("");
}

function renderChannels(s) {
  const configured = cfg?.channels_configured;
  const rows = [
    ["Discord webhook", configured ? "configured" : "no secret"],
    ["Infobip SMS", configured ? "configured" : "no secret"],
    ["SendGrid email", configured ? "configured" : "no secret"],
    ["Pi LED / GPIO", "local engine only"],
  ];
  $("channels").innerHTML = rows
    .map(
      ([name, state]) =>
        `<li><span class="name"><i class="pip ${state === "configured" ? "sent" : "pending"}"></i>${name}</span><span class="state">${state}</span></li>`
    )
    .join("");
  $("channels-note").textContent = s.simulated ? "this run was simulated" : "";
}

function renderRaw(s) {
  $("raw").textContent = JSON.stringify(s, null, 2);
}

async function refreshHistory() {
  try {
    const data = await fetch("/history", { cache: "no-store" }).then((r) => r.json());
    const host = $("history-bars");
    host.innerHTML = "";
    (data.cycles || []).forEach((cycle) => {
      const bar = document.createElement("div");
      bar.className = "bar " + String(cycle.severity).toLowerCase();
      bar.title = `${cycle.timestamp} · ${cycle.severity} · ${cycle.risk_score ?? "—"}/100`;
      host.appendChild(bar);
    });
  } catch (err) {
    /* history is best-effort */
  }
}

async function renderBacktest() {
  try {
    const resp = await fetch("/backtest", { cache: "no-store" });
    if (!resp.ok) throw new Error((await resp.json()).reason || "unavailable");
    const data = await resp.json();
    $("bt-grid").innerHTML = [
      ["hit rate", data.hit_rate === null ? "—" : (data.hit_rate * 100).toFixed(1) + "%"],
      ["false alarms", data.false_alarm_rate === null ? "—" : (data.false_alarm_rate * 100).toFixed(1) + "%"],
      ["median risk, fire days", data.median_risk_fire_days ?? "—"],
      ["median risk, quiet days", data.median_risk_quiet_days ?? "—"],
      ["sample", (data.sample_days ?? "—") + " days"],
      ["window", data.date_range ?? "—"],
    ]
      .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`)
      .join("");
    $("bt-note").textContent = `generated ${data.generated_at ?? "—"} · thresholds from percentiles`;
  } catch (err) {
    $("bt-grid").innerHTML = `<div class="wide"><dt>status</dt><dd>not computed</dd></div>`;
    $("bt-note").textContent = err.message;
  }
}

/* --------------------------------------------------------------- misc ---- */
function wireActions() {
  $("refresh-btn").addEventListener("click", () => {
    refreshStatus();
    refreshFires();
    toast("Refreshed", "info");
  });
  $("simulate-btn").addEventListener("click", simulate);
  $("raw-toggle").addEventListener("click", () => {
    const raw = $("raw");
    raw.hidden = !raw.hidden;
    $("raw-toggle").textContent = raw.hidden ? "show raw status" : "hide raw status";
  });
  $("map-home").addEventListener("click", () => flyHome(2));
  $("map-replay").addEventListener("click", replay);
  $("map-search").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const parts = event.target.value.split(",").map(Number);
    if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) {
      toast("Enter coordinates as lat, lng", "error");
      return;
    }
    viewer?.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(parts[1], parts[0], 2500),
      duration: 2,
    });
  });

  const search = $("map-search");

  function replay() {
    if (!viewer || !firesSource || !firesSource.entities.values.length) {
      toast("No detections to replay", "info");
      return;
    }
    const times = firesSource.entities.values
      .map((e) => e.properties?.acq_datetime?.getValue())
      .filter(Boolean)
      .map((iso) => Cesium.JulianDate.fromIso8601(iso))
      .sort(Cesium.JulianDate.compare);
    const start = Cesium.JulianDate.addHours(times[0], -1, new Cesium.JulianDate());
    const stop = Cesium.JulianDate.addHours(times[times.length - 1], 1, new Cesium.JulianDate());
    viewer.clock.startTime = start.clone();
    viewer.clock.stopTime = stop.clone();
    viewer.clock.currentTime = start.clone();
    viewer.clock.clockRange = Cesium.ClockRange.LOOP_STOP;
    viewer.clock.multiplier = 900;
    viewer.timeline.zoomTo(start, stop);
    toast("Replaying last 24 h of detections", "info");
  }

  search?.addEventListener("blur", () => {
    /* no-op, keeps focus states predictable */
  });
}

async function simulate() {
  const btn = $("simulate-btn");
  btn.disabled = true;
  btn.textContent = "Running…";
  try {
    const resp = await fetch("/simulate?severity=high", { method: "POST" });
    const data = await resp.json();
    if (data.status) renderStatus(data.status);
    toast("Simulated HIGH run (badged SIMULATED)", "info");
  } catch (err) {
    toast("Simulation failed: " + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "⚡ Simulate high alert";
  }
}

function tick() {
  if (countdown === null) return;
  countdown = Math.max(0, countdown - 1);
  const m = String(Math.floor(countdown / 60)).padStart(2, "0");
  const s = String(countdown % 60).padStart(2, "0");
  $("cycle-countdown").textContent = `${m}:${s}`;
  const total = (statusData?.cycle?.minutes ?? 15) * 60;
  $("cycle-progress").style.width = `${((total - countdown) / total) * 100}%`;
  if (countdown === 0) refreshStatus();
}

function addLog(text, sevClass) {
  const log = $("engine-log");
  if (!log) return;
  const row = document.createElement("div");
  row.className = "log-row";
  const parts = text.split("] ");
  row.innerHTML = `<span class="t">${parts.shift()}]</span><span class="sev ${sevClass}">${parts.join(" ")}</span>`;
  log.prepend(row);
  while (log.children.length > 30) log.lastElementChild.remove();
}

function toast(message, kind, ms = 4200) {
  const host = $("toast-host");
  const el = document.createElement("div");
  el.className = "toast " + (kind || "");
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/* ------------------------------------------- voice broadcast (Tier 1) ---- */
const OUTBOX_KEY = "garuda.outbox";
let lang = localStorage.getItem("garuda.lang") || "en";
let voiceArmed = false;
let lastSpokenSeverity = null;
let reportEntities = [];

function initVoice() {
  const langs = cfg?.voice_languages || [
    { code: "en", bcp47: "en-IN", name: "English" },
    { code: "kn", bcp47: "kn-IN", name: "ಕನ್ನಡ" },
    { code: "hi", bcp47: "hi-IN", name: "हिन्दी" },
  ];
  const select = $("speak-lang");
  select.innerHTML = langs.map((l) => `<option value="${l.code}">${l.name}</option>`).join("");
  select.value = langs.some((l) => l.code === lang) ? lang : "en";
  lang = select.value;

  select.addEventListener("change", () => {
    lang = select.value;
    localStorage.setItem("garuda.lang", lang);
    if (statusData) {
      renderImpact(statusData);
      renderVoice(statusData);
    }
  });

  $("speak-btn").addEventListener("click", () => speak(statusData));
  $("voice-say").addEventListener("click", () => speak(statusData));
  $("copy-btn").addEventListener("click", copyAlert);
  $("voice-call").addEventListener("click", placeCall);
  $("voice-chip").textContent = cfg?.voice_configured ? "Infobip voice ready" : "browser TTS";

  // Audio needs a gesture first. Any pointer/key press arms auto-speak on HIGH.
  document.addEventListener("pointerdown", () => (voiceArmed = true), { once: true });
  document.addEventListener("keydown", () => (voiceArmed = true), { once: true });
}

function pickVoice(bcp47) {
  const voices = window.speechSynthesis?.getVoices?.() || [];
  const prefix = bcp47.split("-")[0].toLowerCase();
  return (
    voices.find((v) => v.lang?.toLowerCase() === bcp47.toLowerCase()) ||
    voices.find((v) => v.lang?.toLowerCase().startsWith(prefix)) ||
    null
  );
}

function speak(status, source = "manual") {
  const copy = status?.alert_text?.[lang] || status?.alert_text?.en;
  if (!copy) {
    toast("No alert text yet", "error");
    return;
  }
  if (!("speechSynthesis" in window)) {
    copyText(copy.voice_script);
    toast("No speech engine here - alert copied instead", "info");
    return;
  }
  const synth = window.speechSynthesis;
  synth.cancel();
  const utter = new SpeechSynthesisUtterance(copy.voice_script);
  utter.lang = copy.bcp47;
  const voice = pickVoice(copy.bcp47);
  if (voice) utter.voice = voice;
  utter.rate = 0.95;
  utter.pitch = 1;
  utter.onerror = () => toast(`${copy.name} voice not installed in this browser`, "error");
  synth.speak(utter);
  $("voice-mode").textContent = `speaking ${copy.name} · text-to-speech broadcast`;
  if (source === "manual") toast(`Reading the ${copy.name} broadcast aloud`, "info");
}

function copyText(text) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(
      () => toast("Copied - works offline, paste into any chat", "info"),
      () => toast("Copy blocked by the browser", "error")
    );
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  document.body.appendChild(area);
  area.select();
  document.execCommand("copy");
  area.remove();
  toast("Copied - works offline, paste into any chat", "info");
}

function copyAlert() {
  const s = statusData;
  const copy = s?.alert_text?.[lang] || s?.alert_text?.en;
  if (!copy) {
    toast("Nothing to copy yet", "error");
    return;
  }
  copyText(
    `GARUDA · ${s.severity} ${Math.round(s.risk_score)}/100 · ${s.timestamp} IST\n${copy.voice_script}\n${
      s.impact?.text ? s.impact.text + "\n" : ""
    }Source: NASA FIRMS + Open-Meteo · garuda`
  );
}

async function placeCall() {
  const btn = $("voice-call");
  btn.disabled = true;
  btn.textContent = "placing…";
  try {
    const data = await fetch(`/voice?lang=${encodeURIComponent(lang)}`, { method: "POST" }).then((r) => r.json());
    $("voice-script").textContent = data.script || "—";
    if (data.mode === "live") {
      $("voice-chip").textContent = "call placed";
      toast("Voice call placed through Infobip", "info");
    } else if (data.mode === "failed") {
      $("voice-chip").textContent = "call failed";
      toast(`Infobip refused the call (${data.upstream_status})`, "error");
    } else {
      $("voice-chip").textContent = "simulated call";
      toast("No Infobip key/number - script shown, no call placed", "info");
    }
    $("voice-note").textContent = data.reason || data.detail || "";
  } catch (err) {
    toast("Voice request failed: " + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "📞 Place call";
  }
}

/* --------------------------------------------- impact, routine, voice ---- */
function renderImpact(s) {
  const copy = s.alert_text?.[lang] || s.alert_text?.en;
  const imp = s.impact;
  $("impact-line").textContent =
    imp && imp.available
      ? `${imp.text}${imp.detected_at ? ` · pass ${imp.detected_at} UTC` : ""}`
      : "no detection inside the watch ring";
  $("alert-steps").innerHTML = (copy?.steps || []).map((step) => `<li>${step}</li>`).join("");
}

function renderRoutine(s) {
  const list = $("routine-list");
  const rows = s.routine || [];
  list.innerHTML = rows
    .map((r) => {
      const cls = r.available ? r.status : "beyond";
      const value = r.available ? `${Math.round(r.peak)}/100 · ${r.peak_at}` : "outside 12 h";
      return `<li class="routine-row ${cls}"><span class="routine-name">${r.label}</span><span class="routine-value mono">${value}</span><span class="routine-advice">${r.advice}</span></li>`;
    })
    .join("");
}

function renderVoice(s) {
  const copy = s.alert_text?.[lang] || s.alert_text?.en;
  if (!copy) return;
  $("voice-script").textContent = copy.voice_script;
  $("voice-mode").textContent = `${copy.name} · text-to-speech broadcast · ${cfg?.voice_configured ? "Infobip voice ready" : "no call key"}`;
}

/* ------------------------------------------- community reports (Waze) ---- */
async function loadReports() {
  try {
    const data = await fetch("/reports", { cache: "no-store" }).then((r) => r.json());
    if (data.error) throw new Error(data.error);
    renderReports(data);
  } catch (err) {
    $("reports-status").textContent = `reports unavailable: ${err.message}`;
  }
}

function renderReports(data) {
  const reports = data.reports || [];
  const chip = $("reports-chip");
  chip.className = reports.length ? "chip" : "chip muted";
  chip.textContent = `${data.count_near ?? 0} near you · ${reports.length} in ${data.window_hours || 3} h`;

  const list = $("reports-list");
  list.innerHTML = reports
    .slice(0, 8)
    .map((r) => {
      const icon = r.kind === "fire" ? "🔥" : r.kind === "embers" ? "✴" : r.kind === "clear" ? "✓" : "💨";
      return `<li class="report-row">
        <span class="report-icon">${icon}</span>
        <span class="report-body">
          <b>${r.kind}</b> · ${r.distance_km} km · ${r.ago_minutes} min ago
          <span class="report-meta mono">${r.note ? r.note + " · " : ""}${r.confirms} confirmed / ${r.denies} gone</span>
        </span>
        <span class="report-votes">
          <button class="btn ghost small" data-confirm="${r.id}">still there</button>
          <button class="btn ghost small" data-deny="${r.id}">gone</button>
        </span>
      </li>`;
    })
    .join("");
  if (!reports.length) list.innerHTML = '<li class="report-row muted tiny">No reports yet in the last 3 h. Be the ground truth.</li>';

  list.querySelectorAll("[data-confirm]").forEach((btn) =>
    btn.addEventListener("click", () => voteReport(btn.dataset.confirm, "confirm"))
  );
  list.querySelectorAll("[data-deny]").forEach((btn) =>
    btn.addEventListener("click", () => voteReport(btn.dataset.deny, "deny"))
  );

  drawReportMarkers(reports);
}

async function voteReport(id, kind) {
  try {
    await fetch(`/reports/${id}/${kind}`, { method: "POST" });
    toast(kind === "confirm" ? "Confirmed - still there" : "Marked as gone", "info");
    loadReports();
  } catch (err) {
    toast("Vote failed: " + err.message, "error");
  }
}

function currentPosition() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    const timer = setTimeout(() => resolve(null), 6000);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: Math.round(pos.coords.accuracy) });
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
      { enableHighAccuracy: true, timeout: 5000, maximumAge: 60000 }
    );
  });
}

async function sendReport(kind) {
  const pos = (await currentPosition()) || { lat: cfg?.centre?.lat ?? 12.9716, lng: cfg?.centre?.lng ?? 77.5946 };
  $("reports-status").textContent = pos.accuracy
    ? `location: GPS ±${pos.accuracy} m`
    : "location: area centre (GPS declined or unavailable)";
  const payload = { lat: pos.lat, lng: pos.lng, kind, client: clientId() };
  try {
    const resp = await fetch("/reports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    toast(`${kind} reported ${data.distance_km} km from centre - unverified, thank you`, "info");
    loadReports();
  } catch (err) {
    queueOutbox({ url: "/reports", payload });
    toast("Offline - report queued and will send when the signal returns", "error");
  }
}

function clientId() {
  let id = localStorage.getItem("garuda.client");
  if (!id) {
    id = "c-" + Math.random().toString(36).slice(2, 10);
    localStorage.setItem("garuda.client", id);
  }
  return id;
}

function drawReportMarkers(reports) {
  if (!viewer) return;
  for (const entity of reportEntities) viewer.entities.remove(entity);
  reportEntities = [];
  for (const r of reports.slice(0, 40)) {
    const color =
      r.kind === "fire" ? "#ff4438" : r.kind === "clear" ? "#8fd18f" : r.kind === "embers" ? "#ff9a3c" : "#e8c547";
    reportEntities.push(
      viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(r.lng, r.lat, 30),
        point: {
          pixelSize: 9,
          color: Cesium.Color.fromCssColorString(color).withAlpha(0.95),
          outlineColor: Cesium.Color.WHITE.withAlpha(0.85),
          outlineWidth: 2,
        },
        label: {
          text: `${r.kind} · ${r.ago_minutes}m`,
          font: "10px monospace",
          fillColor: Cesium.Color.fromCssColorString(color),
          pixelOffset: new Cesium.Cartesian2(0, -18),
          showBackground: true,
          backgroundColor: Cesium.Color.fromCssColorString("#080d0b").withAlpha(0.75),
        },
      })
    );
  }
}

/* ------------------------------------------------ family check-in -------- */
async function loadCheckins() {
  try {
    const data = await fetch("/checkin", { cache: "no-store" }).then((r) => r.json());
    if (data.error) throw new Error(data.error);
    const chip = $("checkin-summary");
    chip.textContent = `${data.safe ?? 0} safe · ${data.help ?? 0} help`;
    chip.className = data.help ? "chip" : "chip muted";
    const list = $("checkins-list");
    list.innerHTML = (data.checkins || [])
      .slice(0, 8)
      .map(
        (c) =>
          `<li class="report-row"><span class="report-icon">${c.status === "help" ? "🆘" : "✅"}</span><span class="report-body"><b>${
            c.name
          }</b> · ${c.status === "help" ? "needs help" : "safe"}<span class="report-meta mono">${c.ago_minutes} min ago</span></span></li>`
      )
      .join("");
    if (!(data.checkins || []).length) list.innerHTML = '<li class="report-row muted tiny">No check-ins in the last 12 h.</li>';
  } catch (err) {
    $("checkin-summary").textContent = "check-in unavailable";
  }
}

async function postCheckin(status) {
  const name = $("checkin-name").value.trim();
  if (!name) {
    toast("Add a name so the list means something", "error");
    $("checkin-name").focus();
    return;
  }
  const payload = { name, status };
  try {
    const resp = await fetch("/checkin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    $("checkin-name").value = "";
    toast(status === "help" ? "Marked as needing help" : "Marked safe", "info");
    loadCheckins();
  } catch (err) {
    queueOutbox({ url: "/checkin", payload });
    toast("Offline - check-in queued", "error");
  }
}

/* ------------------------------------------------------ offline outbox --- */
function queueOutbox(item) {
  const queue = JSON.parse(localStorage.getItem(OUTBOX_KEY) || "[]");
  queue.push({ ...item, at: Date.now() });
  localStorage.setItem(OUTBOX_KEY, JSON.stringify(queue.slice(-40)));
  updateOutboxNote();
}

function updateOutboxNote() {
  const queue = JSON.parse(localStorage.getItem(OUTBOX_KEY) || "[]");
  const note = $("reports-status");
  if (!queue.length) return;
  note.textContent = note.textContent.replace(/ · \d+ queued.*$/, "") + ` · ${queue.length} queued offline`;
}

async function flushOutbox() {
  const queue = JSON.parse(localStorage.getItem(OUTBOX_KEY) || "[]");
  if (!queue.length) return;
  const left = [];
  for (const item of queue) {
    try {
      const resp = await fetch(item.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(item.payload),
      });
      if (!resp.ok) left.push(item);
    } catch (err) {
      left.push(item);
    }
  }
  localStorage.setItem(OUTBOX_KEY, JSON.stringify(left));
  if (queue.length !== left.length) {
    toast(`Sent ${queue.length - left.length} queued item${queue.length - left.length > 1 ? "s" : ""}`, "info");
    loadReports();
    loadCheckins();
  }
  updateOutboxNote();
}

window.addEventListener("online", flushOutbox);

/* ------------------------------------------------------ report wiring ---- */
$("report-smoke").addEventListener("click", () => sendReport("smoke"));
$("report-fire").addEventListener("click", () => sendReport("fire"));
$("report-clear").addEventListener("click", () => sendReport("clear"));
$("checkin-safe").addEventListener("click", () => postCheckin("safe"));
$("checkin-help").addEventListener("click", () => postCheckin("help"));
