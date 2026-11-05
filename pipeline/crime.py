"""Street-level crime from police.uk, summarised on a ~250 m grid.

Source: https://data.police.uk/docs/ (Open Government Licence)

Locations are already anonymised by police.uk (snapped to nearby points), so a
small grid is as precise as the data honestly allows. The site sums the cells
within a radius of a chosen point.
"""

import time

from .common import SITE_DATA, get, pilot_bbox, write_json

API = "https://data.police.uk/api"
MONTHS = 36           # about three years, which is all police.uk keeps
TILE_DEG = 0.012      # query tiles (~1.3 km); small enough to stay under 10,000 crimes
CELL_LAT = 0.00225    # ~250 m
CELL_LON = 0.0036     # ~250 m at London's latitude
RATE_GAP = 0.08       # stays well under 15 requests per second


def months():
    r = get(f"{API}/crimes-street-dates")
    r.raise_for_status()
    dates = sorted({d["date"] for d in r.json()}, reverse=True)
    return sorted(dates[:MONTHS])


def tiles(bbox):
    s, w, n, e = bbox
    lat = s
    while lat < n:
        lon = w
        while lon < e:
            yield (lat, lon, min(lat + TILE_DEG, n), min(lon + TILE_DEG, e))
            lon += TILE_DEG
        lat += TILE_DEG


def fetch_tile(t, month):
    s, w, n, e = t
    poly = f"{s},{w}:{s},{e}:{n},{e}:{n},{w}"
    r = get(f"{API}/crimes-street/all-crime", params={"poly": poly, "date": month})
    time.sleep(RATE_GAP)
    if r.status_code == 503:
        # Too many crimes in one tile: split into four.
        mlat, mlon = (s + n) / 2, (w + e) / 2
        out = []
        for q in ((s, w, mlat, mlon), (s, mlon, mlat, e), (mlat, w, n, mlon), (mlat, mlon, n, e)):
            out += fetch_tile(q, month)
        return out
    if r.status_code != 200:
        print(f"    {month} tile {t}: HTTP {r.status_code}")
        return []
    return r.json()


def run():
    bbox = pilot_bbox(0.012)
    s, w, _, _ = bbox
    ms = months()
    print(f"  crime months {ms[0]} to {ms[-1]}, bbox {bbox}")
    cats, cells, seen = [], {}, set()
    tile_list = list(tiles(bbox))
    for mi, month in enumerate(ms):
        count = 0
        for t in tile_list:
            for c in fetch_tile(t, month):
                cid = c.get("persistent_id") or f"{c.get('id')}"
                if cid in seen:
                    continue
                seen.add(cid)
                try:
                    lat = float(c["location"]["latitude"])
                    lon = float(c["location"]["longitude"])
                except (KeyError, TypeError, ValueError):
                    continue
                cat = c.get("category", "other-crime")
                if cat not in cats:
                    cats.append(cat)
                key = f"{int((lat - s) / CELL_LAT)},{int((lon - w) / CELL_LON)}"
                cell = cells.setdefault(key, {"m": [0] * len(ms), "c": {}})
                cell["m"][mi] += 1
                if mi >= len(ms) - 12:  # categories for the latest 12 months
                    cell["c"][cat] = cell["c"].get(cat, 0) + 1
                count += 1
        print(f"    {month}: {count} crimes")
    # Store categories as arrays to keep the file small.
    packed = {}
    for key, cell in cells.items():
        packed[key] = [cell["m"], [cell["c"].get(cat, 0) for cat in cats]]
    write_json(SITE_DATA / "crime.json", {
        "source": "police.uk",
        "sourceUrl": "https://data.police.uk/",
        "origin": [s, w],
        "cell": [CELL_LAT, CELL_LON],
        "months": ms,
        "categories": cats,
        "cells": packed,
    })


if __name__ == "__main__":
    run()
