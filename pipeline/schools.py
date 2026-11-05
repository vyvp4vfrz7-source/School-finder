"""Download the DfE Get Information about Schools (GIAS) register and keep every open
school in England.

Writes data/raw/schools_england.json (all of England, used by the tiles step) and
data/cache/pilot_schools.json (the catchment pilot councils, used by the pilot steps).

Source: https://get-information-schools.service.gov.uk/Downloads (Open Government Licence)
"""

import csv
import datetime as dt
import io
import json
import re
import time
import zipfile

from pyproj import Transformer

from .common import LAS, PILOT_SCHOOLS, RAW, get, session, write_json

GIAS = "https://get-information-schools.service.gov.uk"
GIAS_FILE = "https://ea-edubase-api-prod.azurewebsites.net/edubase/downloads/File.xhtml?id={id}"

to_wgs84 = Transformer.from_crs("EPSG:27700", "EPSG:4326", always_xy=True)


def download():
    """GIAS builds the full extract on request: read the form token, ask for the
    'all establishment data' file, wait for it, then fetch the ZIP."""
    page = get(f"{GIAS}/Downloads", timeout=120).text
    token = re.search(r'name="__RequestVerificationToken"[^>]*value="([^"]+)"', page, re.I)
    gen = re.search(r'id="Downloads_0__FileGeneratedDate"[^>]*value="([^"]+)"', page, re.I) \
        or re.search(r'value="([^"]+)"[^>]*id="Downloads_0__FileGeneratedDate"', page, re.I)
    if not token or not gen:
        raise RuntimeError("GIAS Downloads page changed: token or file date not found")
    r = session.post(f"{GIAS}/Downloads/Collate", data={
        "__RequestVerificationToken": token.group(1),
        "Downloads[0].Tag": "all.edubase.data",
        "Downloads[0].FileGeneratedDate": gen.group(1),
        "Downloads[0].Selected": "true",
    }, timeout=120, allow_redirects=True)
    m = re.search(r"/Downloads/Generated/([0-9a-fA-F-]{36})", r.url) \
        or re.search(r"/Downloads/Generated/([0-9a-fA-F-]{36})", r.text)
    if not m:
        raise RuntimeError(f"GIAS did not return a generation id (HTTP {r.status_code})")
    gid = m.group(1)
    for _ in range(150):
        p = get(f"{GIAS}/Downloads/GenerateAjax/{gid}", headers={"X-Requested-With": "XMLHttpRequest"})
        data = p.json()
        if isinstance(data, str):
            data = json.loads(data)
        if data.get("status") is True:
            break
        time.sleep(2)
    else:
        raise RuntimeError("GIAS file generation timed out")
    z = get(GIAS_FILE.format(id=gid), timeout=600).content
    if z[:2] != b"PK":
        raise RuntimeError("GIAS download was not a ZIP file")
    with zipfile.ZipFile(io.BytesIO(z)) as zf:
        name = next(n for n in zf.namelist() if n.lower().endswith(".csv"))
        raw = zf.read(name)
    RAW.mkdir(parents=True, exist_ok=True)
    (RAW / "gias.csv").write_bytes(raw)
    stamp = re.sub(r"\D", "", name)[-8:] or dt.date.today().strftime("%Y%m%d")
    print(f"  GIAS file {name}: {len(raw) // 1_000_000} MB")
    return raw.decode("cp1252", errors="replace"), stamp


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
    skipped_wales = 0
    for row in reader:
        if not row["EstablishmentStatus (name)"].startswith("Open"):
            continue
        group = row["EstablishmentTypeGroup (name)"]
        if group in ("Children's centres", "Online provider", "Other types", "Welsh schools"):
            continue
        # GIAS also lists some Welsh establishments; this site covers England only.
        if (row.get("GOR (name)") or "").startswith("Wales") or \
                "welsh" in (row.get("TypeOfEstablishment (name)") or "").lower():
            skipped_wales += 1
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
            "la": (row.get("LA (name)") or "").strip(),
            "laCode": row["LA (code)"],
            "town": clean(row.get("Town")),
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
    no_loc = sum(1 for s in out if s["lat"] is None)
    print(f"  {len(out)} open schools in England ({no_loc} without a location; {skipped_wales} Welsh rows skipped)")
    meta = {
        "source": "DfE Get Information about Schools",
        "sourceUrl": "https://get-information-schools.service.gov.uk/",
        "fileDate": stamp,
    }
    write_json(RAW / "schools_england.json", {**meta, "schools": out})
    pilot = [s for s in out if s["laCode"] in LAS]
    print(f"  {len(pilot)} of them in the catchment pilot councils")
    write_json(PILOT_SCHOOLS, {**meta, "schools": pilot})


def _is_num(v):
    try:
        float(v)
        return True
    except (TypeError, ValueError):
        return False


if __name__ == "__main__":
    run()
