#!/usr/bin/python3
"""Python mirror of risk-core.js.

Same FWI system, same fuzzy rules, same defuzzification and the same hard
override, so engine.py and the Worker return identical numbers.
parity_test.py compares this file against the JavaScript module.
"""

import json
import math
import re
import time

DEFAULT_CONFIG = {
    "centre": {"lat": 12.9716, "lng": 77.5946},
    "geofence_km": 5,
    "watch_km": 25,
    "fuel_class": "urban",
    "fuel_multiplier": {"urban": 0.6, "grass": 1.2, "scrub": 1.0, "forest": 0.9},
    "thresholds": {"medium": 35, "high": 65, "hard_override_km": 2},
    "cycle_minutes": 15,
    "forecast_hours": 12,
}

LE = [6.5, 7.5, 9.0, 12.8, 13.9, 13.9, 12.4, 10.9, 9.4, 8.0, 7.0, 6.0]
FL = [-1.6, -1.6, -1.6, 0.9, 3.8, 5.8, 6.4, 5.0, 2.4, 0.4, -1.6, -1.6]


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def r1(v):
    return round(v, 1)


def r2(v):
    return round(v, 2)


def haversine_km(lat1, lon1, lat2, lon2):
    r = math.radians
    dlat = r(lat2 - lat1)
    dlon = r(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(r(lat1)) * math.cos(r(lat2)) * math.sin(dlon / 2) ** 2
    return 6371 * 2 * math.asin(min(1, math.sqrt(a)))


def bearing_deg(lat1, lon1, lat2, lon2):
    r = math.radians
    y = math.sin(r(lon2 - lon1)) * math.cos(r(lat2))
    x = math.cos(r(lat1)) * math.sin(r(lat2)) - math.sin(r(lat1)) * math.cos(r(lat2)) * math.cos(
        r(lon2 - lon1)
    )
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def angle_diff(a, b):
    return abs(((a - b + 540) % 360) - 180)


# ------------------------------------------------------------ FWI system --
def ffmc(temp, rh, wind, rain, prev=85.0):
    rh = clamp(rh, 1, 100)
    wind = max(wind, 0)
    mo = 147.2 * (101 - prev) / (59.5 + prev)
    if rain > 0.5:
        rf = rain - 0.5
        decay = math.exp(-100 / max(251 - mo, 1))
        wetting = 42.5 * rf * decay * (1 - math.exp(-6.93 / rf))
        if mo > 150:
            wetting += 0.0015 * (mo - 150) ** 2 * math.sqrt(rf)
        mo = min(mo + wetting, 250)
    ed = (
        0.942 * rh ** 0.679
        + 11 * math.exp((rh - 100) / 10)
        + 0.18 * (21.1 - temp) * (1 - math.exp(-0.115 * rh))
    )
    if mo > ed:
        ko = 0.424 * (1 - (rh / 100) ** 1.7) + 0.0694 * math.sqrt(wind) * (1 - (rh / 100) ** 8)
        m = ed + (mo - ed) * 10 ** (-(ko * 0.581 * math.exp(0.0365 * temp)))
    else:
        ew = (
            0.618 * rh ** 0.753
            + 10 * math.exp((rh - 100) / 10)
            + 0.18 * (21.1 - temp) * (1 - math.exp(-0.115 * rh))
        )
        if mo < ew:
            kl = 0.424 * (1 - ((100 - rh) / 100) ** 1.7) + 0.0694 * math.sqrt(wind) * (
                1 - ((100 - rh) / 100) ** 8
            )
            m = ew + (mo - ew) * 10 ** (-(kl * 0.581 * math.exp(0.0365 * temp)))
        else:
            m = mo
    return clamp(59.5 * (250 - m) / (147.2 + m), 0, 101)


def dmc(temp, rh, rain, prev=6.0, month=11):
    rh = clamp(rh, 1, 100)
    k = 1.894 * (temp + 1.1) * (100 - rh) * LE[month - 1] * 1e-6
    pr = prev
    if rain > 1.5:
        rf = rain - 1.5
        mr = 20 + math.exp(5.6348 - prev / 43.43)
        if prev <= 33:
            b = 100 / (0.5 + 0.3 * prev)
        elif prev <= 65:
            b = 14 - 1.3 * math.log(prev)
        else:
            b = 6.2 * math.log(prev) - 17.2
        mr += 1000 * rf / (48.77 + b * rf)
        pr = max(0, 244.72 - 43.43 * math.log(max(mr - 20, 1e-6)))
    return clamp(pr + 100 * k, 0, 500)


def dc_code(temp, rain, prev=15.0, month=11):
    t = max(temp, -2.8)
    pe = max(0, 0.36 * (t + 2.8) + FL[month - 1])
    d = prev
    if rain > 2.8:
        d = max(0, d - 0.83 * rain + 1.27)
    return max(0, d + pe)


def isi(ffmc_value, wind):
    m = 147.2 * (101 - ffmc_value) / (59.5 + ffmc_value)
    f_wind = math.exp(0.05039 * max(wind, 0))
    f_fuel = 91.9 * math.exp(-0.1386 * m) * (1 + m ** 5.31 / 4.93e7)
    return 0.208 * f_wind * f_fuel


def bui(dmc_value, dc_value):
    denom = dmc_value + 0.4 * dc_value
    if denom <= 0:
        return 0
    if dmc_value <= 0.4 * dc_value:
        return 0.8 * dmc_value * dc_value / denom
    return dmc_value - (1 - 0.8 * dc_value / denom) * (0.92 + (0.0114 * dmc_value) ** 1.7)


def fwi_value(isi_value, bui_value):
    if bui_value <= 80:
        f_d = 0.626 * bui_value ** 0.809 + 2
    else:
        f_d = 1000 / (25 + 108.64 * math.exp(-0.023 * bui_value))
    b = 0.1 * isi_value * f_d
    return math.exp(2.72 * (0.434 * math.log(b)) ** 0.647) if b > 1 else b


def danger_class(value):
    if value < 5:
        return "low"
    if value < 10:
        return "moderate"
    if value < 20:
        return "high"
    if value < 30:
        return "very high"
    return "extreme"


def fwi_spin_up(daily):
    codes = {"ffmc": 85.0, "dmc": 6.0, "dc": 15.0}
    for day in daily:
        codes = {
            "ffmc": ffmc(day["temp"], day["rh"], day["wind"], day["rain"], codes["ffmc"]),
            "dmc": dmc(day["temp"], day["rh"], day["rain"], codes["dmc"], day.get("month", 11)),
            "dc": dc_code(day["temp"], day["rain"], codes["dc"], day.get("month", 11)),
        }
    last_wind = daily[-1]["wind"] if daily else 10
    isi_value = isi(codes["ffmc"], last_wind)
    bui_value = bui(codes["dmc"], codes["dc"])
    fwi_v = fwi_value(isi_value, bui_value)
    return {
        "ffmc": r1(codes["ffmc"]),
        "dmc": r1(codes["dmc"]),
        "dc": r1(codes["dc"]),
        "isi": r2(isi_value),
        "bui": r1(bui_value),
        "fwi": r1(fwi_v),
        "danger_class": danger_class(fwi_v),
        "spun_up_days": len(daily),
    }


# --------------------------------------------------------------- fuzzy ----
def tri(x, a, b, c):
    if x <= a or x >= c:
        return 0.0
    if x == b:
        return 1.0
    return (x - a) / (b - a) if x < b else (c - x) / (c - b)


def trap(x, a, b, c, d):
    if x <= a or x >= d:
        return 0.0
    if b <= x <= c:
        return 1.0
    return (x - a) / (b - a) if x < b else (d - x) / (d - c)


def fuzzify(f):
    ff = f.get("ffmc", 70) or 70
    wind = f.get("wind_kmh", 0) or 0
    heat = f.get("heating_rate_c_h", 0) or 0
    rh = f.get("rh", 50) or 50
    slope = f.get("slope_pct", 0) or 0
    prox = clamp(f.get("fire_distance_km", 25) or 25, 0, 25)
    align = clamp(f.get("alignment", 0) or 0, 0, 1)
    return {
        "ffmc": {
            "low": trap(ff, 0, 0, 70, 80),
            "moderate": tri(ff, 72, 82, 90),
            "high": trap(ff, 82, 88, 96, 101),
            "extreme": trap(ff, 90, 96, 101, 101),
        },
        "wind": {
            "calm": trap(wind, 0, 0, 8, 15),
            "moderate": tri(wind, 10, 20, 32),
            "strong": trap(wind, 26, 38, 80, 80),
        },
        "heating": {
            "cooling": trap(heat, -6, -6, 0, 0.5),
            "steady": tri(heat, 0, 0.6, 1.4),
            "rapid": trap(heat, 1.0, 2.0, 8, 8),
        },
        "humidity": {
            "humid": trap(rh, 60, 70, 100, 100),
            "moderate": tri(rh, 30, 45, 60),
            "dry": trap(rh, 18, 30, 45, 45),
        },
        "slope": {
            "flat": trap(slope, 0, 0, 3, 7),
            "moderate": tri(slope, 4, 10, 18),
            "steep": trap(slope, 14, 22, 60, 60),
        },
        "proximity": {
            "none": trap(prox, 10, 15, 25, 25),
            "far": tri(prox, 2.5, 6, 12),
            "near": tri(prox, 0.8, 2, 4),
            "inside": trap(prox, 0, 0, 2, 3),
        },
        "alignment": {
            "crosswind": trap(align, 0, 0, 0.35, 0.6),
            "partial": tri(align, 0.4, 0.7, 0.95),
            "downwind": trap(align, 0.75, 0.9, 1, 1),
        },
    }


RULES = [
    ("ffmc extreme and wind strong", {"ffmc": ["extreme"], "wind": ["strong"]}, "high"),
    ("ffmc extreme and air dry", {"ffmc": ["extreme"], "humidity": ["dry"]}, "high"),
    ("ffmc high and wind strong", {"ffmc": ["high"], "wind": ["strong"]}, "high"),
    ("ffmc high and heating rapid", {"ffmc": ["high"], "heating": ["rapid"]}, "high"),
    ("ffmc high and slope steep", {"ffmc": ["high"], "slope": ["steep"]}, "medium"),
    ("ffmc moderate and heating rapid", {"ffmc": ["moderate"], "heating": ["rapid"]}, "medium"),
    ("ffmc moderate and wind moderate", {"ffmc": ["moderate"], "wind": ["moderate"]}, "medium"),
    ("ffmc moderate and humidity moderate", {"ffmc": ["moderate"], "humidity": ["moderate"]}, "medium"),
    ("ffmc low and air humid", {"ffmc": ["low"], "humidity": ["humid"]}, "low"),
    ("ffmc low and wind calm", {"ffmc": ["low"], "wind": ["calm"]}, "low"),
    ("wind strong and heating rapid", {"wind": ["strong"], "heating": ["rapid"]}, "high"),
    ("wind strong and air dry", {"wind": ["strong"], "humidity": ["dry"]}, "high"),
    ("fire inside and downwind and wind strong", {"proximity": ["inside"], "alignment": ["downwind"], "wind": ["strong"]}, "very_high"),
    ("fire inside and downwind", {"proximity": ["inside"], "alignment": ["downwind"]}, "high"),
    ("fire inside", {"proximity": ["inside"]}, "high"),
    ("fire near and downwind and wind moderate", {"proximity": ["near"], "alignment": ["downwind"], "wind": ["moderate"]}, "high"),
    ("fire near and wind strong", {"proximity": ["near"], "wind": ["strong"]}, "high"),
    ("fire near and air dry", {"proximity": ["near"], "humidity": ["dry"]}, "medium"),
    ("fire near and heating rapid", {"proximity": ["near"], "heating": ["rapid"]}, "medium"),
    ("fire far and ffmc high", {"proximity": ["far"], "ffmc": ["high"]}, "medium"),
    ("fire far and wind strong", {"proximity": ["far"], "wind": ["strong"]}, "medium"),
    ("slope steep and wind moderate and air dry", {"slope": ["steep"], "wind": ["moderate"], "humidity": ["dry"]}, "high"),
    ("slope steep and ffmc high", {"slope": ["steep"], "ffmc": ["high"]}, "high"),
    ("heating rapid and air dry", {"heating": ["rapid"], "humidity": ["dry"]}, "medium"),
    ("no fire and ffmc moderate", {"proximity": ["none"], "ffmc": ["moderate"]}, "low"),
    ("no fire and wind calm and air humid", {"proximity": ["none"], "wind": ["calm"], "humidity": ["humid"]}, "low"),
    ("no fire and ffmc high", {"proximity": ["none"], "ffmc": ["high"]}, "medium"),
]

OUTPUT = {
    "low": (0, 0, 18, 34),
    "medium": (28, 50, 68),
    "high": (60, 78, 92, 96),
    "very_high": (88, 95, 100, 100),
}


def _out_mu(score, name):
    o = OUTPUT[name]
    return trap(score, *o) if len(o) == 4 else tri(score, *o)


def fuzzy_risk(features, config=None):
    config = config or DEFAULT_CONFIG
    memberships = fuzzify(features)
    agg = {"low": 0.0, "medium": 0.0, "high": 0.0, "very_high": 0.0}
    fired = []

    for name, conditions, consequent in RULES:
        strength = 1.0
        for variable, terms in conditions.items():
            best = max(memberships[variable][term] for term in terms)
            strength = min(strength, best)
        if strength > 0:
            agg[consequent] = max(agg[consequent], strength)
            fired.append({"rule": name, "strength": r2(strength), "output": consequent})

    num = 0.0
    den = 0.0
    for score in range(0, 101):
        mu = max(
            min(agg["low"], _out_mu(score, "low")),
            min(agg["medium"], _out_mu(score, "medium")),
            min(agg["high"], _out_mu(score, "high")),
            min(agg["very_high"], _out_mu(score, "very_high")),
        )
        num += score * mu
        den += mu
    score = num / den if den > 0 else 30

    override_km = config["thresholds"]["hard_override_km"]
    overridden = (features.get("fire_distance_km") or 99) <= override_km
    if overridden:
        score = max(score, 70)

    score = r1(clamp(score, 0, 100))
    band = "LOW" if score < config["thresholds"]["medium"] else ("MEDIUM" if score < config["thresholds"]["high"] else "HIGH")
    fired.sort(key=lambda r: r["strength"], reverse=True)

    return {
        "score": score,
        "band": band,
        "memberships": memberships,
        "fired_rules": fired[:8],
        "override": f"fire within {override_km} km" if overridden else None,
        "reasons": [rule["rule"] for rule in fired[:4]],
    }


def assess(features, config=None):
    config = config or DEFAULT_CONFIG
    fuzzy = fuzzy_risk(features, config)
    fuel_mult = config["fuel_multiplier"].get(features.get("fuel_class"), 1)

    aspect = features.get("aspect_deg")
    wind_dir = features.get("wind_dir_deg")
    upslope = (
        aspect is not None
        and wind_dir is not None
        and angle_diff(aspect, (wind_dir + 180) % 360) < 60
    )
    slope_factor = 1 + (features.get("slope_pct") or 0) / 100 * (1.2 if upslope else 0.4)
    spread = r2(clamp((features.get("isi") or 0) / 12 * slope_factor * fuel_mult * 1.6, 0, 20))
    distance = features.get("fire_distance_km")
    eta = r1(distance / spread) if distance is not None and distance < config["watch_km"] and spread > 0.2 else None

    # Community reports: unverified ground truth, capped, and named as such.
    reports = max(0, min(3, int(round(features.get("reports_near") or 0))))
    score = fuzzy["score"]
    band = fuzzy["band"]
    reasons = (
        ([f"hard override: {fuzzy['override']}"] + list(fuzzy["reasons"]))
        if fuzzy["override"]
        else list(fuzzy["reasons"])
    )
    if reports > 0:
        score = r1(clamp(score + min(12, 6 * reports), 0, 100))
        thresholds = config["thresholds"]
        band = "LOW" if score < thresholds["medium"] else ("MEDIUM" if score < thresholds["high"] else "HIGH")
        reasons = [f"{reports} unverified community report{'s' if reports > 1 else ''} nearby"] + reasons

    return {
        **fuzzy,
        "score": score,
        "band": band,
        "spread_estimate_kmh": spread,
        "eta_hours": eta,
        "upslope": upslope,
        "fuel_class": features.get("fuel_class"),
        "fuel_multiplier": fuel_mult,
        "community_reports": reports,
        "reasons": reasons,
    }


def simulated_fires(cycle, centre=None, watch_km=25):
    """Deterministic synthetic detections; mirrors simulatedFires() in risk-core.js.

    Same cycle -> same fires -> same score, in Python and in the Worker.
    """
    centre = centre or DEFAULT_CONFIG["centre"]

    def seeded(offset):
        a = (int(cycle) + int(offset) * 7919) & 0xFFFFFFFF
        a = (a + 0x6D2B79F5) & 0xFFFFFFFF
        t = (a ^ (a >> 15)) & 0xFFFFFFFF
        t = (t * (1 | a)) & 0xFFFFFFFF
        t = (t ^ ((t + (((t ^ (t >> 7)) * (61 | t)) & 0xFFFFFFFF)) & 0xFFFFFFFF)) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296

    def round_half_up(value, places):
        factor = 10 ** places
        return math.floor(value * factor + 0.5) / factor

    count = 2 + (int(cycle) % 3)
    now = time.time()
    fires = []
    for i in range(count):
        bearing = seeded(i * 3) * 360
        distance = 1.2 + seeded(i * 3 + 1) * 18
        d_lat = (distance / 111) * math.cos(math.radians(bearing))
        d_lng = (distance / (111 * math.cos(math.radians(centre["lat"])))) * math.sin(math.radians(bearing))
        fires.append(
            {
                "lat": round_half_up(centre["lat"] + d_lat, 2),
                "lng": round_half_up(centre["lng"] + d_lng, 2),
                "frp": round_half_up(4 + seeded(i * 3 + 2) * 45, 1),
                "confidence": "high" if seeded(i * 3) > 0.4 else "nominal",
                "satellite": ["VIIRS SNPP", "VIIRS NOAA-20", "MODIS"][i % 3],
                "acq_datetime": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now - i * 42 * 60)),
                "distance_km": round_half_up(distance, 2),
            }
        )
    return sorted(fires, key=lambda f: f["distance_km"])


