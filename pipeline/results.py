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

from .common import SITE_DATA, get, read_json, write_json

KS4 = {
    "publication": "key-stage-4-performance",
    # Exams were cancelled in 2020 and 2021, so there is no 2019-20 or 2020-21.
    "releases": ["2025-26", "2024-25", "2023-24", "2022-23", "2021-22"],
    "file_patterns": [r"institution level.*\(performance\)", r"schools and colleges.*performance", r"schools \(performance\)", r"institution level", r"school level"],
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
    "file_patterns": [r"institution level.*\(performance\)", r"schools and colleges.*performance", r"institution level", r"school level"],
    "measures": {
        "aps": ["aps_per_entry_alevel", "tallppe_alev_1618", "alevel_aps_per_entry", "aps_alev"],
        "grade": ["aps_per_entry_alevel_grade", "tallppegrd_alev_1618", "alevel_aps_grade"],
        "aab": ["pt_aab_2facilitating", "ptaabfac", "pt_aab"],
        "students": ["t_alev_students", "tallpup_alev_1618", "t_students_alevel"],
    },
}


CATALOGUE = "https://explore-education-statistics.service.gov.uk/data-catalogue"


def release_datasets(publication, release):
    """Scrape the release's data catalogue pages for (id, title) pairs."""
    found = {}
    for page in range(1, 8):
        r = get(f"{CATALOGUE}/{publication}/{release}", params={"page": page})
        if r.status_code != 200:
            if page == 1:
                print(f"    {release}: catalogue page not found (HTTP {r.status_code})")
            break
        before = len(found)
        for m in re.finditer(r'href="/data-catalogue/data-set/([0-9a-f-]{36})"[^>]*>(.*?)</a>', r.text, re.S):
            title = re.sub(r"<[^>]+>", " ", m.group(2))
            found.setdefault(m.group(1), re.sub(r"\s+", " ", title).strip())
        if len(found) == before:
            break
    return found


def pick_dataset(datasets, patterns):
    for pat in patterns:
        for ds_id, title in datasets.items():
            t = title.lower()
            if re.search(pat, t) and not re.search(r"national|subject|information|destination|characteristic", t):
                return ds_id, title
    return None, None


def download_csv(ds_id):
    r = get(f"{CATALOGUE}/data-set/{ds_id}/csv", timeout=600)
    if r.status_code != 200 or not r.content:
        print(f"    download failed for {ds_id}: HTTP {r.status_code}")
        return None
    content = r.content
    if content[:2] == b"PK":
        with zipfile.ZipFile(io.BytesIO(content)) as z:
            csvs = [n for n in z.namelist() if n.lower().endswith(".csv") and "meta" not in n.lower()]
            content = z.read(max(csvs, key=lambda n: z.getinfo(n).file_size))
    return content.decode("utf-8-sig", errors="replace")


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
        datasets = release_datasets(cfg["publication"], rel)
        if not datasets:
            continue
        ds_id, title = pick_dataset(datasets, cfg["file_patterns"])
        if not ds_id:
            print(f"    {rel}: no institution-level data set among: {sorted(datasets.values())}")
            continue
        print(f"    {rel}: using '{title}' ({ds_id})")
        text = download_csv(ds_id)
        if not text:
            continue
        # Label by the summer the exams were sat, e.g. 2024-25 -> 2025.
        years[int(rel[:4]) + 1] = parse(text, cfg["measures"], urns)
        print(f"    {rel}: {len(years[int(rel[:4]) + 1])} pilot schools")
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
