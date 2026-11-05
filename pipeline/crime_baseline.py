"""A national yardstick for the live crime card.

The site asks police.uk for crimes around a postcode while the visitor waits, so no crime
data is copied for England. To say whether a count is high or low, it needs to know what
is normal: this step samples school neighbourhoods across England and stores the spread of
12-month crime counts within 500 m, in the same way the site counts them.

Source: https://data.police.uk/docs/ (Open Government Licence)
"""

import hashlib
import math
import time

from .common import RAW, SITE_DATA, distM_box, get, haversine_m, read_json, write_json

API = "https://data.police.uk/api"
RADIUS = 500
SAMPLE = 300
GAP = 0.1  # about 10 requests a second, under police.uk's 15 a second limit


def months(n=12):
    r = get(f"{API}/crimes-street-dates")
    r.raise_for_status()
    return sorted({d["date"] for d in r.json()}, reverse=True)[:n]


def count_around(lat, lon, month):
    s, w, n, e = distM_box(lat, lon, RADIUS)
    poly = f"{s},{w}:{s},{e}:{n},{e}:{n},{w}"
    r = get(f"{API}/crimes-street/all-crime", params={"poly": poly, "date": month})
    time.sleep(GAP)
    if r.status_code != 200:
        return None
    c = 0
    for x in r.json():
        try:
            if haversine_m(lat, lon, float(x["location"]["latitude"]), float(x["location"]["longitude"])) <= RADIUS:
                c += 1
        except (KeyError, TypeError, ValueError):
            pass
    return c


def run():
    schools = read_json(RAW / "schools_england.json")
    if not schools:
        raise RuntimeError("Run the schools step first")
    pool = [s for s in schools["schools"] if s["lat"] and not s["independent"] and not s["special"]
            and s["phase"] in ("primary", "secondary")]
    # A stable sample, so month-to-month changes reflect crime and not a new sample.
    pool.sort(key=lambda s: hashlib.md5(str(s["urn"]).encode()).hexdigest())
    sample = pool[:SAMPLE]
    ms = months()
    print(f"  sampling {len(sample)} school neighbourhoods, {ms[-1]} to {ms[0]}")
    totals = []
    for i, s in enumerate(sample):
        counts = [count_around(s["lat"], s["lon"], m) for m in ms]
        if any(c is None for c in counts):
            continue
        totals.append(sum(counts))
        if i % 50 == 49:
            print(f"    {i + 1} done")
    totals.sort()
    if len(totals) < 50:
        raise RuntimeError(f"only {len(totals)} usable samples")
    pct = [totals[min(len(totals) - 1, math.floor(p / 100 * len(totals)))] for p in range(0, 101, 5)]
    print(f"  median {pct[10]} crimes a year within {RADIUS} m (from {len(totals)} places)")
    write_json(SITE_DATA / "crime_baseline.json", {
        "source": "police.uk",
        "radius": RADIUS,
        "months": [ms[-1], ms[0]],
        "samples": len(totals),
        "percentiles": pct,  # 0th, 5th, ... 100th percentile of 12-month counts
    })


if __name__ == "__main__":
    run()
