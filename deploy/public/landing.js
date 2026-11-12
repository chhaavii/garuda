/**
 * Garuda landing page.
 * The fuzzy playground calls the same risk-core module the Worker runs.
 */
import { fuzzyRisk, assess, DEFAULT_CONFIG, clamp, alertText } from "./risk-core.js";

const $ = (id) => document.getElementById(id);
const CFG = DEFAULT_CONFIG;

/* ------------------------------------------------------------ status ----- */
async function loadStatus() {
  const chip = $("live-chip");
  const text = $("chip-text");
  try {
    const resp = await fetch("/status", { cache: "no-store" });
    const s = await resp.json();
    if (!resp.ok || s.risk_score === undefined || s.error) throw new Error("unavailable");

    const mins = Math.max(0, Math.round((Date.now() - Date.parse(s.timestamp.replace(" ", "T") + "+05:30")) / 60000));
    const badge = s.sources?.firms === "simulated" ? " · simulated detections" : "";
    text.textContent = `Last check ${mins} min ago · ${s.severity} ${Math.round(s.risk_score)}/100${badge}`;
    chip.className = "chip live " + s.severity.toLowerCase();
  } catch (err) {
    text.textContent = "engine unreachable — open the dashboard";
    chip.className = "chip off";
  }
}
loadStatus();

/* -------------------------------------------------------- playground ----- */
const pf = {
  temp: $("pf-temp"),
  rh: $("pf-rh"),
  wind: $("pf-wind"),
  heat: $("pf-heat"),
  slope: $("pf-slope"),
  dist: $("pf-dist"),
};

/** Stand-in FFMC from the sliders (FWI needs a 14-day spin-up the visitor can't drag). */
function pseudoFfmc(temp, rh) {
  return clamp(58 + (temp - 20) * 1.5 + (60 - rh) * 0.5, 35, 99);
}

function playgroundFeatures() {
  const temp = Number(pf.temp.value);
  const rh = Number(pf.rh.value);
  const wind = Number(pf.wind.value);
  const heat = Number(pf.heat.value);
  const slope = Number(pf.slope.value);
  const dist = Number(pf.dist.value);
  return {
    ffmc: pseudoFfmc(temp, rh),
    wind_kmh: wind,
    rh,
    heating_rate_c_h: heat,
    slope_pct: slope,
    fire_distance_km: dist,
    alignment: 0.75,
    temp_c: temp,
  };
}

const CURVE_W = 300;

