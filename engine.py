#!/usr/bin/python3
"""Garuda local engine (Flask).

Runs the same risk core as the hosted Worker (risk_core.py mirrors
risk-core.js; parity_test.py asserts identical output) against live data:

  NASA FIRMS   - needs FIRMS_MAP_KEY (env or config.secrets.json), else SIMULATED
  Open-Meteo   - forecast + elevation + air quality, free, no key
  Channels     - Discord / Infobip SMS / SendGrid email, only when secrets exist

Secrets are read from the environment first, then config.secrets.json, which is
gitignored. Nothing secret belongs in config.json or this file.
"""

import csv
import io
import json
import os
import time

import requests
from flask import Flask, jsonify, request

import risk_core

CFG = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")))
SECRETS = {}
if os.path.exists("config.secrets.json"):
    SECRETS = json.load(open("config.secrets.json"))

MAP_KEY = os.environ.get("FIRMS_MAP_KEY") or SECRETS.get("firms_map_key", "")
DISCORD_WEBHOOK = os.environ.get("DISCORD_WEBHOOK_URL") or SECRETS.get("discord_webhook_url", "")
SMS_API_KEY = os.environ.get("INFOBIP_API_KEY") or SECRETS.get("infobip_api_key", "")
SMS_SENDER = os.environ.get("INFOBIP_SENDER") or SECRETS.get("infobip_sender", "")
SMS_RECIPIENT = os.environ.get("ALERT_SMS_TO") or SECRETS.get("alert_sms_to", "")
SENDGRID_API_KEY = os.environ.get("SENDGRID_API_KEY") or SECRETS.get("sendgrid_api_key", "")
SENDGRID_TO = os.environ.get("ALERT_EMAIL_TO") or SECRETS.get("alert_email_to", "")

CENTRE = CFG["centre"]
CACHE_MS = 15 * 60
SENSORS = ["VIIRS_SNPP_NRT", "VIIRS_NOAA20_NRT", "MODIS_NRT"]

app = Flask(__name__)
cache = {"at": 0, "weather": None, "daily": None, "terrain": None, "air": None, "fires": None, "notes": [], "firms": "simulated"}
history = []
last_watch_at = 0


