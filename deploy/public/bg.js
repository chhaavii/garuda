/**
 * Decorative background: terrain wireframe, thermal reveal, embers,
 * streamlines, satellite pass. Canvas 2D throughout, one rAF loop.
 * Illustrative only - nothing here is real geofence data.
 */
(() => {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced) return;

  const terrainCanvas = document.getElementById("bg-terrain");
  const heatCanvas = document.getElementById("bg-heat");
  const emberCanvas = document.getElementById("bg-embers");
  if (!terrainCanvas || !heatCanvas || !emberCanvas) return;

  const DPR = Math.min(window.devicePixelRatio || 1, 1.5);
  const mobile = window.matchMedia("(max-width: 720px)").matches;

  const ctxT = terrainCanvas.getContext("2d");
  const ctxH = heatCanvas.getContext("2d");
  const ctxE = emberCanvas.getContext("2d");

  let W = 0;
  let H = 0;
  let heatField = null; // offscreen thermal map

  const pointer = { x: 0.5, y: 0.55, ex: 0.5, ey: 0.55 };
  let beat = 1;
  let visible = !document.hidden;

  /* --------------------------------------------------------- noise ------- */
  function hash(x, y) {
    const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return s - Math.floor(s);
  }
  function smooth(x, y) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const a = hash(xi, yi);
    const b = hash(xi + 1, yi);
    const c = hash(xi, yi + 1);
    const d = hash(xi + 1, yi + 1);
    return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
  }
  function height(x, z) {
    let value = 0;
    let amp = 1;
    let freq = 0.9;
    for (let o = 0; o < 4; o++) {
      value += smooth(x * freq, z * freq) * amp;
      amp *= 0.5;
      freq *= 2.1;
    }
    return value / 1.9;
  }

  /* ------------------------------------------------------ heat field ----- */
  function buildHeat() {
    heatField = document.createElement("canvas");
    heatField.width = Math.ceil(W * 0.5);
    heatField.height = Math.ceil(H * 0.5);
    const ctx = heatField.getContext("2d");
    const img = ctx.createImageData(heatField.width, heatField.height);
    const scale = 0.006;
    for (let y = 0; y < heatField.height; y++) {
      for (let x = 0; x < heatField.width; x++) {
        const n = height(x * scale, y * scale);
        const edge = 1 - Math.min(1, Math.hypot((x / heatField.width - 0.5) * 1.5, (y / heatField.height - 0.5) * 1.4));
        const v = Math.max(0, n * 0.85 + edge * 0.35 - 0.32);
        const i = (y * heatField.width + x) * 4;
        img.data[i] = Math.min(255, 120 + v * 460);
        img.data[i + 1] = Math.min(255, 30 + v * 330);
        img.data[i + 2] = Math.min(255, 12 + v * 90);
        img.data[i + 3] = Math.min(210, v * 520);
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  /* -------------------------------------------------------- resize ------- */
  function resize() {
    W = window.innerWidth;
    H = window.innerHeight;
    for (const canvas of [terrainCanvas, heatCanvas, emberCanvas]) {
      canvas.width = Math.floor(W * DPR);
      canvas.height = Math.floor(H * DPR);
      canvas.style.width = W + "px";
      canvas.style.height = H + "px";
    }
    ctxT.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctxH.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctxE.setTransform(DPR, 0, 0, DPR, 0, 0);
    buildHeat();
    initStreams();
  }

  /* ------------------------------------------------------ streamlines ---- */
  let streams = [];
  function initStreams() {
    const count = mobile ? 380 : 1200;
    streams = new Array(count).fill(0).map(() => ({
      x: Math.random() * W,
      y: Math.random() * H,
      len: 6 + Math.random() * 22,
      speed: 0.25 + Math.random() * 0.8,
    }));
  }
  function flow(x, y, t) {
    const a = Math.sin(x * 0.0016 + t * 0.00012) + Math.cos(y * 0.0013 - t * 0.00009);
    return a * 0.9;
  }

  /* ----------------------------------------------------------- embers ---- */
  const embers = [];
  function spawnEmber() {
    const fromHotspot = Math.random() < 0.45;
    embers.push({
      x: fromHotspot ? W * (0.35 + Math.random() * 0.3) : Math.random() * W,
      y: H * (fromHotspot ? 0.45 + Math.random() * 0.2 : 0.7 + Math.random() * 0.3),
      vy: -0.18 - Math.random() * 0.5,
      vx: (Math.random() - 0.5) * 0.24,
      life: 0,
      max: 260 + Math.random() * 340,
      r: 0.7 + Math.random() * 1.6,
    });
  }

  /* --------------------------------------------------- satellite pass ---- */
  let satT = -1;
  let satCooldown = 220;
  let hotspots = [];

  /* ------------------------------------------------------------ draw ----- */
  let last = performance.now();

  function frame(now) {
    if (!visible) {
      last = now;
      requestAnimationFrame(frame);
      return;
    }
    const dt = Math.min(48, now - last);
    last = now;

    // eased spotlight
    pointer.ex += (pointer.x - pointer.ex) * 0.1;
    pointer.ey += (pointer.y - pointer.ey) * 0.1;

    const beatDim = beat === 4 ? 0.4 : 1;
    const windBoost = beat === 2 ? 2.1 : 1;
    const hotBoost = beat === 1 ? 1.35 : beat === 3 ? 1.1 : 1;

    /* terrain wireframe */
    ctxT.clearRect(0, 0, W, H);
    const cols = mobile ? 26 : 40;
    const rows = mobile ? 16 : 24;
    const cellW = W / (cols - 1);
    const cellH = H / (rows - 1);
    const t = now * 0.00005;
    const camX = Math.sin(t) * 0.12 + (pointer.ex - 0.5) * 0.12;
    const camY = Math.cos(t * 0.8) * 0.08 + (pointer.ey - 0.5) * 0.08;

    const pts = [];
    for (let r = 0; r < rows; r++) {
      const row = [];
      for (let c = 0; c < cols; c++) {
        const nx = c / (cols - 1) + camX;
        const nz = r / (rows - 1) + camY;
        const h = height(nx * 2.4, nz * 2.4);
        const x = c * cellW + (h - 0.5) * 20 * hotBoost; // slight parallax
        const y = r * cellH + (h - 0.5) * (H * 0.055) - 20;
        row.push({ x, y, h });
      }
      pts.push(row);
    }

    const emberRGB = beat === 3 ? "255,68,56" : "255,122,54";
    ctxT.lineWidth = 1;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const p = pts[r][c];
        const alpha = 0.05 + p.h * 0.16;
        ctxT.strokeStyle = `rgba(${emberRGB},${alpha * beatDim})`;
        if (c < cols - 1) {
          const q = pts[r][c + 1];
          ctxT.beginPath();
          ctxT.moveTo(p.x, p.y);
          ctxT.lineTo(q.x, q.y);
          ctxT.stroke();
        }
        if (r < rows - 1) {
          const q = pts[r + 1][c];
          ctxT.beginPath();
          ctxT.moveTo(p.x, p.y);
          ctxT.lineTo(q.x, q.y);
          ctxT.stroke();
        }
      }
    }

    // lat/long ticks
    ctxT.fillStyle = `rgba(243,239,230,${0.16 * beatDim})`;
    ctxT.font = "9px 'JetBrains Mono', monospace";
    for (let i = 0; i < 5; i++) {
      ctxT.fillText(`${(12.9 + i * 0.03).toFixed(2)} N`, 14, 40 + i * 34);
      ctxT.fillText(`${(77.5 + i * 0.03).toFixed(2)} E`, W - 88, 40 + i * 34);
    }

    /* streamlines */
    ctxT.strokeStyle = `rgba(243,239,230,${0.12 * beatDim * (beat === 2 ? 1.5 : 0.75)})`;
    ctxT.beginPath();
    for (const s of streams) {
      const ang = flow(s.x, s.y, now);
      const sp = s.speed * windBoost * (beat === 2 ? 1.9 : 1);
      s.x += Math.cos(ang) * sp + 0.35 * windBoost;
      s.y += Math.sin(ang) * sp * 0.55;
      if (s.x > W + 20) s.x = -20;
      if (s.y > H + 20) s.y = -20;
      if (s.y < -20) s.y = H + 20;
      ctxT.moveTo(s.x, s.y);
      ctxT.lineTo(s.x - Math.cos(ang) * s.len, s.y - Math.sin(ang) * s.len * 0.6);
    }
    ctxT.stroke();

    /* thermal reveal through the spotlight */
    ctxH.clearRect(0, 0, W, H);
    if (heatField) {
      const radius = 260 * (beat === 1 ? 1.12 : 1);
      const cx = pointer.ex * W;
      const cy = pointer.ey * H;
      ctxH.save();
      ctxH.beginPath();
      ctxH.arc(cx, cy, radius, 0, Math.PI * 2);
      ctxH.clip();
      ctxH.globalCompositeOperation = "source-over";
      ctxH.drawImage(heatField, 0, 0, W, H);
      ctxH.restore();
      // soft falloff ring
      const grad = ctxH.createRadialGradient(cx, cy, radius * 0.35, cx, cy, radius);
      grad.addColorStop(0, "rgba(8,13,11,0)");
      grad.addColorStop(1, "rgba(8,13,11,0.92)");
      ctxH.globalCompositeOperation = "destination-out";
      ctxH.fillStyle = grad;
      ctxH.beginPath();
      ctxH.arc(cx, cy, radius, 0, Math.PI * 2);
      ctxH.fill();
      ctxH.globalCompositeOperation = "source-over";
    }

    /* embers */
    if (embers.length < (mobile ? 60 : 140) && Math.random() < 0.7) spawnEmber();
    ctxE.clearRect(0, 0, W, H);
    for (let i = embers.length - 1; i >= 0; i--) {
      const e = embers[i];
      const dx = e.x - pointer.ex * W;
      const dy = e.y - pointer.ey * H;
      const d2 = dx * dx + dy * dy;
      if (d2 < 26000) {
        const push = (1 - d2 / 26000) * 0.7;
        e.x += (dx / Math.max(1, Math.sqrt(d2))) * push;
        e.y += (dy / Math.max(1, Math.sqrt(d2))) * push;
      }
      e.x += e.vx + 0.22;
      e.y += e.vy;
      e.life += dt * 0.06;
      const alpha = Math.max(0, 1 - e.life / e.max) * 0.55 * beatDim;
      if (e.life > e.max || e.y < -10) {
        embers.splice(i, 1);
        continue;
      }
      ctxE.fillStyle = `rgba(255,${140 + Math.round(e.r * 30)},60,${alpha})`;
      ctxE.beginPath();
      ctxE.arc(e.x, e.y, e.r, 0, Math.PI * 2);
      ctxE.fill();
    }

    /* satellite pass every ~12 s */
    if (satT < 0) {
      satCooldown -= dt;
      if (satCooldown <= 0) {
        satT = 0;
        satCooldown = 12000;
        hotspots = [];
      }
    } else {
      satT += dt;
      const p = satT / 2600;
      if (p <= 1) {
        const x = -60 + p * (W + 120);
        const y = H * 0.18 + Math.sin(p * Math.PI) * -70 + p * 90;
        // orbit track
        ctxT.strokeStyle = `rgba(243,239,230,${0.16 * beatDim})`;
        ctxT.setLineDash([3, 6]);
        ctxT.beginPath();
        for (let q = 0; q <= 1; q += 0.02) {
          ctxT.lineTo(-60 + q * (W + 120), H * 0.18 + Math.sin(q * Math.PI) * -70 + q * 90);
        }
        ctxT.stroke();
        ctxT.setLineDash([]);
        // satellite glyph
        ctxT.fillStyle = `rgba(243,239,230,${0.75 * beatDim})`;
        ctxT.fillRect(x - 4, y - 2, 8, 4);
        ctxT.fillRect(x - 9, y - 1, 3, 2);
        ctxT.fillRect(x + 6, y - 1, 3, 2);
        ctxT.font = "9px 'JetBrains Mono', monospace";
        ctxT.fillText("VIIRS · NOAA-20", x + 12, y - 6);
        // scan swath
        const swathX = x;
        const grad = ctxT.createLinearGradient(swathX - 40, 0, swathX + 40, 0);
        grad.addColorStop(0, "rgba(255,154,60,0)");
        grad.addColorStop(0.5, `rgba(255,154,60,${0.12 * beatDim})`);
        grad.addColorStop(1, "rgba(255,154,60,0)");
        ctxT.fillStyle = grad;
        ctxT.fillRect(swathX - 40, 0, 80, H);
        if (Math.random() < 0.08 && hotspots.length < 6) {
          hotspots.push({ x: swathX + (Math.random() - 0.5) * 24, y: H * (0.3 + Math.random() * 0.5), born: now });
        }
      } else {
        satT = -1;
      }
    }

    for (let i = hotspots.length - 1; i >= 0; i--) {
      const h = hotspots[i];
      const age = (now - h.born) / 4000;
      if (age > 1) {
        hotspots.splice(i, 1);
        continue;
      }
      const cool = Math.max(0, 1 - age);
      const r = 3 + cool * 5;
      const grd = ctxT.createRadialGradient(h.x, h.y, 0, h.x, h.y, r * 3);
      grd.addColorStop(0, `rgba(255,154,60,${0.55 * cool * beatDim})`);
      grd.addColorStop(1, "rgba(255,68,56,0)");
      ctxT.fillStyle = grd;
      ctxT.beginPath();
      ctxT.arc(h.x, h.y, r * 3, 0, Math.PI * 2);
      ctxT.fill();
      if (age < 0.35) {
        ctxT.fillStyle = `rgba(243,239,230,${0.5 * (1 - age / 0.35)})`;
        ctxT.font = "9px 'JetBrains Mono', monospace";
        ctxT.fillText("FRP 21.4 MW · high", h.x + 10, h.y - 8);
      }
    }

    /* delivery rings on beat 5 */
    if (beat === 5) {
      ctxT.strokeStyle = `rgba(255,154,60,${0.22})`;
      const phase = (now * 0.00028) % 1;
      for (let k = 0; k < 3; k++) {
        const rr = ((phase + k / 3) % 1) * Math.min(W, H) * 0.6;
        ctxT.beginPath();
        ctxT.arc(W * 0.5, H * 0.55, rr, 0, Math.PI * 2);
        ctxT.stroke();
      }
    }

    requestAnimationFrame(frame);
  }

  window.addEventListener("resize", resize, { passive: true });
  window.addEventListener("pointermove", (event) => {
    pointer.x = event.clientX / window.innerWidth;
    pointer.y = event.clientY / window.innerHeight;
  }, { passive: true });
  window.addEventListener("agni:beat", (event) => {
    beat = Number(event.detail) || 1;
    beat = Math.max(1, Math.min(5, beat));
  });
  document.addEventListener("visibilitychange", () => {
    visible = !document.hidden;
  });

  resize();
  requestAnimationFrame(frame);
})();