function drawCurves(memberships, features) {
  const canvas = $("pf-curves");
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const w = canvas.clientWidth || CURVE_W;
  const h = 120;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const pad = 4;
  const plotW = w - pad * 2;
  const plotH = h - 20;

  const series = [
    { name: "ffmc", label: "FFMC", value: features.ffmc, max: 101, terms: ["low", "moderate", "high", "extreme"], colours: ["#8a8f5a", "#e8c547", "#ff9a3c", "#ff4438"] },
    { name: "wind", label: "WIND km/h", value: features.wind_kmh, max: 70, terms: ["calm", "moderate", "strong"], colours: ["#5f7f6f", "#e8c547", "#ff4438"] },
  ];

  // one panel per variable
  series.forEach((s, panel) => {
    const yBase = pad + panel * (plotH / 2);
    const rowH = plotH / 2 - 6;
    s.terms.forEach((term, i) => {
      ctx.beginPath();
      ctx.strokeStyle = s.colours[i];
      ctx.lineWidth = 1.2;
      ctx.globalAlpha = 0.85;
      for (let px = 0; px <= plotW; px++) {
        const value = (px / plotW) * s.max;
        const mu = memberships[s.name][term] ? membershipAt(s, term, value) : 0;
        const y = yBase + rowH - mu * rowH;
        if (px === 0) ctx.moveTo(pad + px, y);
        else ctx.lineTo(pad + px, y);
      }
      ctx.stroke();
    });
    // current value marker
    const px = pad + (clamp(s.value, 0, s.max) / s.max) * plotW;
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "rgba(243,239,230,0.55)";
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(px, yBase);
    ctx.lineTo(px, yBase + rowH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(243,239,230,0.6)";
    ctx.font = "9px 'JetBrains Mono', monospace";
    ctx.fillText(s.label, pad, yBase + 8);
    ctx.globalAlpha = 0.5;
  });
  ctx.globalAlpha = 1;
}

/* Mirror of the membership shapes in risk-core (only for drawing). */
const tri = (x, a, b, c) => (x <= a || x >= c ? 0 : x === b ? 1 : x < b ? (x - a) / (b - a) : (c - x) / (c - b));
const trap = (x, a, b, c, d) => (x <= a || x >= d ? 0 : b <= x && x <= c ? 1 : x < b ? (x - a) / (b - a) : (d - x) / (d - c));
function membershipAt(series, term, x) {
  if (series.name === "ffmc") {
    if (term === "low") return trap(x, 0, 0, 70, 80);
    if (term === "moderate") return tri(x, 72, 82, 90);
    if (term === "high") return trap(x, 82, 88, 96, 101);
    return trap(x, 90, 96, 101, 101);
  }
  if (term === "calm") return trap(x, 0, 0, 8, 15);
  if (term === "moderate") return tri(x, 10, 20, 32);
  return trap(x, 26, 38, 80, 80);
}

function updatePlayground() {
  const features = playgroundFeatures();
  const result = fuzzyRisk(features, CFG);

  $("pf-temp-out").textContent = `${features.temp_c.toFixed(1)} °C`;
  $("pf-rh-out").textContent = `${features.rh} %`;
  $("pf-wind-out").textContent = `${features.wind_kmh} km/h`;
  $("pf-heat-out").textContent = `${features.heating_rate_c_h.toFixed(1)} °C/h`;
  $("pf-slope-out").textContent = `${features.slope_pct} %`;
  $("pf-dist-out").textContent = `${features.fire_distance_km.toFixed(1)} km`;

  $("pf-score").textContent = result.score.toFixed(1);
  const band = $("pf-band");
  band.className = "badge " + result.band.toLowerCase();
  band.textContent = result.band;
  $("pf-bar").style.width = result.score + "%";

  const rules = $("pf-rules");
  rules.innerHTML = "";
  const fired = result.fired_rules.slice(0, 4);
  if (!fired.length) {
    rules.innerHTML = '<li><span>no rule fired</span><b>0.00</b></li>';
  }
  for (const rule of fired) {
    const li = document.createElement("li");
    li.innerHTML = `<span>${rule.rule}</span><b>${rule.strength.toFixed(2)}</b>`;
    rules.appendChild(li);
  }
  drawCurves(result.memberships, features);
}

Object.values(pf).forEach((input) => input?.addEventListener("input", updatePlayground));
window.addEventListener("resize", () => updatePlayground());
updatePlayground();

/* ------------------------------------------------------------ ladder ----- */
const MESSAGES = {
  LOW: "Low fire risk: conditions quiet. Keep windows closed and watch for updates.",
  MEDIUM: "Medium fire risk: dry fuel and wind. Prepare an evacuation kit and charge devices.",
  HIGH: "HIGH fire risk: fire within 2 km, strong wind. Evacuate now and follow local authority orders.",
};
const LED_LABEL = { LOW: "1 slow blink", MEDIUM: "2 medium blinks", HIGH: "3 rapid blinks" };

let band = "LOW";
const ladderButtons = [...document.querySelectorAll(".ladder-btn")];
function selectBand(next, play = false) {
  band = next;
  ladderButtons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.band === next)));
  $("ladder-msg").textContent = MESSAGES[next];
  $("led").className = "led " + next.toLowerCase();
  $("led-label").textContent = LED_LABEL[next];
  if (play) beep(next);
}
ladderButtons.forEach((btn) => btn.addEventListener("click", () => selectBand(btn.dataset.band, true)));
selectBand("LOW");

let audioCtx = null;
function beep(level) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const counts = { LOW: 1, MEDIUM: 2, HIGH: 3 };
    const gap = { LOW: 0.5, MEDIUM: 0.3, HIGH: 0.16 }[level];
    const freq = { LOW: 440, MEDIUM: 620, HIGH: 880 }[level];
    for (let i = 0; i < counts[level]; i++) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "triangle";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, audioCtx.currentTime + i * gap);
      gain.gain.exponentialRampToValueAtTime(0.12, audioCtx.currentTime + i * gap + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + i * gap + 0.09);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(audioCtx.currentTime + i * gap);
      osc.stop(audioCtx.currentTime + i * gap + 0.1);
    }
  } catch (err) {
    /* audio is a nicety, never a requirement */
  }
}
$("beep-btn").addEventListener("click", () => beep(band));

