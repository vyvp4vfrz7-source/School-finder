"""GCSE (key stage 4) and A-level (16 to 18) results by school, several years.

Source: DfE Explore Education Statistics (Open Government Licence)
  https://explore-education-statistics.service.gov.uk/find-statistics/key-stage-4-performance
  https://explore-education-statistics.service.gov.uk/find-statistics/a-level-and-other-16-to-18-results

The DfE "Compare school and college performance" site is being phased out, so
this reads the institution-level files published with each statistics release.
"""

import csv
import io
import re
import zipfile

from .common import RAW, SITE_DATA, get, read_json, write_json

CONTENT_API = "https://content.explore-education-statistics.service.gov.uk/api"

KS4 = {
    "publication": "key-stage-4-performance",
    # Exams were cancelled in 2020 and 2021, so there is no 2019-20 or 2020-21.
    "releases": ["2025-26", "2024-25", "2023-24", "2022-23", "2021-22"],
    "file_patterns": [r"institution level.*performance", r"school level.*performance", r"ks4.*institution"],
    "measures": {
        # output key: candidate column names (first match wins)
        "att8": ["avg_att8", "att8scr", "attainment_8"],
        "em5": ["pt_l2basics_95", "ptl2basics_95"],
        "em4": ["pt_l2basics_94", "ptl2basics_94"],
        "p8": ["avg_p8score", "p8mea"],
        "ebacc": ["avg_ebaccaps", "ebaccaps"],
        "pupils": ["t_pupils", "tpup"],
    },
}

KS5 = {
    "publication": "a-level-and-other-16-to-18-results",
    "releases": ["2025-26", "2024-25", "2023-24", "2022-23", "2021-22"],
    "file_patterns": [r"institution level.*performance", r"school level.*performance", r"16.?18.*institution"],
    "measures": {
        "aps": ["aps_per_entry_alevel", "tallppe_alev_1618", "alevel_aps_per_entry", "aps_alev"],
        "grade": ["aps_per_entry_alevel_grade", "tallppegrd_alev_1618", "alevel_aps_grade"],
        "aab": ["pt_aab_2facilitating", "ptaabfac", "pt_aab"],
        "students": ["t_alev_students", "tallpup_alev_1618", "t_students_alevel"],
    },
}


def release_files(publication, release):
    url = f"{CONTENT_API}/publications/{publication}/releases/{release}"
    r = get(url)
    if r.status_code != 200:
        print(f"    {publication} {release}: release not found (HTTP {r.status_code})")
        return None, []
    data = r.json()
    files = data.get("downloadFiles") or data.get("files") or []
    return data.get("id"), files


def pick_file(files, patterns):
    for pat in patterns:
        for f in files:
            name = f"{f.get('name', '')} {f.get('fileName', '')}".lower()
            if re.search(pat, name) and (f.get("extension") or "csv").lower() in ("csv", "zip"):
                return f
    return None


def download_csv(release_id, f):
    urls = [
        f"{CONTENT_API}/releases/{release_id}/files/{f['id']}",
        f"https://explore-education-statistics.service.gov.uk/data-catalogue/data-set/{f['id']}/csv",
    ]
    for url in urls:
        r = get(url, timeout=600)
        if r.status_code == 200 and r.content:
            content = r.content
            if content[:2] == b"PK":
                with zipfile.ZipFile(io.BytesIO(content)) as z:
                    csvs = [n for n in z.namelist() if n.lower().endswith(".csv") and "meta" not in n.lower()]
                    content = z.read(max(csvs, key=lambda n: z.getinfo(n).file_size))
            return content.decode("utf-8-sig", errors="replace")
        print(f"    download failed {url}: HTTP {r.status_code}")
    return None


def to_num(v):
    v = (v or "").strip().replace("%", "")
    try:
        return round(float(v), 2)
    except ValueError:
        return None  # SUPP, NE, NP, x, z, c, etc.


def parse(text, measures, urns):
    reader = csv.DictReader(io.StringIO(text))
    cols = {c.lower(): c for c in reader.fieldnames}
    urn_col = next((cols[c] for c in ("school_urn", "urn", "establishment_urn") if c in cols), None)
    if not urn_col:
        print(f"    no URN column; columns: {reader.fieldnames[:40]}")
        return {}
    mcols = {}
    for key, cands in measures.items():
        mcols[key] = next((cols[c] for c in cands if c in cols), None)
    print(f"    columns used: {mcols}")
    missing = [k for k, v in mcols.items() if not v]
    if missing:
        print(f"    no column for {missing}; sample columns: {reader.fieldnames}")
    filters = {c: cols[c] for c in ("breakdown", "breakdown_topic", "sex", "disadvantage", "establishment_type_group") if c in cols}
    out = {}
    for row in reader:
        try:
            urn = int(row[urn_col])
        except (TypeError, ValueError):
            continue
        if urn not in urns:
            continue
        # Keep only the all-pupils row when the file has breakdowns.
        skip = False
        for c in filters.values():
            val = (row.get(c) or "").strip().lower()
            if val and val not in ("total", "all pupils", "all", "all students", "total (all students)"):
                skip = True
        if skip:
            continue
        rec = {k: to_num(row.get(c)) for k, c in mcols.items() if c}
        if any(v is not None for v in rec.values()):
            out[urn] = rec
    return out


def collect(cfg, urns):
    years = {}
    for rel in cfg["releases"]:
        rid, files = release_files(cfg["publication"], rel)
        if not rid:
            continue
        f = pick_file(files, cfg["file_patterns"])
        if not f:
            print(f"    {rel}: no institution-level file among {[x.get('name') for x in files]}")
            continue
        print(f"    {rel}: using {f.get('name')}")
        text = download_csv(rid, f)
        if not text:
            continue
        RAW.mkdir(parents=True, exist_ok=True)
        (RAW / f"{cfg['publication']}-{rel}.csv").write_text(text[:2_000_000])
        # Label by the summer the exams were sat, e.g. 2024-25 -> 2025.
        years[int(rel[:4]) + 1] = parse(text, cfg["measures"], urns)
    return years


def run():
    schools = read_json(SITE_DATA / "schools.json")
    urns = {s["urn"] for s in schools["schools"]}
    out = {"ks4": {}, "ks5": {}, "years": {}}
    for key, cfg in (("ks4", KS4), ("ks5", KS5)):
        print(f"  {key}:")
        years = collect(cfg, urns)
        out["years"][key] = sorted(years)
        for year, rows in years.items():
            for urn, rec in rows.items():
                out[key].setdefault(str(urn), {})[str(year)] = rec
        print(f"    {key}: {len(out[key])} schools with results across {sorted(years)}")
    out["source"] = "DfE Explore Education Statistics"
    out["sourceUrl"] = "https://explore-education-statistics.service.gov.uk/"
    write_json(SITE_DATA / "results.json", out)


if __name__ == "__main__":
    run()