# ------------------------------------------------------------- adapters --
def fetch_weather():
    url = (
        f"https://api.open-meteo.com/v1/forecast?latitude={CENTRE['lat']}&longitude={CENTRE['lng']}"
        "&hourly=temperature_2m,relative_humidity_2m,dew_point_2m,vapour_pressure_deficit,"
        "wind_speed_10m,wind_gusts_10m,wind_direction_10m,precipitation,soil_moisture_0_to_1cm"
        f"&past_days=14&forecast_days=2&timezone={CFG.get('timezone', 'Asia/Kolkata')}"
    )
    data = requests.get(url, timeout=20).json()["hourly"]
    rows = [
        {
            "time": data["time"][i],
            "temp": data["temperature_2m"][i],
            "rh": data["relative_humidity_2m"][i],
            "dew_point": data["dew_point_2m"][i],
            "vpd": data["vapour_pressure_deficit"][i],
            "wind": data["wind_speed_10m"][i],
            "gust": data["wind_gusts_10m"][i],
            "wind_dir": data["wind_direction_10m"][i],
            "rain": data["precipitation"][i],
            "soil_moisture": data["soil_moisture_0_to_1cm"][i],
        }
        for i in range(len(data["time"]))
    ]
    now_iso = time.strftime("%Y-%m-%dT%H", time.gmtime(time.time() + 19800))
    idx = next((i for i, row in enumerate(rows) if row["time"][:13] == now_iso), len(rows) - 48)
    idx = max(0, idx)

    by_day = {}
    for row in rows:
        by_day.setdefault(row["time"][:10], []).append(row)
    daily = []
    for day in sorted(by_day):
        day_rows = by_day[day]
        noon = next((r for r in day_rows if r["time"][11:13] == "12"), day_rows[len(day_rows) // 2])
        daily.append(
            {
                "temp": noon["temp"],
                "rh": noon["rh"],
                "wind": noon["wind"],
                "rain": sum((r["rain"] or 0) for r in day_rows),
                "month": int(noon["time"][5:7]),
            }
        )
    return rows, idx, daily


def fetch_terrain():
    d_lat = 1 / 111
    d_lng = 1 / (111 * abs(__import__("math").cos(__import__("math").radians(CENTRE["lat"]))))
    lats, lngs = [], []
    for row in (-1, 0, 1):
        for col in (-1, 0, 1):
            lats.append(round(CENTRE["lat"] + row * d_lat, 5))
            lngs.append(round(CENTRE["lng"] + col * d_lng, 5))
    data = requests.get(
        "https://api.open-meteo.com/v1/elevation",
        params={"latitude": ",".join(map(str, lats)), "longitude": ",".join(map(str, lngs))},
        timeout=20,
    ).json()
    return [{"lat": lats[i], "lng": lngs[i], "elevation": data["elevation"][i]} for i in range(9)]


def fetch_air():
    data = requests.get(
        "https://air-quality-api.open-meteo.com/v1/air-quality",
        params={"latitude": CENTRE["lat"], "longitude": CENTRE["lng"], "hourly": "pm2_5,carbon_monoxide", "forecast_days": 1},
        timeout=20,
    ).json()["hourly"]
    return {"pm2_5": data["pm2_5"][-1], "co": data["carbon_monoxide"][-1], "time": data["time"][-1]}


def fetch_firms():
    d_lat = CFG["watch_km"] / 111
    d_lng = CFG["watch_km"] / (111 * abs(__import__("math").cos(__import__("math").radians(CENTRE["lat"]))))
    bbox = f"{CENTRE['lng'] - d_lng:.3f},{CENTRE['lat'] - d_lat:.3f},{CENTRE['lng'] + d_lng:.3f},{CENTRE['lat'] + d_lat:.3f}"
    fires, errors = [], []
    for sensor in SENSORS:
        url = f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}/{sensor}/{bbox}/1"
        try:
            text = requests.get(url, timeout=25).text
            if "Invalid MAP_KEY" in text:
                errors.append(f"{sensor}: invalid MAP_KEY")
                continue
            reader = csv.DictReader(io.StringIO(text))
            for row in reader:
                conf = (row.get("confidence") or "").strip().lower()
                if conf in ("low", "l", "n"):
                    continue
                try:
                    if 0 < float(conf) < 30:
                        continue
                except ValueError:
                    pass
                lat, lng = float(row["latitude"]), float(row["longitude"])
                distance = risk_core.haversine_km(CENTRE["lat"], CENTRE["lng"], lat, lng)
                if distance > CFG["watch_km"]:
                    continue
                fires.append(
                    {
                        "lat": lat,
                        "lng": lng,
                        "frp": float(row.get("frp") or 0),
                        "confidence": row.get("confidence"),
                        "satellite": row.get("satellite", sensor),
                        "acq_datetime": f"{row['acq_date']}T{str(row['acq_time']).zfill(4)[:2]}:{str(row['acq_time']).zfill(4)[2:]}:00",
                        "distance_km": round(distance, 2),
                    }
                )
        except Exception as exc:  # noqa: BLE001 - reported as stale/simulated
            errors.append(f"{sensor}: {exc}")
    if not fires and errors:
        raise RuntimeError(errors[0])
    fires.sort(key=lambda f: f["distance_km"])
    return fires[:2000]


def simulated_fires():
    """Delegates to the shared generator so the Worker and this engine agree."""
    return risk_core.simulated_fires(int(time.time() // 900), CENTRE, CFG["watch_km"])


def load(force=False):
    if not force and cache["weather"] and time.time() - cache["at"] < CACHE_MS:
        return cache
    notes = []
    try:
        rows, idx, daily = fetch_weather()
        cache.update({"weather": rows, "idx": idx, "daily": daily})
    except Exception as exc:  # noqa: BLE001
        notes.append(f"weather: {exc}")
    try:
        cache["terrain"] = fetch_terrain()
    except Exception as exc:  # noqa: BLE001
        notes.append(f"terrain: {exc}")
    try:
        cache["air"] = fetch_air()
    except Exception as exc:  # noqa: BLE001
        notes.append(f"air: {exc}")

    if MAP_KEY:
        try:
            cache["fires"] = fetch_firms()
            cache["firms"] = "live"
        except Exception as exc:  # noqa: BLE001
            notes.append(f"firms: {exc}")
            cache["firms"] = "stale" if cache.get("fires") else "simulated"
            cache["fires"] = cache.get("fires") or simulated_fires()
    else:
        cache["firms"] = "simulated"
        cache["fires"] = simulated_fires()

    cache["notes"] = notes
    cache["at"] = time.time()
    return cache


# ------------------------------------------------------------- assembly --
def build_status(force_high=False):
    data = load()
    rows, idx = data["weather"], data["idx"]
    hour, prev3 = rows[idx], rows[max(0, idx - 3)]
    heating = (hour["temp"] - prev3["temp"]) / 3

    fires = data["fires"] or []
    if force_high:
        fires = [
            {
                "lat": CENTRE["lat"] + 0.011,
                "lng": CENTRE["lng"] + 0.01,
                "frp": 38.2,
                "confidence": "high",
                "satellite": "SIMULATED",
                "acq_datetime": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "distance_km": 1.2,
            }
        ]

    nearest = fires[0] if fires else None
    alignment = 0.0
    if nearest:
        to_centre = risk_core.bearing_deg(nearest["lat"], nearest["lng"], CENTRE["lat"], CENTRE["lng"])
        alignment = risk_core.clamp(1 - risk_core.angle_diff(to_centre, hour["wind_dir"]) / 90, 0, 1)

    codes = risk_core.fwi_spin_up(data["daily"] or [])
    terrain = risk_core.terrain_features(data["terrain"])

    features = {
        **codes,
        "wind_kmh": round(hour["wind"], 1),
        "gust_kmh": round(hour["gust"], 1),
        "wind_dir_deg": round(hour["wind_dir"], 1),
        "rh": round(hour["rh"], 1),
        "temp_c": round(hour["temp"], 1),
        "vpd_kpa": round(hour["vpd"], 2),
        "heating_rate_c_h": round(heating, 2),
        "rain_mm": round(hour["rain"] or 0, 1),
        "soil_moisture": round(hour["soil_moisture"], 2),
        "elevation_m": terrain["elevation_m"],
        "slope_pct": terrain["slope_pct"],
        "aspect_deg": terrain["aspect_deg"],
        "fuel_class": CFG["fuel_class"],
        "fire_distance_km": nearest["distance_km"] if nearest else CFG["watch_km"],
        "fire_count": len(fires),
        "alignment": round(alignment, 2),
        "pm2_5": data["air"]["pm2_5"] if data["air"] else None,
        "co": data["air"]["co"] if data["air"] else None,
    }

    result = risk_core.assess(features)
    timeline = []
    for offset in range(CFG["forecast_hours"]):
        i = min(idx + offset, len(rows) - 1)
        row = rows[i]
        past = rows[max(0, i - 3)]
        merged = {
            **features,
            "wind_kmh": round(row["wind"], 1),
            "wind_dir_deg": round(row["wind_dir"], 1),
            "rh": round(row["rh"], 1),
            "heating_rate_c_h": round((row["temp"] - past["temp"]) / 3, 2),
        }
        scored = risk_core.assess(merged)
        timeline.append(
            {"time": row["time"], "score": scored["score"], "band": scored["band"], "wind_kmh": merged["wind_kmh"], "rh": merged["rh"]}
        )

    tth = next(({"hours": i, "at": p["time"]} for i, p in enumerate(timeline) if p["band"] == "HIGH"), None)
    severity = "HIGH" if force_high else result["band"]

    global last_watch_at
    watch = None
    if (
        severity != "HIGH"
        and tth
        and tth["hours"] <= CFG["watch_horizon_hours"]
        and time.time() - last_watch_at > CFG["watch_cooldown_hours"] * 3600
    ):
        last_watch_at = time.time()
        watch = {"issued_at": time.strftime("%Y-%m-%d %H:%M:%S"), "expected_in_hours": tth["hours"], "delivered": False}

    status = {
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "cycle": {"index": int(time.time() // 900), "minutes": 15, "seconds_remaining": 900 - int(time.time()) % 900},
        "severity": severity,
        "risk_score": result["score"],
        "message": message_for(severity, result["reasons"]),
        "reasons": result["reasons"],
        "fired_rules": result["fired_rules"],
        "override": result["override"],
        "spread_estimate_kmh": result["spread_estimate_kmh"],
        "eta_hours": result["eta_hours"],
        "upslope": result["upslope"],
        "fuel_class": result["fuel_class"],
        "fuel_multiplier": result["fuel_multiplier"],
        "features": features,
        "timeline": timeline,
        "time_to_high": tth,
        "watch": watch,
        "air": {
            "pm2_5": features["pm2_5"],
            "co": features["co"],
            "o2_percent": None,
            "o2_note": "no sensor attached",
            "baseline_percent": 20.9,
            "smoke": bool((features["pm2_5"] or 0) > 60 or (features["co"] or 0) > 4000),
        },
        "fires": fires,
        "sources": {
            "firms": "simulated" if force_high else data["firms"],
            "weather": "stale" if any(n.startswith("weather") for n in data["notes"]) else "live",
            "terrain": "live" if terrain["available"] else "unavailable",
            "air": "live" if data["air"] else "unavailable",
        },
        "notes": data["notes"],
        "simulated": force_high,
        "hosted": False,
    }

    history.append({"timestamp": status["timestamp"], "severity": severity, "risk_score": status["risk_score"]})
    del history[:-96]
    return status


def message_for(band, reasons):
    text = ", ".join(reasons[:3]) or "conditions present"
    if band == "HIGH":
        return f"HIGH fire risk: {text}. Evacuate the area, seek a cooling centre, follow local authority orders."
    if band == "MEDIUM":
        return f"Medium fire risk: {text}. Prepare an evacuation kit and charge devices."
    return "Low fire risk: conditions quiet. Keep windows closed and watch for updates."


# -------------------------------------------------------------- channels --
def dispatch(status):
    sent = {}
    if status["severity"] != "HIGH":
        return {"skipped": "not HIGH"}

    if DISCORD_WEBHOOK:
        try:
            resp = requests.post(DISCORD_WEBHOOK, json={"content": status["message"]}, timeout=8)
            sent["discord"] = "sent" if resp.status_code in (200, 204) else f"failed({resp.status_code})"
        except Exception as exc:  # noqa: BLE001
            sent["discord"] = f"error: {exc}"
    else:
        sent["discord"] = "no secret"

    if SMS_API_KEY and SMS_RECIPIENT:
        try:
            resp = requests.post(
                "https://pdlnye.api.infobip.com/sms/3/messages",
                headers={"Authorization": f"App {SMS_API_KEY}", "Content-Type": "application/json"},
                json={"messages": [{"destinations": [{"to": SMS_RECIPIENT}], "sender": SMS_SENDER, "content": {"text": status["message"]}}]},
                timeout=12,
            )
            sent["sms"] = "sent" if resp.ok else f"failed({resp.status_code})"
        except Exception as exc:  # noqa: BLE001
            sent["sms"] = f"error: {exc}"
    else:
        sent["sms"] = "no secret"

    if SENDGRID_API_KEY and SENDGRID_TO:
        try:
            resp = requests.post(
                "https://api.sendgrid.com/v3/mail/send",
                headers={"Authorization": f"Bearer {SENDGRID_API_KEY}", "Content-Type": "application/json"},
                json={
                    "personalizations": [{"to": [{"email": SENDGRID_TO}]}],
                    "from": {"email": SECRETS.get("sendgrid_from", "alerts@example.org")},
                    "subject": f"Garuda: {status['severity']} fire risk",
                    "content": [{"type": "text/plain", "value": status["message"]}],
                },
                timeout=12,
            )
            sent["email"] = "sent" if resp.status_code in (200, 202) else f"failed({resp.status_code})"
        except Exception as exc:  # noqa: BLE001
            sent["email"] = f"error: {exc}"
    else:
        sent["email"] = "no secret"

    sent["gpio"] = "logged"
    return sent


# --------------------------------------------------------------- routes --
@app.route("/status")
def status_route():
    return jsonify(build_status())


@app.route("/history")
def history_route():
    return jsonify({"cycles": history[-32:], "note": "session history"})


@app.route("/simulate", methods=["POST"])
def simulate_route():
    status = build_status(force_high=True)
    status["dispatch"] = dispatch(status)
    return jsonify({"result": "success", "simulated": True, "status": status})


@app.route("/fires.geojson")
def fires_route():
    data = load()
    return jsonify(
        {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [fire["lng"], fire["lat"]]},
                    "properties": {
                        "frp": fire["frp"],
                        "confidence": fire["confidence"],
                        "satellite": fire["satellite"],
                        "acq_datetime": fire["acq_datetime"],
                        "distance_km_from_centre": fire["distance_km"],
                    },
                }
                for fire in data["fires"] or []
            ],
            "meta": {"updated": time.strftime("%Y-%m-%d %H:%M:%S"), "badge": data["firms"], "watch_km": CFG["watch_km"]},
        }
    )


@app.route("/weather.json")
def weather_route():
    data = load()
    hour = data["weather"][data["idx"]]
    return jsonify(
        {
            "wind_kmh": round(hour["wind"], 1),
            "wind_gust_kmh": round(hour["gust"], 1),
            "wind_dir_deg": round(hour["wind_dir"], 1),
            "temp_c": round(hour["temp"], 1),
            "rh": round(hour["rh"], 1),
            "updated": time.strftime("%Y-%m-%d %H:%M:%S"),
            "badge": data["firms"],
        }
    )


if __name__ == "__main__":
    print("Garuda local engine")
    print(f"  centre        : {CENTRE['lat']}, {CENTRE['lng']} ({CFG['geofence_km']} km geofence, {CFG['watch_km']} km watch)")
    print(f"  FIRMS key     : {'configured' if MAP_KEY else 'MISSING - simulated detections'}")
    print(f"  Discord/SMS/email: {bool(DISCORD_WEBHOOK)}/{bool(SMS_API_KEY)}/{bool(SENDGRID_API_KEY)}")
    print("  serving on http://0.0.0.0:5000  (/status /history /simulate /fires.geojson /weather.json)")
    app.run(host="0.0.0.0", port=5000, debug=False)
