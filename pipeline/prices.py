"""Sold house prices from HM Land Registry Price Paid Data, geocoded by postcode.

Source: https://www.gov.uk/government/statistical-data-sets/price-paid-data-downloads
Contains HM Land Registry data (c) Crown copyright and database right. Open Government Licence.
Postcode locations from postcodes.io (ONS Postcode Directory, Open Government Licence).
"""

import csv
import datetime as dt
import io

from .common import CACHE, LR_DISTRICTS, SITE_DATA, read_json, session, write_json

PP_URL = "http://prod.publicdata.landregistry.gov.uk.s3-website-eu-west-1.amazonaws.com/pp-{year}.csv"
YEARS_BACK = 5
TYPES = {"D": "Detached", "S": "Semi-detached", "T": "Terraced", "F": "Flat", "O": "Other"}


def stream_year(year):
    url = PP_URL.format(year=year)
    with session.get(url, stream=True, timeout=600) as r:
        if r.status_code != 200:
            print(f"    pp-{year}.csv: HTTP {r.status_code}")
            return
        lines = (line.decode("utf-8", errors="replace") for line in r.iter_lines() if line)
        for row in csv.reader(lines):
            # id, price, date, postcode, type, new, tenure, PAON, SAON, street,
            # locality, town, district, county, category, record status
            if len(row) < 15 or row[12] not in LR_DISTRICTS or row[14] != "A":
                continue
            yield row


def geocode(postcodes):
    cache = read_json(CACHE / "postcodes.json", {})
    todo = sorted(p for p in postcodes if p not in cache)
    print(f"    geocoding {len(todo)} new postcodes ({len(cache)} cached)")
    for i in range(0, len(todo), 100):
        batch = todo[i:i + 100]
        r = session.post("https://api.postcodes.io/postcodes", json={"postcodes": batch}, timeout=60)
        if r.status_code != 200:
            print(f"    postcodes.io HTTP {r.status_code}")
            continue
        for item in r.json().get("result", []):
            res = item.get("result")
            cache[item["query"]] = [round(res["latitude"], 5), round(res["longitude"], 5)] if res and res.get("latitude") else None
    write_json(CACHE / "postcodes.json", cache)
    return cache


def run():
    this_year = dt.date.today().year
    sales = []
    for year in range(this_year - YEARS_BACK, this_year + 1):
        n = 0
        for row in stream_year(year):
            sales.append(row)
            n += 1
        print(f"    {year}: {n} sales")
    where = geocode({r[3] for r in sales if r[3]})
    rows = []
    for r in sales:
        loc = where.get(r[3])
        if not loc:
            continue
        paon, saon, street = r[7].strip(), r[8].strip(), r[9].strip()
        addr = " ".join(p for p in (saon + "," if saon else "", paon, street.title()) if p)
        rows.append([loc[0], loc[1], int(r[1]), r[2][:10], r[4], 1 if r[5] == "Y" else 0,
                     r[6], addr, r[3]])
    rows.sort(key=lambda x: x[3], reverse=True)
    print(f"  {len(rows)} geocoded sales")
    write_json(SITE_DATA / "sales.json", {
        "source": "HM Land Registry Price Paid Data",
        "sourceUrl": "https://www.gov.uk/government/statistical-data-sets/price-paid-data-downloads",
        "attribution": "Contains HM Land Registry data (c) Crown copyright and database right 2026.",
        "fields": ["lat", "lon", "price", "date", "type", "newBuild", "tenure", "address", "postcode"],
        "types": TYPES,
        "rows": rows,
    })


if __name__ == "__main__":
    run()