def terrain_features(grid):
    if not grid or len(grid) != 9:
        return {"elevation_m": None, "slope_pct": 0, "aspect_deg": None, "available": False}
    e = [cell["elevation"] for cell in grid]
    dzdx = ((e[2] + 2 * e[5] + e[8]) - (e[0] + 2 * e[3] + e[6])) / 8
    dzdy = ((e[6] + 2 * e[7] + e[8]) - (e[0] + 2 * e[1] + e[2])) / 8
    cell_km = haversine_km(grid[0]["lat"], grid[0]["lng"], grid[4]["lat"], grid[4]["lng"]) or 1
    rise_per_km = math.hypot(dzdx, dzdy) / (cell_km * 1000)
    slope = clamp(rise_per_km * 100, 0, 200)
    aspect = None
    if math.hypot(dzdx, dzdy) > 0.01:
        aspect = (math.degrees(math.atan2(dzdx, dzdy)) + 360) % 360
    return {
        "elevation_m": e[4],
        "slope_pct": r1(slope),
        "aspect_deg": None if aspect is None else r1(aspect),
        "available": True,
    }


# ------------------------------------------------------- impact & speech --
COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]


def compass(deg):
    d = ((deg if deg is not None else 0) % 360 + 360) % 360
    return COMPASS[int(math.floor(d / 22.5 + 0.5)) % 16]


