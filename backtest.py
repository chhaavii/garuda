#!/usr/bin/python3
"""12-month backtest: score every day with the same fuzzy engine, report real numbers.

Requires FIRMS_MAP_KEY (env or config.secrets.json) for the FIRMS archive and
uses the free Open-Meteo archive for weather. Writes backtest.json, which the
Worker serves at /backtest and the landing page reads.

If the key is missing this script refuses to run and writes nothing: a
backtest with invented numbers would be worse than no backtest.
"""

import json
import os
import statistics
import sys
import time

import requests

import risk_core

HERE = os.path.dirname(os.path.abspath(__file__))
CFG = json.load(open(os.path.join(HERE, "config.json")))
SECRETS = {}
if os.path.exists(os.path.join(HERE, "config.secrets.json")):
    SECRETS = json.load(open(os.path.join(HERE, "config.secrets.json")))

MAP_KEY = os.environ.get("FIRMS_MAP_KEY") or SECRETS.get("firms_map_key", "")
CENTRE = CFG["centre"]
SENSORS = ["VIIRS_SNPP_NRT", "VIIRS_NOAA20_NRT", "MODIS_NRT"]
DAYS = 365


def bbox():
    d_lat = CFG["watch_km"] / 111
    d_lng = CFG["watch_km"] / (111 * abs(__import__("math").cos(__import__("math").radians(CENTRE["lat"]))))
    return f"{CENTRE['lng'] - d_lng:.3f},{CENTRE['lat'] - d_lat:.3f},{CENTRE['lng'] + d_lng:.3f},{CENTRE['lat'] + d_lat:.3f}"


def fetch_archive_detections(start_date, end_date):
    """FIRMS archive detections inside the watch ring, grouped by date."""
    by_day = {}
    url = (
        f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}/"
        f"{SENSORS[0]}/{bbox()}/{DAYS}/{start_date}"
    )
    resp = requests.get(url, timeout=60)
    if not resp.ok or "Invalid MAP_KEY" in resp.text[:200]:
        raise RuntimeError(f"FIRMS archive failed: HTTP {resp.status_code} {resp.text[:120]}")
    lines = resp.text.strip().splitlines()
    if not lines:
        return by_day
    header = [h.strip().lower() for h in lines[0].split(",")]
    i_lat, i_lng = header.index("latitude"), header.index("longitude")
    i_date = header.index("acq_date")
    for line in lines[1:]:
        cells = line.split(",")
        if len(cells) <= i_date:
            continue
        try:
            lat, lng = float(cells[i_lat]), float(cells[i_lng])
        except ValueError:
            continue
        distance = risk_core.haversine_km(CENTRE["lat"], CENTRE["lng"], lat, lng)
        if distance > CFG["watch_km"]:
            continue
        by_day.setdefault(cells[i_date], []).append(round(distance, 2))
    return by_day


def fetch_archive_weather(start_date, end_date):
    resp = requests.get(
        "https://archive-api.open-meteo.com/v1/archive",
        params={
            "latitude": CENTRE["lat"],
            "longitude": CENTRE["lng"],
            "start_date": start_date,
            "end_date": end_date,
            "hourly": "temperature_2m,relative_humidity_2m,wind_speed_10m,precipitation",
            "timezone": CFG.get("timezone", "Asia/Kolkata"),
        },
        timeout=90,
    )
    resp.raise_for_status()
    hourly = resp.json()["hourly"]
    rows = [
        {
            "time": hourly["time"][i],
            "temp": hourly["temperature_2m"][i],
            "rh": hourly["relative_humidity_2m"][i],
            "wind": hourly["wind_speed_10m"][i],
            "rain": hourly["precipitation"][i] or 0,
        }
        for i in range(len(hourly["time"]))
    ]
    by_day = {}
    for row in rows:
        by_day.setdefault(row["time"][:10], []).append(row)
    return by_day


