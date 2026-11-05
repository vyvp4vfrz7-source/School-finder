"""Shared settings and helpers for the data pipeline."""

import json
import math
import os
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
SITE_DATA = ROOT / "site" / "data"
CACHE = ROOT / "data" / "cache"
MANUAL = ROOT / "data" / "manual"
RAW = ROOT / "data" / "raw"  # large downloads, not committed

# Pilot area: local authority codes used by DfE and GIAS.
LAS = {
    "319": "Sutton",
    "314": "Kingston upon Thames",
}
# Land Registry "district" values for the same areas.
LR_DISTRICTS = {"SUTTON", "KINGSTON UPON THAMES"}

USER_AGENT = "school-finder-pilot/0.1 (+https://github.com/vyvp4vfrz7-source/school-finder)"

session = requests.Session()
session.headers["User-Agent"] = USER_AGENT


def get(url, *, retries=4, timeout=60, **kwargs):
    """GET with retries and backoff. Returns the response (raises on final failure)."""
    last = None
    for attempt in range(retries):
        try:
            r = session.get(url, timeout=timeout, **kwargs)
            if r.status_code == 429 or r.status_code >= 500:
                last = RuntimeError(f"HTTP {r.status_code} for {url}")
                time.sleep(2 ** attempt)
                continue
            return r
        except requests.RequestException as e:  # network hiccup
            last = e
            time.sleep(2 ** attempt)
    raise last


def write_json(path, obj):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    print(f"  wrote {path.relative_to(ROOT)} ({path.stat().st_size // 1024} KB)")


def read_json(path, default=None):
    path = Path(path)
    if not path.exists():
        return default
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def haversine_m(lat1, lon1, lat2, lon2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def pilot_bbox(pad_deg=0.01):
    """Bounding box (south, west, north, east) around all pilot schools."""
    schools = read_json(SITE_DATA / "schools.json")
    if not schools:
        # Fallback box roughly covering Kingston and Sutton.
        return (51.318, -0.335, 51.442, -0.105)
    lats = [s["lat"] for s in schools["schools"] if s.get("lat")]
    lons = [s["lon"] for s in schools["schools"] if s.get("lon")]
    return (min(lats) - pad_deg, min(lons) - pad_deg, max(lats) + pad_deg, max(lons) + pad_deg)


def env(name):
    v = os.environ.get(name, "").strip()
    return v or None