def impact(features, fires, assessment=None, config=None):
    """Street-level reading of the same numbers the score is built from.

    Which side the fire sits on, whether the wind carries it here, and how long
    until it reaches the ring. Mirrors impact() in risk-core.js.
    """
    assessment = assessment or {}
    config = config or DEFAULT_CONFIG
    nearest = fires[0] if fires else None
    if not nearest:
        return {
            "available": False,
            "text": "no detection inside the watch ring",
            "distance_km": None,
            "eta_minutes": None,
            "relation": None,
        }
    dist = nearest.get("distance_km")
    if dist is None:
        dist = haversine_km(
            config["centre"]["lat"], config["centre"]["lng"], nearest["lat"], nearest["lng"]
        )
    bearing = bearing_deg(
        config["centre"]["lat"], config["centre"]["lng"], nearest["lat"], nearest["lng"]
    )
    wind_from = features.get("wind_dir_deg")
    relation = "nearby"
    if wind_from is not None:
        if angle_diff(bearing, wind_from) <= 55:
            relation = "upwind"
        elif angle_diff(bearing, (wind_from + 180) % 360) <= 55:
            relation = "downwind"
        else:
            relation = "crosswind"
    spread = max(assessment.get("spread_estimate_kmh") or 0, 0.2)
    # A fire the wind is carrying away gets no arrival estimate - inventing one
    # would be the exact dishonesty this project exists to avoid.
    moving_away = relation == "downwind"
    geofence = config["geofence_km"]
    if dist <= geofence:
        boundary = 0
    elif moving_away:
        boundary = None
    else:
        boundary = int(math.floor(((dist - geofence) / spread) * 60 + 0.5))
    direction = compass(bearing)
    if moving_away and boundary != 0:
        text = (
            f"Fire {r1(dist)} km downwind, {direction} side - "
            "the wind is carrying it away, no arrival estimate"
        )
    elif boundary is not None and boundary <= 0:
        text = f"Fire {r1(dist)} km {relation}, {direction} side - already inside your {geofence} km ring"
    else:
        text = (
            f"Fire {r1(dist)} km {relation}, {direction} side - est. {boundary} min to your "
            f"{geofence} km ring at {r1(spread)} km/h"
        )
    return {
        "available": True,
        "distance_km": r1(dist),
        "bearing_deg": r1(bearing),
        "compass": direction,
        "relation": relation,
        "eta_minutes": boundary,
        "eta_to_you_minutes": None if moving_away else int(math.floor((dist / spread) * 60 + 0.5)),
        "spread_kmh": r1(spread),
        "text": text,
        "source": nearest.get("satellite"),
        "detected_at": nearest.get("acq_datetime"),
        "unverified": True,
    }


