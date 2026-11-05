"""Download the DfE Get Information about Schools (GIAS) register and keep open
schools in the pilot local authorities.

Source: https://get-information-schools.service.gov.uk/Downloads (Open Government Licence)
"""

import csv
import datetime as dt
import io

from pyproj import Transformer

from .common import LAS, RAW, SITE_DATA, get, write_json

GIAS_URL = "https://ea-edubasepublic-prod.azurewebsites.net/edubase/downloads/public/edubasealldata{date}.csv"

to_wgs84 = Transformer.from_crs("EPSG:27700", "EPSG:4326", always_xy=True)


def download():
    today = dt.date.today()
    for back in range(0, 10):
        d = (today - dt.timedelta(days=back)).strftime("%Y%m%d")
        url = GIAS_URL.format(date=d)
        r = get(url, timeout=300)
        if r.status_code == 200 and len(r.content) > 1_000_000:
            print(f"  GIAS file {d}: {len(r.content) // 1_000_000} MB")
            RAW.mkdir(parents=True, exist_ok=True)
            (RAW / "gias.csv").write_bytes(r.content)
            return r.content.decode("cp1252", errors="replace"), d
    raise RuntimeError("Could not download a GIAS file from the last 10 days")


def phase_group(row):
    phase = row["PhaseOfEducation (name)"]
    low = int(row["StatutoryLowAge"] or 0)
    high = int(row["StatutoryHighAge"] or 0)
    if phase in ("Nursery",):
        return "nursery"
    if phase in ("Primary", "Middle deemed primary"):
        return "primary"
    if phase in ("Secondary", "Middle deemed secondary"):
        return "secondary"
    if phase == "All-through":
        return "all-through"
    if phase == "16 plus":
        return "sixth-form"
    # "Not applicable" (often independent or special): guess from ages.
    if low <= 5 and high >= 15:
        return "all-through"
    if high <= 11:
        return "primary"
    if low >= 16:
        return "sixth-form"
    return "secondary"


def clean(v):
    v = (v or "").strip()
    return None if v in ("", "Not applicable", "Does not apply", "None", "Not collected") else v


def run():
    text, stamp = download()
    reader = csv.DictReader(io.StringIO(text))
    out = []
    for row in reader:
        if row["LA (code)"] not in LAS:
            continue
        if not row["EstablishmentStatus (name)"].startswith("Open"):
            continue
        group = row["EstablishmentTypeGroup (name)"]
        if group in ("Children's centres", "Online provider", "Other types"):
            continue
        try:
            e, n = float(row["Easting"]), float(row["Northing"])
            lon, lat = to_wgs84.transform(e, n)
        except (ValueError, KeyError):
            lat = lon = None
        address = ", ".join(
            p for p in (row.get("Street"), row.get("Locality"), row.get("Town")) if p and p.strip()
        )
        out.append({
            "urn": int(row["URN"]),
            "name": row["EstablishmentName"].strip(),
            "la": LAS[row["LA (code)"]],
            "phase": phase_group(row),
            "type": clean(row["TypeOfEstablishment (name)"]),
            "group": clean(group),
            "independent": group == "Independent schools",
            "special": "special" in (row["TypeOfEstablishment (name)"] or "").lower()
                       or group == "Special schools",
            "gender": clean(row["Gender (name)"]),
            "religion": clean(row["ReligiousCharacter (name)"]),
            "selective": (row.get("AdmissionsPolicy (name)") or "").strip() == "Selective",
            "sixthForm": (row.get("OfficialSixthForm (name)") or "").strip() == "Has a sixth form",
            "ages": [int(row["StatutoryLowAge"] or 0), int(row["StatutoryHighAge"] or 0)],
            "pupils": int(row["NumberOfPupils"]) if (row.get("NumberOfPupils") or "").isdigit() else None,
            "capacity": int(row["SchoolCapacity"]) if (row.get("SchoolCapacity") or "").isdigit() else None,
            "fsm": float(row["PercentageFSM"]) if _is_num(row.get("PercentageFSM")) else None,
            "address": address,
            "postcode": clean(row.get("Postcode")),
            "website": clean(row.get("SchoolWebsite")),
            "lat": round(lat, 6) if lat else None,
            "lon": round(lon, 6) if lon else None,
        })
    out.sort(key=lambda s: s["name"])
    print(f"  {len(out)} open schools in pilot area")
    write_json(SITE_DATA / "schools.json", {
        "source": "DfE Get Information about Schools",
        "sourceUrl": "https://get-information-schools.service.gov.uk/",
        "fileDate": stamp,
        "schools": out,
    })


def _is_num(v):
    try:
        float(v)
        return True
    except (TypeError, ValueError):
        return False


if __name__ == "__main__":
    run()
