"""Check that the sources the site queries live from the visitor's browser still answer,
and still allow cross-site requests (CORS). Prints a report; fails if one is down.

The site calls these directly, with no server of our own in between:
  postcodes.io    postcode and nearby-postcode lookups
  police.uk       street-level crime around a point
  Land Registry   sold prices for a list of postcodes (SPARQL endpoint)
"""

from .common import session

ORIGIN = "https://vyvp4vfrz7-source.github.io"
SPARQL = "https://landregistry.data.gov.uk/landregistry/query"
QUERY = """PREFIX lrppi: <http://landregistry.data.gov.uk/def/ppi/>
PREFIX lrcommon: <http://landregistry.data.gov.uk/def/common/>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT ?pc ?price ?date ?type WHERE {
  VALUES ?pc { "KT3 3NU"^^xsd:string "SM2 6AA"^^xsd:string }
  ?addr lrcommon:postcode ?pc .
  ?tx lrppi:propertyAddress ?addr ; lrppi:pricePaid ?price ;
      lrppi:transactionDate ?date ; lrppi:propertyType ?type .
} ORDER BY DESC(?date) LIMIT 5"""

CHECKS = [
    ("postcodes.io", "GET", "https://api.postcodes.io/postcodes?lon=-0.24&lat=51.39&radius=500&limit=100", None),
    ("police.uk", "GET", "https://data.police.uk/api/crimes-street/all-crime?poly=51.385,-0.245:51.385,-0.235:51.395,-0.235:51.395,-0.245", None),
    ("Land Registry SPARQL", "POST", SPARQL, {"query": QUERY}),
]


def run():
    bad = 0
    for name, method, url, data in CHECKS:
        headers = {"Origin": ORIGIN, "Accept": "application/sparql-results+json, application/json"}
        try:
            r = session.request(method, url, data=data, headers=headers, timeout=60)
        except Exception as e:  # noqa: BLE001
            print(f"  {name}: FAILED {e}")
            bad += 1
            continue
        cors = r.headers.get("Access-Control-Allow-Origin")
        size = len(r.content)
        sample = r.text[:300].replace("\n", " ")
        ok = r.status_code == 200 and cors in ("*", ORIGIN)
        print(f"  {name}: HTTP {r.status_code}, CORS {cors!r}, {size} bytes {'OK' if ok else 'PROBLEM'}")
        print(f"    {sample}")
        # Preflight, in case the browser sends one.
        try:
            p = session.options(url.split("?")[0], headers={
                "Origin": ORIGIN, "Access-Control-Request-Method": method,
                "Access-Control-Request-Headers": "accept, content-type"}, timeout=30)
            print(f"    preflight: HTTP {p.status_code}, allow-origin {p.headers.get('Access-Control-Allow-Origin')!r}, "
                  f"allow-headers {p.headers.get('Access-Control-Allow-Headers')!r}")
        except Exception as e:  # noqa: BLE001
            print(f"    preflight failed: {e}")
        bad += 0 if ok else 1
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(run())
