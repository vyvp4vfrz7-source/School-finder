"""Turn the hand-collected "last distance offered" figures into catchment data
for the site.

Input:  data/manual/catchments.csv and data/manual/catchment_sources.csv
Output: site/data/catchments.json, keyed by school URN.

To add a year or a school, add rows to the CSV and re-run the pipeline.
"""

import csv
import difflib
import re
import sys

from .common import MANUAL, PILOT_SCHOOLS, SITE_DATA, read_json, write_json


def norm(name):
    n = name.lower().replace("&", "and").replace("'", "").replace("’", "")
    n = re.sub(r"[^a-z0-9 ]", " ", n)
    n = re.sub(r"\b(the|school|academy|high|for|of)\b", " ", n)
    return re.sub(r"\s+", " ", n).strip()


def match(name, la, schools, phases=None):
    pool = [s for s in schools if s["la"] == la] or schools
    if phases:
        pool = [s for s in pool if s["phase"] in phases]
    by_norm = {}
    for s in pool:
        by_norm.setdefault(norm(s["name"]), s)
    key = norm(name)
    if key in by_norm:
        return by_norm[key]
    close = difflib.get_close_matches(key, list(by_norm), n=1, cutoff=0.75)
    return by_norm[close[0]] if close else None


def run():
    schools = read_json(PILOT_SCHOOLS)["schools"]
    with open(MANUAL / "catchment_sources.csv", encoding="utf-8") as f:
        sources = {r["id"]: r for r in csv.DictReader(f)}
    with open(MANUAL / "catchments.csv", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    out, unmatched = {}, set()
    for r in rows:
        s = match(r["school"], r["la"], schools, phases=("secondary", "all-through"))
        if not s:
            unmatched.add(f"{r['school']} ({r['la']})")
            continue
        origin_name = (r.get("measured_from") or "").strip()
        if origin_name:
            o = match(origin_name, r["la"], schools) or match(origin_name, "", schools)
            if not o:
                unmatched.add(f"{origin_name} (measuring point)")
                continue
            origin = {"name": o["name"], "lat": o["lat"], "lon": o["lon"]}
            label = f"Places measured from {o['name']}"
        else:
            origin = {"name": s["name"], "lat": s["lat"], "lon": s["lon"]}
            label = "Distance places"
        entry = out.setdefault(str(s["urn"]), {"name": s["name"], "series": []})
        series = next((x for x in entry["series"] if x["label"] == label), None)
        if not series:
            series = {"label": label, "from": origin, "years": []}
            entry["series"].append(series)
        dist = r["distance_m"].strip()
        series["years"].append({
            "year": int(r["year"]),
            "distance": int(dist) if dist else None,
            "status": r["status"],
            "note": r["notes"] or None,
            "source": r["source"],
        })

    for entry in out.values():
        for series in entry["series"]:
            series["years"].sort(key=lambda y: y["year"])
            ds = [y for y in series["years"] if y["distance"]]
            if len(ds) >= 2:
                series["trend"] = ds[-1]["distance"] - ds[0]["distance"]
        # Put the school's own distance series first.
        entry["series"].sort(key=lambda x: x["label"] != "Distance places")

    if unmatched:
        print("  Could not match these names to the GIAS register:")
        for u in sorted(unmatched):
            print(f"    - {u}")
        print("  Fix the name in data/manual/catchments.csv to match GIAS.")
    print(f"  catchment data for {len(out)} schools")
    write_json(SITE_DATA / "catchments.json", {
        "note": "Hand-collected from council admissions publications. Distances are straight-line "
                "metres from the school (or the stated measuring point) to the home of the last child "
                "offered a place under the distance criterion.",
        "sources": sources,
        "schools": out,
    })
    return 1 if unmatched else 0


if __name__ == "__main__":
    sys.exit(run())