def _moving_en(rel):
    if rel == "upwind":
        return "The wind is carrying it toward you."
    if rel == "downwind":
        return "The wind is carrying it away from you."
    if rel == "crosswind":
        return "The wind is crossing its path."
    return ""


ALERT_COPY = {
    "en": {
        "code": "en",
        "bcp47": "en-IN",
        "name": "English",
        "ident": "Garuda community fire warning.",
        "moving": lambda c: _moving_en(c["relation"]),
        "HIGH": lambda c: (
            f"High fire risk, {c['score']} out of 100. {c['impact']}. {c['moving']} "
            "Leave now if you are in its path, close windows, switch off the gas and the air "
            "conditioner, take ID, medicines and water, and follow local authority instructions."
        ),
        "MEDIUM": lambda c: (
            f"Medium fire risk, {c['score']} out of 100. {c['impact']}. "
            "Pack an evacuation bag, charge your phone, keep children and the elderly indoors, "
            "and watch for the next update."
        ),
        "LOW": lambda c: (
            f"Low fire risk, {c['score']} out of 100. Conditions are quiet. "
            "Keep windows closed on smoky days and watch for updates."
        ),
        "steps": {
            "HIGH": [
                "Leave now if you are in its path",
                "Windows shut, gas and AC off",
                "Take ID, medicines, water, phone",
                "Follow authority instructions",
            ],
            "MEDIUM": [
                "Pack a bag and charge devices",
                "Keep children and the elderly indoors",
                "Note two exit routes",
                "Watch the next 15-minute cycle",
            ],
            "LOW": [
                "No action needed right now",
                "Keep windows closed on smoky days",
                "Report smoke from the community card",
            ],
        },
    },
    "kn": {
        "code": "kn",
        "bcp47": "kn-IN",
        "name": "ಕನ್ನಡ",
        "ident": "ಗರುಡ ಸಮುದಾಯ ಅಗ್ನಿ ಎಚ್ಚರಿಕೆ.",
        "moving": lambda c: "",
        "HIGH": lambda c: (
            f"ಹೆಚ್ಚಿನ ಅಗ್ನಿ ಅಪಾಯ, 100ಕ್ಕೆ {c['score']}. {c['impact']} "
            "ತಕ್ಷಣ ಸುರಕ್ಷಿತ ಸ್ಥಳಕ್ಕೆ ತೆರಳಿ, ಕಿಟಕಿ ಬಾಗಿಲು ಮುಚ್ಚಿ, ಗ್ಯಾಸ್ ಮತ್ತು ಎಸಿ ಆಫ್ ಮಾಡಿ, "
            "ದಾಖಲೆ, ಔಷಧಿ ಮತ್ತು ನೀರು ತೆಗೆದುಕೊಂಡು ಹೋಗಿ, ಸ್ಥಳೀಯ ಅಧಿಕಾರಿಗಳ ಸೂಚನೆ ಪಾಲಿಸಿ."
        ),
        "MEDIUM": lambda c: (
            f"ಮಧ್ಯಮ ಅಗ್ನಿ ಅಪಾಯ, 100ಕ್ಕೆ {c['score']}. {c['impact']} "
            "ತುರ್ತು ಚೀಲ ಸಿದ್ಧಪಡಿಸಿ, ಫೋನ್ ಚಾರ್ಜ್ ಮಾಡಿ, ಮಕ್ಕಳು ಮತ್ತು ವೃದ್ಧರನ್ನು ಒಳಗೆ ಇರಿಸಿ, "
            "ಮುಂದಿನ ಮಾಹಿತಿಗೆ ಕಾಯಿರಿ."
        ),
        "LOW": lambda c: (
            f"ಕಡಿಮೆ ಅಗ್ನಿ ಅಪಾಯ, 100ಕ್ಕೆ {c['score']}. ಪರಿಸ್ಥಿತಿ ಶಾಂತವಾಗಿದೆ. "
            "ಹೊಗೆ ಇರುವ ದಿನ ಕಿಟಕಿ ಮುಚ್ಚಿ, ಮುಂದಿನ ಮಾಹಿತಿಗೆ ಕಾಯಿರಿ."
        ),
        "steps": {
            "HIGH": ["ತಕ್ಷಣ ಸ್ಥಳ ತೊರೆಯಿರಿ", "ಕಿಟಕಿ/ಗ್ಯಾಸ್/ಎಸಿ ಆಫ್", "ದಾಖಲೆ, ಔಷಧಿ, ನೀರು, ಫೋನ್", "ಅಧಿಕಾರಿಗಳ ಸೂಚನೆ ಪಾಲಿಸಿ"],
            "MEDIUM": ["ತುರ್ತು ಚೀಲ ಸಿದ್ಧ", "ಮಕ್ಕಳು, ವೃದ್ಧರು ಒಳಗೆ", "ಎರಡು ನಿರ್ಗಮನ ಮಾರ್ಗ ಗುರುತಿಸಿ", "ಮುಂದಿನ 15 ನಿಮಿಷದ ಮಾಹಿತಿ"],
            "LOW": ["ಈಗ ಏನೂ ಮಾಡಬೇಕಿಲ್ಲ", "ಹೊಗೆಯ ದಿನ ಕಿಟಕಿ ಮುಚ್ಚಿ", "ಹೊಗೆ ಕಂಡರೆ ವರದಿ ಮಾಡಿ"],
        },
    },
    "hi": {
        "code": "hi",
        "bcp47": "hi-IN",
        "name": "हिन्दी",
        "ident": "गरुड़ सामुदायिक अग्नि चेतावनी।",
        "moving": lambda c: "",
        "HIGH": lambda c: (
            f"अग्नि का गंभीर खतरा, 100 में से {c['score']}. {c['impact']} "
            "तुरंत सुरक्षित स्थान पर जाएँ, खिड़कियाँ बंद करें, गैस और एसी बंद करें, दस्तावेज़, दवा और "
            "पानी साथ लें, स्थानीय प्रशासन के निर्देश मानें."
        ),
        "MEDIUM": lambda c: (
            f"अग्नि का मध्यम खतरा, 100 में से {c['score']}. {c['impact']} "
            "आपातकालीन बैग तैयार रखें, फ़ोन चार्ज करें, बच्चों और बुज़ुर्गों को घर के अंदर रखें, "
            "अगली सूचना की प्रतीक्षा करें."
        ),
        "LOW": lambda c: (
            f"अग्नि का खतरा कम है, 100 में से {c['score']}. स्थिति शांत है. "
            "धुएँ वाले दिन खिड़कियाँ बंद रखें और अपडेट की प्रतीक्षा करें."
        ),
        "steps": {
            "HIGH": ["तुरंत सुरक्षित स्थान पर जाएँ", "खिड़की, गैस, एसी बंद", "दस्तावेज़, दवा, पानी, फ़ोन", "प्रशासन के निर्देश मानें"],
            "MEDIUM": ["आपातकालीन बैग तैयार", "बच्चे और बुज़ुर्ग अंदर", "दो निकास मार्ग तय करें", "अगले 15 मिनट के अपडेट"],
            "LOW": ["अभी कोई कार्रवाई नहीं", "धुएँ वाले दिन खिड़की बंद", "धुआँ दिखे तो रिपोर्ट करें"],
        },
    },
}