def main():
    if not MAP_KEY:
        print("FIRMS_MAP_KEY is not set.")
        print("Add it to the environment or config.secrets.json, then rerun. No backtest.json written.")
        return 1

    end = time.strftime("%Y-%m-%d")
    start = time.strftime("%Y-%m-%d", time.gmtime(time.time() - DAYS * 86400))
    print(f"window: {start} -> {end} ({DAYS} days)")

    detections = fetch_archive_detections(start, end)
    weather = fetch_archive_weather(start, end)
    print(f"fire days with detections: {len(detections)} · weather days: {len(weather)}")

    days = []
    for day in sorted(weather):
        rows = weather[day]
        if len(rows) < 12:
            continue
        noon = rows[12]
        daily = [
            {
                "temp": noon["temp"],
                "rh": noon["rh"],
                "wind": noon["wind"],
                "rain": sum(r["rain"] for r in rows),
                "month": int(day[5:7]),
            }
        ]
        # spin up on the trailing 14 days that we have
        idx = sorted(weather).index(day)
        window = [d for d in sorted(weather)[max(0, idx - 14) : idx + 1]]
        daily_series = []
        for d in window:
            r = weather[d][12] if len(weather[d]) > 12 else weather[d][0]
            daily_series.append(
                {
                    "temp": r["temp"],
                    "rh": r["rh"],
                    "wind": r["wind"],
                    "rain": sum(x["rain"] for x in weather[d]),
                    "month": int(d[5:7]),
                }
            )
        codes = risk_core.fwi_spin_up(daily_series)

        fire_distances = detections.get(day, [])
        distance = min(fire_distances) if fire_distances else CFG["watch_km"]
        features = {
            **codes,
            "wind_kmh": noon["wind"],
            "rh": noon["rh"],
            "heating_rate_c_h": round((rows[12]["temp"] - rows[9]["temp"]) / 3, 2),
            "slope_pct": 1.0,
            "aspect_deg": 180.0,
            "wind_dir_deg": 250.0,
            "fuel_class": CFG["fuel_class"],
            "fire_distance_km": distance,
            "alignment": 0.5,
        }
        result = risk_core.assess(features)
        days.append(
            {
                "date": day,
                "risk": result["score"],
                "band": result["band"],
                "fire": bool(fire_distances),
                "ffmc": codes["ffmc"],
                "fwi": codes["fwi"],
                "wind_kmh": noon["wind"],
                "rh": noon["rh"],
            }
        )

    fire_days = [d for d in days if d["fire"]]
    quiet_days = [d for d in days if not d["fire"]]
    threshold = CFG["thresholds"]["medium"]

    def rate(rows, pred):
        return round(sum(1 for d in rows if pred(d)) / len(rows), 4) if rows else None

    result = {
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "date_range": f"{start} -> {end}",
        "sample_days": len(days),
        "fire_days": len(fire_days),
        "quiet_days": len(quiet_days),
        "threshold_medium": threshold,
        "median_risk_fire_days": round(statistics.median(d["risk"] for d in fire_days), 1) if fire_days else None,
        "median_risk_quiet_days": round(statistics.median(d["risk"] for d in quiet_days), 1) if quiet_days else None,
        "hit_rate": rate(fire_days, lambda d: d["risk"] >= threshold),
        "false_alarm_rate": rate(quiet_days, lambda d: d["risk"] >= threshold),
        "percentiles": {
            "ffmc_fire_p50": round(statistics.median(d["ffmc"] for d in fire_days), 1) if fire_days else None,
            "ffmc_quiet_p90": round(statistics.quantiles([d["ffmc"] for d in quiet_days], n=10)[8], 1) if len(quiet_days) > 9 else None,
            "wind_fire_p50": round(statistics.median(d["wind_kmh"] for d in fire_days), 1) if fire_days else None,
            "rh_fire_p50": round(statistics.median(d["rh"] for d in fire_days), 1) if fire_days else None,
        },
        "method": "Daily FWI spin-up + 27-rule fuzzy engine, threshold at MEDIUM; calendar days, one score per day. Percentiles used to sanity-check membership breakpoints.",
        "days": days,
    }

    with open(os.path.join(HERE, "backtest.json"), "w") as handle:
        json.dump(result, handle, indent=2)
    print(json.dumps({k: v for k, v in result.items() if k != "days"}, indent=2))
    print("wrote backtest.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
