"""Join schools, results and Ofsted for all of England and split them into map tiles.

Reads data/raw/{schools,results,ofsted}_england.json (written by the earlier steps) and
writes:
  site/data/index.json        which tiles exist, data dates and labels
  site/data/tiles/<key>.json  schools in one 0.25 degree square, with their results and Ofsted
  site/data/search.json       name, town and location of every school, for search by name
The site loads only the tiles in view, so a phone never downloads all of England.
"""

import shutil

from .common import RAW, SITE_DATA, TILE_DEG, read_json, tile_key, write_json

PHASE_CODES = {"primary": "p", "secondary": "s", "all-through": "a", "sixth-form": "6", "nursery": "n"}


def previous_ofsted():
    """Ofsted outcomes from the tiles already published, used if the Ofsted step failed."""
    index = read_json(SITE_DATA / "index.json") or {}
    out = {"schools": {}, "labels": index.get("ofstedLabels", {}),
           "files": (index.get("fileDates") or {}).get("ofsted", [])}
    for key in index.get("tiles", {}):
        t = read_json(SITE_DATA / "tiles" / f"{key}.json") or {}
        out["schools"].update(t.get("ofsted", {}))
    return out


def run():
    schools = read_json(RAW / "schools_england.json")
    if not schools:
        raise RuntimeError("Run the schools step first")
    results = read_json(RAW / "results_england.json") or {}
    ofsted = read_json(RAW / "ofsted_england.json") or {}
    if not results:
        # Keep the published tiles rather than replace them with ones missing results.
        raise RuntimeError("No results file: run the results step first")
    if not ofsted:
        ofsted = previous_ofsted()
        print(f"  WARNING: no new Ofsted file; reusing {len(ofsted['schools'])} published outcomes")

    tiles = {}
    search = []
    for s in schools["schools"]:
        if s["lat"] is None:
            continue
        key = tile_key(s["lat"], s["lon"])
        t = tiles.setdefault(key, {"schools": [], "ks2": {}, "ks4": {}, "ks5": {}, "ofsted": {}})
        t["schools"].append(s)
        u = str(s["urn"])
        for ks in ("ks2", "ks4", "ks5"):
            if u in results.get(ks, {}):
                t[ks][u] = results[ks][u]
        if u in ofsted.get("schools", {}):
            t["ofsted"][u] = ofsted["schools"][u]
        search.append([s["urn"], s["name"], s.get("town") or s["la"], PHASE_CODES.get(s["phase"], "s"),
                       s["lat"], s["lon"], 1 if s["independent"] else 0])

    out_dir = SITE_DATA / "tiles"
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)
    for key, t in tiles.items():
        write_json(out_dir / f"{key}.json", t, quiet=True)
    print(f"  {len(tiles)} tiles, {len(search)} schools")
    write_json(SITE_DATA / "search.json", {"fields": ["urn", "name", "town", "phase", "lat", "lon", "indep"],
                                           "rows": search})
    write_json(SITE_DATA / "index.json", {
        "coverage": "England",
        "tileDeg": TILE_DEG,
        "tiles": {k: len(t["schools"]) for k, t in sorted(tiles.items())},
        "schools": len(search),
        "fileDates": {
            "schools": schools.get("fileDate"),
            "ofsted": ofsted.get("files", []),
        },
        "years": results.get("years", {}),
        "ofstedLabels": ofsted.get("labels", {}),
        "counts": {
            "ks2": len(results.get("ks2", {})), "ks4": len(results.get("ks4", {})),
            "ks5": len(results.get("ks5", {})), "ofsted": len(ofsted.get("schools", {})),
        },
    })


if __name__ == "__main__":
    run()