def _local_impact_kn(c):
    if c["dist"] is None:
        return ""
    if c["eta"] is None:
        return f"ಬೆಂಕಿ {c['dist']} ಕಿ.ಮೀ ದೂರದಲ್ಲಿದೆ."
    if c["eta"] <= 0:
        return f"ಬೆಂಕಿ {c['dist']} ಕಿ.ಮೀ ದೂರದಲ್ಲಿದೆ, ಈಗಾಗಲೇ ನಿಮ್ಮ ವಲಯದ ಒಳಗೆ."
    return f"ಬೆಂಕಿ {c['dist']} ಕಿ.ಮೀ ದೂರದಲ್ಲಿದೆ, ಸುಮಾರು {c['eta']} ನಿಮಿಷದಲ್ಲಿ ನಿಮ್ಮ ಪ್ರದೇಶ ತಲುಪಬಹುದು."


def _local_impact_hi(c):
    if c["dist"] is None:
        return ""
    if c["eta"] is None:
        return f"आग {c['dist']} किमी दूर है."
    if c["eta"] <= 0:
        return f"आग {c['dist']} किमी दूर है और आपके दायरे के अंदर है."
    return f"आग {c['dist']} किमी दूर है और लगभग {c['eta']} मिनट में आपके क्षेत्र तक पहुँच सकती है."


