#!/usr/bin/python3
"""Optional ML baseline (OFF by default, never drives alerts).

Fits a logistic regression on the daily features produced by backtest.py
against "was there a detection in the watch ring that day". Writes ml_model.json.

The dashboard labels this "ML baseline (experimental)" and config.ml.enabled
stays false unless you turn it on deliberately. Check your hackathon's rule on
model training before enabling it.
"""

import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
BACKTEST = os.path.join(HERE, "backtest.json")
OUT = os.path.join(HERE, "ml_model.json")

FEATURES = ["ffmc", "fwi", "wind_kmh", "rh"]


def main():
    if not os.path.exists(BACKTEST):
        print("backtest.json not found - run backtest.py with FIRMS_MAP_KEY first.")
        return 1

    data = json.load(open(BACKTEST))
    rows = [d for d in data.get("days", []) if all(d.get(f) is not None for f in FEATURES)]
    if len(rows) < 60:
        print(f"only {len(rows)} complete days - need at least 60 for a meaningful baseline.")
        return 1

    x = np.array([[d[f] for f in FEATURES] for d in rows], dtype=float)
    y = np.array([1.0 if d["fire"] else 0.0 for d in rows], dtype=float)

    mean = x.mean(axis=0)
    scale = x.std(axis=0)
    scale[scale == 0] = 1.0
    xz = (x - mean) / scale

    rng = np.random.default_rng(11)
    order = rng.permutation(len(y))
    split = int(len(y) * 0.8)
    train, test = order[:split], order[split:]

    w = np.zeros(xz.shape[1])
    b = 0.0
    for _ in range(3000):
        preds = 1 / (1 + np.exp(-(xz[train] @ w + b)))
        error = preds - y[train]
        w -= 0.6 * (xz[train].T @ error / len(train))
        b -= 0.6 * error.mean()

    def accuracy(idx):
        preds = 1 / (1 + np.exp(-(xz[idx] @ w + b)))
        return float(((preds >= 0.5) == y[idx]).mean())

    model = {
        "model": "logistic_regression_baseline",
        "enabled": False,
        "note": "Experimental. Off by default; never drives alerts unless config.ml.enabled is true.",
        "features": FEATURES,
        "mean": [round(float(v), 6) for v in mean],
        "scale": [round(float(v), 6) for v in scale],
        "weights": [round(float(v), 6) for v in w],
        "bias": round(float(b), 6),
        "metrics": {
            "train_accuracy": round(accuracy(train), 4),
            "test_accuracy": round(accuracy(test), 4),
            "samples": int(len(y)),
            "fire_days": int(y.sum()),
            "window": data.get("date_range"),
        },
    }
    with open(OUT, "w") as handle:
        json.dump(model, handle, indent=2)
    print(json.dumps(model["metrics"], indent=2))
    print("wrote ml_model.json (disabled by default)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
