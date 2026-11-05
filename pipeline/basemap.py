"""A light vector base map (roads, rivers, parks, rail) from OpenStreetMap.

Source: OpenStreetMap contributors via the Overpass API (ODbL).
The site draws this when it cannot load map tiles, for example in a sandboxed
preview. Coordinates are rounded to 5 decimal places (about 1 m).
"""

from .common import SITE_DATA, pilot_bbox, session, write_json

OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]

ROAD_CLASS = {
    "motorway": "major", "trunk": "major", "primary": "major",
    "secondary": "mid", "tertiary": "mid",
    "residential": "minor", "unclassified": "minor", "living_street": "minor",
    "motorway_link": "major", "trunk_link": "major", "primary_link": "major",
    "secondary_link": "mid", "tertiary_link": "mid",
}


def query(bbox):
    s, w, n, e = bbox
    b = f"({s},{w},{n},{e})"
    return f"""
[out:json][timeout:180];
(
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"]{b};
  way["railway"="rail"]{b};
  way["waterway"~"^(river|canal)$"]{b};
  way["natural"="water"]{b};
  way["leisure"~"^(park|golf_course|nature_reserve|recreation_ground)$"]{b};
  way["landuse"~"^(grass|meadow|forest|recreation_ground|cemetery)$"]{b};
  way["natural"="wood"]{b};
);
out geom;
"""


def run():
    bbox = pilot_bbox(0.01)
    data = None
    for url in OVERPASS:
        r = session.post(url, data={"data": query(bbox)}, timeout=300)
        if r.status_code == 200:
            data = r.json()
            break
        print(f"  {url}: HTTP {r.status_code}")
    if not data:
        raise RuntimeError("Overpass API unavailable")
    out = {"major": [], "mid": [], "minor": [], "rail": [], "river": [], "water": [], "green": []}
    names = {}
    for el in data.get("elements", []):
        geom = el.get("geometry")
        if not geom or len(geom) < 2:
            continue
        flat = [round(v, 5) for p in geom for v in (p["lat"], p["lon"])]
        t = el.get("tags", {})
        if "highway" in t:
            cls = ROAD_CLASS.get(t["highway"])
            if cls:
                out[cls].append(flat)
                if cls == "major" and t.get("ref"):
                    names.setdefault(t["ref"], flat[:2])
        elif t.get("railway") == "rail":
            out["rail"].append(flat)
        elif t.get("waterway"):
            out["river"].append(flat)
        elif t.get("natural") == "water":
            out["water"].append(flat)
        else:
            out["green"].append(flat)
    print("  " + ", ".join(f"{k}: {len(v)}" for k, v in out.items()))
    write_json(SITE_DATA / "basemap.json", {
        "source": "OpenStreetMap contributors",
        "licence": "ODbL",
        "bbox": bbox,
        "layers": out,
    })


if __name__ == "__main__":
    run()
