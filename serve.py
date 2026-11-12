#!/usr/bin/python3
"""Garuda - single-origin server for local preview.

Serves the same public assets the Worker hosts (deploy/public) and proxies the
engine routes to the local Flask engine on 127.0.0.1:5000, so the browser only
talks to one origin. "/" is the landing page, "/dashboard" is the dashboard.

Usage: python3 serve.py [port]   (default 3001)
"""

import http.server
import json
import os
import socketserver
import sys
import urllib.error
import urllib.request

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 3001
BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(BASE, "deploy", "public")
ENGINE = "http://127.0.0.1:5000"

# Routes the Flask engine owns. /config.json and /backtest are served here so the
# preview works even when the engine is not running.
PROXY_PATHS = (
    "/status",
    "/history",
    "/simulate",
    "/fires.geojson",
    "/weather.json",
    "/reports",
    "/checkin",
    "/voice",
)
PAGE_ALIASES = {"/dashboard": "/dashboard.html", "/dashboard/": "/dashboard.html"}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _write(self, status, body, ctype="application/json"):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass

    def _path(self):
        return self.path.split("?")[0]

    def _is_proxy(self):
        path = self._path()
        return any(path == prefix or path.startswith(prefix + "/") for prefix in PROXY_PATHS)

    def _proxy(self, method):
        data = None
        if method == "POST":
            length = int(self.headers.get("Content-Length") or 0)
            data = self.rfile.read(length) if length else b""
        headers = {}
        if self.headers.get("Content-Type"):
            headers["Content-Type"] = self.headers["Content-Type"]
        req = urllib.request.Request(ENGINE + self.path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=25) as resp:
                self._write(resp.status, resp.read())
        except urllib.error.HTTPError as exc:
            self._write(exc.code, exc.read())
        except Exception as exc:  # engine down or unreachable
            msg = '{"error": "%s"}' % str(exc).replace('"', "'")
            self._write(502, msg.encode("utf-8"))

    def _local_config(self):
        with open(os.path.join(BASE, "config.json")) as handle:
            cfg = json.load(handle)
        payload = {
            "centre": cfg["centre"],
            "geofence_km": cfg["geofence_km"],
            "watch_km": cfg["watch_km"],
            "thresholds": cfg["thresholds"],
            "fuel_class": cfg["fuel_class"],
            "cycle_minutes": cfg["cycle_minutes"],
            "cesium_ion_token": os.environ.get("CESIUM_ION_TOKEN") or None,
            "firms_configured": bool(os.environ.get("FIRMS_MAP_KEY")),
            "channels_configured": bool(os.environ.get("DISCORD_WEBHOOK_URL")),
        }
        self._write(200, json.dumps(payload).encode("utf-8"))

    def _local_backtest(self):
        path = os.path.join(ROOT, "backtest.json")
        if os.path.exists(path):
            with open(path, "rb") as handle:
                self._write(200, handle.read())
        else:
            self._write(
                501,
                json.dumps(
                    {"status": "unavailable", "reason": "Run backtest.py with FIRMS_MAP_KEY set."}
                ).encode("utf-8"),
            )

    def do_GET(self):
        path = self._path()
        if self._is_proxy():
            return self._proxy("GET")
        if path == "/config.json":
            return self._local_config()
        if path == "/backtest":
            return self._local_backtest()
        if path in PAGE_ALIASES:
            self.path = PAGE_ALIASES[path]
        return super().do_GET()

    def do_POST(self):
        if self._is_proxy():
            return self._proxy("POST")
        self._write(404, b'{"error": "not found"}')


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    with Server(("0.0.0.0", PORT), Handler) as httpd:
        print("Garuda preview on http://0.0.0.0:%d  (engine -> %s)" % (PORT, ENGINE))
        print("  /           landing")
        print("  /dashboard  dashboard")
        httpd.serve_forever()