/* ----------------------------------------------------- story reveal ------ */
const beats = [...document.querySelectorAll(".beat")];
const progress = $("story-progress");

const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add("in");
        const n = Number(entry.target.dataset.beat);
        window.__agniBeat = n;
        window.dispatchEvent(new CustomEvent("agni:beat", { detail: n }));
      }
    }
  },
  { threshold: 0.45 }
);
beats.forEach((beat) => observer.observe(beat));

window.addEventListener(
  "scroll",
  () => {
    const story = $("story");
    if (!story) return;
    const rect = story.getBoundingClientRect();
    const total = rect.height - window.innerHeight;
    const pct = clamp(-rect.top / Math.max(total, 1), 0, 1);
    progress.style.width = (pct * 100).toFixed(1) + "%";
  },
  { passive: true }
);

/* ---------------------------------------------------------- mobile nav --- */
const navToggle = $("nav-toggle");
const navMenu = $("nav-menu");

function setMenu(open) {
  if (!navMenu || !navToggle) return;
  navMenu.classList.toggle("open", open);
  navToggle.setAttribute("aria-expanded", String(open));
  navToggle.setAttribute("aria-label", open ? "Close section menu" : "Open section menu");
}

navToggle?.addEventListener("click", (event) => {
  event.stopPropagation();
  setMenu(!navMenu.classList.contains("open"));
});
navMenu?.querySelectorAll("a").forEach((link) => link.addEventListener("click", () => setMenu(false)));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") setMenu(false);
});
document.addEventListener("click", (event) => {
  if (!navMenu?.contains(event.target) && !navToggle?.contains(event.target)) setMenu(false);
});
window.addEventListener("resize", () => {
  if (window.innerWidth > 860) setMenu(false);
});

/* ------------------------------------------------------------- anchors --- */
/**
 * The pinned story is five 60vh beats, so a plain #hash jump lands wherever the
 * browser guessed before fonts and the Cesium canvas settle the layout. Measure
 * the target and scroll to it instead, and re-run once fonts are ready.
 */
const NAV_OFFSET = 92;
let anchorToken = 0;

function scrollToHash(hash, smooth = true) {
  if (!hash || hash === "#") return;
  const target = document.querySelector(hash);
  if (!target) return;

  const token = ++anchorToken;
  const measure = () =>
    Math.max(0, target.getBoundingClientRect().top + window.scrollY - NAV_OFFSET);

  window.scrollTo({ top: measure(), behavior: smooth ? "smooth" : "auto" });

  // The story stage and the Cesium canvas settle after the scroll starts, which
  // makes the target move. Re-measure and correct twice, unless the visitor
  // takes over scrolling first.
  [650, 1500].forEach((delay) =>
    setTimeout(() => {
      if (token !== anchorToken) return;
      const top = measure();
      if (Math.abs(window.scrollY - top) > 8) {
        window.scrollTo({ top, behavior: "auto" });
      }
    }, delay)
  );
}

for (const event of ["wheel", "touchstart", "keydown"]) {
  window.addEventListener(event, () => {
    anchorToken++;
  }, { passive: true });
}

document.querySelectorAll('a[href^="#"]').forEach((link) => {
  link.addEventListener("click", (event) => {
    const hash = link.getAttribute("href");
    if (!hash || hash.length < 2) return;
    event.preventDefault();
    history.replaceState(null, "", hash);
    scrollToHash(hash);
  });
});

window.addEventListener("hashchange", () => scrollToHash(location.hash));

if (location.hash) {
  const settle = () => scrollToHash(location.hash, false);
  window.addEventListener("load", () => setTimeout(settle, 80));
  document.fonts?.ready.then(() => setTimeout(settle, 80));
}

