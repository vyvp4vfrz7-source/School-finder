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

# Catchment pilot: local authority codes used by DfE and GIAS. Schools, results and
# Ofsted cover all of England; catchments, the offline base map and the precomputed
# crime and price files (used when live lookups are unavailable) cover only these.
LAS = {
    "319": "Sutton",
    "314": "Kingston upon Thames",
}
# Land Registry "district" values for the same areas.
LR_DISTRICTS = {"SUTTON", "KINGSTON UPON THAMES"}

USER_AGENT = "school-finder/0.2 (+https://github.com/vyvp4vfrz7-source/school-finder)"

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


def write_json(path, obj, quiet=False):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    if not quiet:
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


# National school data is split into square map tiles so the site only loads the
# area being looked at. 0.25 degrees is roughly 28 km north-south by 17 km east-west.
TILE_DEG = 0.25


def tile_key(lat, lon):
    return f"{math.floor(lat / TILE_DEG)}_{math.floor(lon / TILE_DEG)}"


PILOT_SCHOOLS = CACHE / "pilot_schools.json"


def pilot_bbox(pad_deg=0.01):
    """Bounding box (south, west, north, east) around all pilot schools."""
    schools = read_json(PILOT_SCHOOLS)
    if not schools:
        # Fallback box roughly covering Kingston and Sutton.
        return (51.318, -0.335, 51.442, -0.105)
    lats = [s["lat"] for s in schools["schools"] if s.get("lat")]
    lons = [s["lon"] for s in schools["schools"] if s.get("lon")]
    return (min(lats) - pad_deg, min(lons) - pad_deg, max(lats) + pad_deg, max(lons) + pad_deg)


def env(name):
    v = os.environ.get(name, "").strip()
    return v or None


def distM_box(lat, lon, radius_m):
    """(south, west, north, east) of a square that contains a circle of radius_m."""
    dlat = radius_m / 111320.0
    dlon = radius_m / (111320.0 * math.cos(math.radians(lat)))
    return (lat - dlat, lon - dlon, lat + dlat, lon + dlon)
