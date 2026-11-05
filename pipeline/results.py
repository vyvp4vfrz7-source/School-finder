"""GCSE (key stage 4) and A-level (16 to 18) results by school, several years.

Source: DfE Explore Education Statistics (Open Government Licence)
  https://explore-education-statistics.service.gov.uk/find-statistics/key-stage-4-performance
  https://explore-education-statistics.service.gov.uk/find-statistics/a-level-and-other-16-to-18-results

The DfE "Compare school and college performance" site is being phased out, so this
reads the school-level data sets in the Explore Education Statistics data catalogue.
Each data set below is a rolling "latest data" set that covers several years.
"""

import csv
import io
import zipfile

from .common import SITE_DATA, get, read_json, write_json

CATALOGUE = "https://explore-education-statistics.service.gov.uk/data-catalogue/data-set"

DATASETS = {
    "ks2": {
        # "Key stage 2 institutional level - Schools (performance)" (2022/23 onwards).
        # One row per subject, so measures are picked per subject below.
        "id": "f6cb50e9-0eca-4b1e-ac1a-6f6bb9d21a07",
        "filters": {"breakdown_topic": "all pupils", "breakdown": "total"},
        "by_subject": {
            "reading, writing and maths": {"rwm": "expected_standard_pupil_percent",
                                            "rwmHigh": "higher_standard_pupil_percent"},
            "reading": {"read": "average_scaled_score"},
            "maths": {"maths": "average_scaled_score"},
        },
    },
    "ks4": {
        # "Key stage 4 institution level - Performance" (2023/24 onwards)
        "id": "bf138f04-daa2-4759-b950-937a17a4c675",
        "filters": {
            "breakdown_topic": "total", "breakdown": "total", "sex": "total",
            "disadvantage_status": "total", "first_language": "total",
            "prior_attainment": "total", "mobility": "total",
        },
        "measures": {
            "att8": ["attainment8_average", "avg_att8"],
            "em5": ["engmath_95_percent", "pt_l2basics_95"],
            "em4": ["engmath_94_percent", "pt_l2basics_94"],
            "p8": ["progress8_average", "avg_p8score"],
            "pupils": ["pupil_count", "t_pupils"],
        },
    },
    "ks5": {
        # "Schools and colleges - performance" from 16 to 19 performance (2021/22 onwards)
        "id": "eb2322e3-5976-42f2-ae83-900f26e92bd9",
        "filters": {"disadvantage_status": "total", "exam_cohort": "a level", "sex": "total"},
        "measures": {
            "aps": ["aps_per_entry"],
            "grade": ["aps_per_entry_grade"],
            "best3": ["best_three_alevels_aps"],
            "aab": ["aab_percent"],
            "students": ["aps_per_entry_student_count", "aab_student_count"],
        },
    },
}


def download_csv(ds_id):
    r = get(f"{CATALOGUE}/{ds_id}/csv", timeout=900)
    if r.status_code != 200 or not r.content:
        raise RuntimeError(f"download failed for {ds_id}: HTTP {r.status_code}")
    content = r.content
    if content[:2] == b"PK":
        with zipfile.ZipFile(io.BytesIO(content)) as z:
            csvs = [n for n in z.namelist() if n.lower().endswith(".csv") and "meta" not in n.lower()]
            content = z.read(max(csvs, key=lambda n: z.getinfo(n).file_size))
    return content.decode("utf-8-sig", errors="replace")


SUPPRESSED = {"", "x", "z", "c", "u", "low", "supp", "ne", "np", "na"}


def to_num(v):
    """Numbers become floats; grades such as "B+" stay text; suppression codes become None."""
    v = (v or "").strip().replace("%", "")
    if v.lower() in SUPPRESSED:
        return None
    try:
        return round(float(v), 2)
    except ValueError:
        return v


def parse(text, cfg, urns):
    reader = csv.DictReader(io.StringIO(text))
    cols = {c.lower(): c for c in reader.fieldnames}
    urn_col = cols.get("school_urn") or cols.get("urn")
    if "by_subject" in cfg:
        return parse_by_subject(reader, cols, urn_col, cfg, urns)
    mcols = {k: next((cols[c] for c in cands if c in cols), None) for k, cands in cfg["measures"].items()}
    fcols = {cols[c]: v for c, v in cfg["filters"].items() if c in cols}
    print(f"    measures: {mcols}")
    print(f"    filters:  {fcols}")
    out, seen_vals = {}, {}
    for row in reader:
        try:
            urn = int(row[urn_col])
        except (TypeError, ValueError):
            continue
        if urn not in urns:
            continue
        for c in fcols:
            seen_vals.setdefault(c, set()).add(row.get(c))
        if any((row.get(c) or "").strip().lower() != v for c, v in fcols.items()):
            continue
        tp = (row.get(cols.get("time_period", "")) or "").strip()
        if len(tp) != 6:
            continue
        year = int(tp[:4]) + 1  # 202425 -> summer 2025
        rec = {k: to_num(row.get(c)) for k, c in mcols.items() if c}
        if any(v is not None for v in rec.values()):
            out.setdefault(str(urn), {})[str(year)] = rec
    if not out:
        print(f"    no rows kept; filter values seen: { {k: sorted(map(str, v))[:12] for k, v in seen_vals.items()} }")
    return out


def parse_by_subject(reader, cols, urn_col, cfg, urns):
    fcols = {cols[c]: v for c, v in cfg["filters"].items() if c in cols}
    subj_col = cols.get("subject")
    print(f"    filters: {fcols}, subject column: {subj_col}")
    out, subjects = {}, set()
    for row in reader:
        try:
            urn = int(row[urn_col])
        except (TypeError, ValueError):
            continue
        if urn not in urns:
            continue
        subj = (row.get(subj_col) or "").strip().lower()
        subjects.add(subj)
        if subj not in cfg["by_subject"]:
            continue
        if any((row.get(c) or "").strip().lower() != v for c, v in fcols.items()):
            continue
        tp = (row.get(cols.get("time_period", "")) or "").strip()
        if len(tp) != 6:
            continue
        rec = out.setdefault(str(urn), {}).setdefault(str(int(tp[:4]) + 1), {})
        for key, col in cfg["by_subject"][subj].items():
            if col in cols:
                v = to_num(row.get(cols[col]))
                if v is not None:
                    rec[key] = v
    if not out:
        print(f"    no rows kept; subjects seen: {sorted(subjects)[:20]}")
    return {u: {y: r for y, r in ys.items() if r} for u, ys in out.items()}


def run():
    schools = read_json(SITE_DATA / "schools.json")
    urns = {s["urn"] for s in schools["schools"]}
    out = {"years": {}}
    for key, cfg in DATASETS.items():
        print(f"  {key}: data set {cfg['id']}")
        data = parse(download_csv(cfg["id"]), cfg, urns)
        out[key] = data
        out["years"][key] = sorted({int(y) for d in data.values() for y in d})
        print(f"    {len(data)} pilot schools, years {out['years'][key]}")
    out["source"] = "DfE Explore Education Statistics"
    out["sourceUrl"] = "https://explore-education-statistics.service.gov.uk/"
    write_json(SITE_DATA / "results.json", out)


if __name__ == "__main__":
    run()
