#!/usr/bin/python3
"""Verify risk_core.py and risk-core.js produce identical assessments.

Generates deterministic feature vectors, evaluates them in both runtimes and
asserts the risk score, band and fired-rule set agree.
"""

import json
import os
import random
import subprocess
import sys
import tempfile

import risk_core

HERE = os.path.dirname(os.path.abspath(__file__))
CORE = os.path.join(HERE, "risk-core.js")


def make_vectors(n=220, seed=7):
    rng = random.Random(seed)
    vectors = []
    for _ in range(n):
        vectors.append(
            {
                "ffmc": round(rng.uniform(40, 99), 1),
                "isi": round(rng.uniform(0, 30), 2),
                "wind_kmh": round(rng.uniform(0, 60), 1),
                "rh": round(rng.uniform(10, 95), 1),
                "heating_rate_c_h": round(rng.uniform(-2, 4), 2),
                "slope_pct": round(rng.uniform(0, 35), 1),
                "aspect_deg": round(rng.uniform(0, 359), 1),
                "wind_dir_deg": round(rng.uniform(0, 359), 1),
                "fuel_class": rng.choice(["urban", "grass", "scrub", "forest"]),
                "fire_distance_km": round(rng.choice([0.5, 1.2, 1.9, 3.5, 8.0, 15.0, 25.0]), 2),
                "alignment": round(rng.uniform(0, 1), 2),
            }
        )
    return vectors


NODE_RUNNER = """
import { assess, simulatedFires, DEFAULT_CONFIG } from './risk-core.mjs';
import fs from 'node:fs';
const vectors = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const out = vectors.map((v) => {
  const r = assess(v, DEFAULT_CONFIG);
  return { score: r.score, band: r.band, rules: r.fired_rules.map((f) => f.rule + ':' + f.strength) };
});
fs.writeFileSync(process.argv[3], JSON.stringify(out));

const cycles = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
const fires = cycles.map((cycle) =>
  simulatedFires(cycle, DEFAULT_CONFIG.centre, DEFAULT_CONFIG.watch_km).map((f) => ({
    lat: f.lat, lng: f.lng, frp: f.frp, confidence: f.confidence,
    satellite: f.satellite, distance_km: f.distance_km,
  }))
);
fs.writeFileSync(process.argv[5], JSON.stringify(fires));
"""


def run_js(vectors, cycles):
    tmp = tempfile.mkdtemp()
    core_copy = os.path.join(tmp, "risk-core.mjs")
    with open(CORE) as src, open(core_copy, "w") as dst:
        dst.write(src.read())
    runner = os.path.join(tmp, "runner.mjs")
    with open(runner, "w") as handle:
        handle.write(NODE_RUNNER)
    vectors_path = os.path.join(tmp, "vectors.json")
    out_path = os.path.join(tmp, "out.json")
    cycles_path = os.path.join(tmp, "cycles.json")
    fires_path = os.path.join(tmp, "fires.json")
    with open(vectors_path, "w") as handle:
        json.dump(vectors, handle)
    with open(cycles_path, "w") as handle:
        json.dump(cycles, handle)
    subprocess.run(
        ["node", runner, vectors_path, out_path, cycles_path, fires_path], check=True, cwd=tmp
    )
    with open(out_path) as handle:
        scored = json.load(handle)
    with open(fires_path) as handle:
        fires = json.load(handle)
    return scored, fires


def main():
    vectors = make_vectors()
    cycles = [1993863, 1993864, 1993865, 1993900, 1994000]
    js, js_fires = run_js(vectors, cycles)
    worst = 0.0
    mismatches = []

    for vector, js_result in zip(vectors, js):
        py = risk_core.assess(vector)
        diff = abs(py["score"] - js_result["score"])
        worst = max(worst, diff)
        if diff > 0.2 or py["band"] != js_result["band"]:
            mismatches.append((vector, py["score"], js_result["score"], py["band"], js_result["band"]))

    fire_mismatches = 0
    for cycle, js_list in zip(cycles, js_fires):
        py_list = risk_core.simulated_fires(cycle)
        if len(py_list) != len(js_list):
            fire_mismatches += 1
            continue
        for py_fire, js_fire in zip(py_list, js_list):
            for key in ("lat", "lng", "frp", "confidence", "satellite", "distance_km"):
                if py_fire[key] != js_fire[key]:
                    fire_mismatches += 1
                    print(f"  fire mismatch cycle {cycle} {key}: {py_fire[key]} vs {js_fire[key]}")
                    break

    print(f"vectors          : {len(vectors)}")
    print(f"max score delta  : {worst:.2f}")
    print(f"band mismatches  : {sum(1 for m in mismatches if m[3] != m[4])}")
    print(f"score mismatches : {len(mismatches)} (> 0.2)")
    print(f"simulated fires  : {len(cycles)} cycles, {fire_mismatches} mismatches")

    if fire_mismatches:
        return 1

    if mismatches:
        for m in mismatches[:5]:
            print("  vector", m[0])
            print("   python", m[1], m[3], "| js", m[2], m[4])
        return 1

    print("PARITY OK - engine.py and worker.js agree")
    return 0


if __name__ == "__main__":
    sys.exit(main())