LOCAL_IMPACT = {"kn": _local_impact_kn, "hi": _local_impact_hi}

VOICE_LANGS = [
    {"code": copy["code"], "bcp47": copy["bcp47"], "name": copy["name"]}
    for copy in ALERT_COPY.values()
]


def alert_text(lang="en", severity="LOW", score=0, impact_data=None):
    """The text read aloud by speech synthesis or an outbound call.

    Hand-written Kannada and Hindi, not machine translation. Mirrors alertText()
    in risk-core.js.
    """
    copy = ALERT_COPY.get(lang) or ALERT_COPY["en"]
    sev = severity if severity in ("HIGH", "MEDIUM", "LOW") else "LOW"
    ctx = {
        "score": int(math.floor((score or 0) + 0.5)),
        "dist": (impact_data or {}).get("distance_km"),
        "eta": (impact_data or {}).get("eta_minutes"),
        "relation": (impact_data or {}).get("relation"),
        "impact": (impact_data or {}).get("text") or "",
    }
    ctx["moving"] = copy["moving"](ctx)
    if copy["code"] in LOCAL_IMPACT:
        ctx["impact"] = LOCAL_IMPACT[copy["code"]](ctx)
    body = re.sub(r"\s+", " ", copy[sev](ctx)).strip()
    body = re.sub(r"\.(\s*\.)+", ".", body).strip()
    return {
        "lang": copy["code"],
        "bcp47": copy["bcp47"],
        "name": copy["name"],
        "label": "text-to-speech broadcast",
        "text": body,
        "ident": copy["ident"],
        "voice_script": f"{copy['ident']} {body}".strip(),
        "steps": copy["steps"][sev],
    }