/* ------------------------------------------------------------ numbers ---- */
const counters = [...document.querySelectorAll("[data-count]")];
const counterObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el = entry.target;
      const target = Number(el.dataset.count);
      const start = performance.now();
      const duration = 900;
      const step = (now) => {
        const t = Math.min(1, (now - start) / duration);
        el.textContent = Math.round(target * (1 - Math.pow(1 - t, 3))).toString();
        if (t < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
      counterObserver.unobserve(el);
    }
  },
  { threshold: 0.6 }
);
counters.forEach((c) => counterObserver.observe(c));

fetch("/backtest", { cache: "no-store" })
  .then(async (resp) => {
    if (!resp.ok) throw new Error((await resp.json()).reason || "unavailable");
    return resp.json();
  })
  .then((data) => {
    $("bt-hit").textContent = data.hit_rate === null ? "—" : (data.hit_rate * 100).toFixed(1) + "%";
    $("bt-fa").textContent = data.false_alarm_rate === null ? "—" : (data.false_alarm_rate * 100).toFixed(1) + "%";
    $("bt-fire").textContent = data.median_risk_fire_days ?? "—";
    $("bt-quiet").textContent = data.median_risk_quiet_days ?? "—";
    $("bt-sample").textContent = data.sample_days ?? "—";
    $("bt-meta").textContent = `${data.date_range || "—"} · ${data.sample_days || 0} days · generated ${data.generated_at || "—"}`;
  })
  .catch((err) => {
    $("bt-meta").textContent = `Backtest not computed yet: ${err.message}`;
    $("bt-sample").textContent = "—";
  });

/* ---------------------------------------------------------- mini map ----- */
let mini = null;

