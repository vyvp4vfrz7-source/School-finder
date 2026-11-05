"""Mobile coverage by postcode from the Ofcom Connected Nations API.

Source: https://api.ofcom.org.uk/ (free subscription key needed)
Set the OFCOM_API_KEY secret in the GitHub repository to enable this step.
Ofcom's figures are predicted coverage per operator, not measured speeds.

Results are cached in data/cache/coverage.json so each run only fetches
postcodes it has not seen, staying inside the API's rate limits.
"""

import time

from .common import CACHE, SITE_DATA, env, get, read_json, write_json

BASES = ["https://api.ofcom.org.uk", "https://api-proxy.ofcom.org.uk"]
PER_RUN = 1500
GAP = 1.0  # seconds between calls


def fetch(postcode, key):
    pc = postcode.replace(" ", "")
    for base in BASES:
        r = get(f"{base}/mobile/coverage/{pc}", headers={"Ocp-Apim-Subscription-Key": key})
        if r.status_code == 200:
            return r.json()
        if r.status_code in (401, 403):
            print(f"    Ofcom API refused the key at {base} (HTTP {r.status_code})")
        elif r.status_code == 404:
            return {}
    return None


def summarise(payload):
    """Average each numeric coverage field over the addresses in the postcode."""
    rows = payload.get("Availability") or payload.get("availability") or []
    sums, counts = {}, {}
    for row in rows:
        for k, v in row.items():
            if isinstance(v, (int, float)) and any(t in k for t in ("4G", "5G", "Voice", "Data", "3G")):
                sums[k] = sums.get(k, 0) + v
                counts[k] = counts.get(k, 0) + 1
    return {k: round(sums[k] / counts[k], 2) for k in sums}


def run():
    key = env("OFCOM_API_KEY")
    cache = read_json(CACHE / "coverage.json", {})
    if key:
        sales = read_json(SITE_DATA / "sales.json", {"rows": []})
        postcodes = sorted({r[8] for r in sales["rows"]} - set(cache))
        print(f"  {len(postcodes)} postcodes without coverage; fetching up to {PER_RUN}")
        for pc in postcodes[:PER_RUN]:
            payload = fetch(pc, key)
            if payload is None:
                break  # key refused or API down; keep what we have
            cache[pc] = summarise(payload) if payload else {}
            time.sleep(GAP)
        write_json(CACHE / "coverage.json", cache)
    else:
        print("  OFCOM_API_KEY not set; using cached coverage only")
    if not cache:
        return
    pcs = read_json(CACHE / "postcodes.json", {})
    fields = sorted({k for v in cache.values() for k in v})
    out = {}
    for pc, vals in cache.items():
        if vals and pcs.get(pc):
            out[pc] = pcs[pc] + [vals.get(f) for f in fields]
    write_json(SITE_DATA / "coverage.json", {
        "source": "Ofcom Connected Nations (predicted coverage)",
        "sourceUrl": "https://www.ofcom.org.uk/phones-and-broadband/coverage-and-speeds",
        "fields": fields,
        "postcodes": out,
    })


if __name__ == "__main__":
    run()