# ------------------------------------------------------ routine windows ----
ROUTINE = [
    {"key": "commute", "label": "Morning commute", "from": 7, "to": 10},
    {"key": "school", "label": "School pickup", "from": 14, "to": 17},
    {"key": "return", "label": "Evening return", "from": 17, "to": 20},
]


def routine_windows(timeline=None):
    """Commute and routine windows read off the 12-hour forecast timeline."""
    timeline = timeline or []

    def hour_of(value):
        text = str(value or "")[11:13]
        return int(text) if text.isdigit() else None

    rows = []
    for window in ROUTINE:
        points = [
            point
            for point in timeline
            if hour_of(point.get("time")) is not None
            and window["from"] <= hour_of(point.get("time")) < window["to"]
        ]
        if not points:
            rows.append(
                {
                    "key": window["key"],
                    "label": window["label"],
                    "available": False,
                    "status": "beyond horizon",
                    "peak": None,
                    "band": None,
                    "peak_at": None,
                    "advice": f"Outside the {len(timeline)} h forecast",
                }
            )
            continue
        peak = max(points, key=lambda point: point["score"])
        at = str(peak.get("time") or "")[11:16]
        if peak["band"] == "HIGH":
            status = "disrupted"
            advice = (
                f"Disrupted - risk reaches HIGH ({peak['score']}/100) by {at}. "
                "Move this window or take an alternate route."
            )
        elif peak["band"] == "MEDIUM":
            status = "watch"
            advice = f"Travel possible - risk peaks at {peak['score']}/100 by {at}."
        else:
            status = "clear"
            advice = f"Clear - risk stays at {peak['score']}/100."
        rows.append(
            {
                "key": window["key"],
                "label": window["label"],
                "available": True,
                "status": status,
                "peak": peak["score"],
                "band": peak["band"],
                "peak_at": at,
                "advice": advice,
            }
        )
    return rows


if __name__ == "__main__":
    sample = {
        "ffmc": 92.0,
        "isi": 10.0,
        "wind_kmh": 28,
        "rh": 24,
        "heating_rate_c_h": 1.8,
        "slope_pct": 12,
        "aspect_deg": 180,
        "wind_dir_deg": 20,
        "fuel_class": "grass",
        "fire_distance_km": 1.6,
        "alignment": 0.9,
    }
    print(json.dumps(assess(sample), indent=2)[:600])