async function initMiniMap() {
  if (typeof Cesium === "undefined") {
    $("cesium-mini").innerHTML = '<p class="tiny muted" style="padding:16px">3D map unavailable (Cesium failed to load).</p>';
    return;
  }
  let cfg = { centre: CFG.centre, geofence_km: CFG.geofence_km, watch_km: CFG.watch_km, cesium_ion_token: null };
  let weather = { wind_dir_deg: 250, wind_kmh: 18 };
  try {
    cfg = await (await fetch("/config.json")).json();
    weather = await (await fetch("/weather.json")).json();
  } catch (err) {
    /* fall back to defaults */
  }

  if (cfg.cesium_ion_token) Cesium.Ion.defaultAccessToken = cfg.cesium_ion_token;
  $("mini-badge").textContent = cfg.cesium_ion_token ? "Cesium ion · live imagery" : "OSM imagery · flat ellipsoid";

  const { lat, lng } = cfg.centre;
  const viewer = new Cesium.Viewer("cesium-mini", {
    terrainProvider: cfg.cesium_ion_token ? Cesium.createWorldTerrain() : new Cesium.EllipsoidTerrainProvider(),
    baseLayer: cfg.cesium_ion_token
      ? undefined
      : new Cesium.ImageryLayer(
          new Cesium.OpenStreetMapImageryProvider({ url: "https://tile.openstreetmap.org/" })
        ),
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    animation: false,
    timeline: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
  });
  viewer.scene.globe.depthTestAgainstTerrain = false;

  const centreCart = Cesium.Cartesian3.fromDegrees(lng, lat, 20);
  viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(centreCart, cfg.geofence_km * 1000 * 2.6), {
    duration: 0,
    offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-55), cfg.geofence_km * 1000 * 3.4),
  });

  const windTo = ((weather.wind_dir_deg ?? 250) + 180) % 360;

  // geofence + watch ring
  viewer.entities.add({
    position: Cesium.Cartesian3.fromDegrees(lng, lat),
    ellipse: {
      semiMajorAxis: cfg.geofence_km * 1000,
      semiMinorAxis: cfg.geofence_km * 1000,
      material: Cesium.Color.fromCssColorString("#ff6b2b").withAlpha(0.16),
      outline: true,
      outlineColor: Cesium.Color.fromCssColorString("#ff6b2b"),
      outlineWidth: 2,
      height: 20,
    },
  });
  viewer.entities.add({
    position: Cesium.Cartesian3.fromDegrees(lng, lat),
    ellipse: {
      semiMajorAxis: cfg.watch_km * 1000,
      semiMinorAxis: cfg.watch_km * 1000,
      fill: false,
      outline: true,
      outlineColor: Cesium.Color.fromCssColorString("#e8c547").withAlpha(0.5),
      outlineWidth: 1,
      height: 20,
    },
  });

  // downwind wedge (60 degrees wide, out to the watch ring)
  const wedgePositions = [];
  const wedgeRadius = cfg.watch_km * 1000;
  for (let a = -30; a <= 30; a += 5) {
    const dist = wedgeRadius;
    const bearing = Cesium.Math.toRadians(windTo + a);
    const dLat = (dist / 111000) * Math.cos(bearing);
    const dLng = (dist / (111000 * Math.cos(Cesium.Math.toRadians(lat)))) * Math.sin(bearing);
    wedgePositions.push(lng + dLng, lat + dLat, 30);
  }
  viewer.entities.add({
    polygon: {
      hierarchy: Cesium.Cartesian3.fromDegreesArrayHeights([lng, lat, 30, ...wedgePositions]),
      material: Cesium.Color.fromCssColorString("#ff9a3c").withAlpha(0.14),
      outline: false,
      height: 30,
    },
  });

  let dropped = null;
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((click) => {
    const ray = viewer.camera.getPickRay(click.position);
    const cartesian = viewer.scene.globe.pick(ray, viewer.scene);
    if (!cartesian) return;
    const carto = Cesium.Cartographic.fromCartesian(cartesian);
    const fireLat = Cesium.Math.toDegrees(carto.latitude);
    const fireLng = Cesium.Math.toDegrees(carto.longitude);

    const R = 6371;
    const dLat = Cesium.Math.toRadians(fireLat - lat);
    const dLng = Cesium.Math.toRadians(fireLng - lng);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(Cesium.Math.toRadians(lat)) * Math.cos(Cesium.Math.toRadians(fireLat)) * Math.sin(dLng / 2) ** 2;
    const distance = 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));

    const toCentre = (Math.atan2(lng - fireLng, fireLat - lat) * 180) / Math.PI;
    const delta = Math.abs(((toCentre - windTo + 540) % 360) - 180);
    const alignment = Math.max(0, 1 - delta / 90);

    if (dropped) viewer.entities.remove(dropped);
    dropped = viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(fireLng, fireLat, 30),
      point: { pixelSize: 12, color: Cesium.Color.fromCssColorString("#ff4438"), outlineColor: Cesium.Color.WHITE, outlineWidth: 1 },
    });

    const result = assess(
      {
        ffmc: 88,
        isi: 9,
        wind_kmh: weather.wind_kmh ?? 18,
        rh: 38,
        heating_rate_c_h: 1.2,
        slope_pct: 5,
        aspect_deg: 180,
        wind_dir_deg: windTo,
        fuel_class: CFG.fuel_class,
        fire_distance_km: distance,
        alignment,
      },
      CFG
    );
    $("mini-badge").textContent = `${distance.toFixed(1)} km · ${result.band} ${Math.round(result.score)}/100 · ETA ${
      result.eta_hours ? result.eta_hours.toFixed(1) + " h" : "—"
    }`;
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  mini = viewer;
}

initMiniMap();

/* ---------------------------------------------------- voice broadcast ---- */
$("speak-btn").addEventListener("click", () => {
  const langCode = $("speak-lang").value;
  const scoreText = document.getElementById("pf-score")?.textContent || "";
  const score = Number(scoreText.replace(/[^\d.]/g, "")) || { LOW: 22, MEDIUM: 52, HIGH: 74 }[band];
  const copy = alertText(langCode, { severity: band, score, impact: null });
  $("ladder-msg").textContent = copy.text;

  if (!("speechSynthesis" in window)) return;
  const synth = window.speechSynthesis;
  synth.cancel();
  const utter = new SpeechSynthesisUtterance(copy.voice_script);
  utter.lang = copy.bcp47;
  const prefix = copy.bcp47.split("-")[0].toLowerCase();
  const voices = synth.getVoices();
  utter.voice =
    voices.find((v) => v.lang?.toLowerCase() === copy.bcp47.toLowerCase()) ||
    voices.find((v) => v.lang?.toLowerCase().startsWith(prefix)) ||
    null;
  utter.rate = 0.95;
  synth.speak(utter);
});
