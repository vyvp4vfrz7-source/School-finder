"""Latest Ofsted inspection outcome for every state-funded school in England.

Source: Ofsted "Monthly management information: school inspections outcomes"
  https://www.gov.uk/government/statistical-data-sets/monthly-management-information-ofsteds-school-inspections-outcomes
(Open Government Licence). There is no query API, so this reads the newest monthly
file. The page is found through the GOV.UK content API, so new monthly file names
are picked up without code changes.

Ofsted has used three schemes, and a school's latest inspection can be under any of them:
  - graded inspections up to August 2024, with a 1 to 4 overall effectiveness grade;
  - graded inspections from September 2024 to November 2025, with sub-judgements only;
  - report cards from 10 November 2025, with a 5-point scale for each evaluation area.
Column names change between files, so columns are matched by keywords below and the
headers are printed so a mismatch is easy to spot in the workflow log.
"""

import csv
import datetime as dt
import io
import re

from .common import RAW, get, write_json

GOVUK = "https://www.gov.uk"
PAGES = [
    "/government/statistical-data-sets/monthly-management-information-ofsteds-school-inspections-outcomes",
]
SEARCH = (f"{GOVUK}/api/search.json?q=ofsted+school+inspections+management+information"
          "&filter_organisations=ofsted&count=20&fields=link,title,public_timestamp")

# Report card evaluation areas (from November 2025). The file carries these next to the
# latest graded (OEIF) inspection's columns, which are prefixed "Latest OEIF".
# Each entry: key, label, keywords that must all appear in the header, words that must not.
RC_AREAS = [
    ("inclusion", "Inclusion", ["inclusion"], []),
    ("curriculum", "Curriculum and teaching", ["curriculum", "teaching"], []),
    ("achievement", "Achievement", ["achievement"], []),
    ("attendance", "Attendance and behaviour", ["attendance", "behaviour"], []),
    ("wellbeing", "Personal development and well-being", ["personal development", "well"], []),
    ("leadershipGov", "Leadership and governance", ["leadership", "governance"], []),
    ("rcEarlyYears", "Early years", ["early years"], []),
    ("post16", "Post-16 provision", ["post-16"], []),
    ("safeguarding", "Safeguarding", ["safeguarding standards"], []),
]
OEIF_AREAS = [
    ("overall", "Overall effectiveness", ["overall effectiveness"], []),
    ("quality", "Quality of education", ["quality of education"], []),
    ("behaviour", "Behaviour and attitudes", ["behaviour and attitudes"], []),
    ("personal", "Personal development", ["personal development"], ["well"]),
    ("leadership", "Leadership and management", ["leadership and management"], []),
    ("earlyYears", "Early years", ["early years provision"], []),
    ("sixthForm", "Sixth form", ["sixth form provision"], []),
    ("oeifSafeguarding", "Safeguarding effective", ["safeguarding"], []),
]
AREAS = RC_AREAS + OEIF_AREAS
OLD_GRADES = {"1": "Outstanding", "2": "Good", "3": "Requires improvement", "4": "Inadequate"}
EMPTY = {"", "null", "na", "n/a", "not judged", "not applicable", "9", "-", "none"}


def find_files():
    """CSV attachments on the management information page, newest first."""
    pages = list(PAGES)
    try:
        for res in get(SEARCH).json().get("results", []):
            link = res.get("link", "")
            if "management-information" in link and "school" in link and link not in pages:
                pages.append(link)
    except Exception as e:  # noqa: BLE001 - search is only a fallback
        print(f"    GOV.UK search failed: {e}")
    files = []
    for page in pages:
        r = get(f"{GOVUK}/api/content{page}")
        if r.status_code != 200:
            print(f"    {page}: HTTP {r.status_code}")
            continue
        details = r.json().get("details", {})
        atts = details.get("attachments") or []
        for a in atts:
            title = a.get("title") or ""
            url = a.get("url") or ""
            if not url.lower().endswith(".csv"):
                continue
            t = title.lower()
            if "state-funded" not in t and "state funded" not in t:
                continue
            if "year to date" in t or "all inspections" in t or "provisional" in t:
                continue
            files.append({"title": title, "url": url, "date": _date_in(title)})
        if files:
            break
    files.sort(key=lambda f: f["date"] or dt.date.min, reverse=True)
    return files


def _date_in(text):
    m = re.search(r"(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})", text)
    if not m:
        return None
    try:
        return dt.datetime.strptime(" ".join(m.groups()), "%d %B %Y").date()
    except ValueError:
        return None


def _date(v):
    v = (v or "").strip()
    for fmt in ("%d/%m/%Y", "%Y-%m-%d", "%d/%m/%Y %H:%M", "%d-%m-%Y", "%d %B %Y"):
        try:
            return dt.datetime.strptime(v, fmt).date().isoformat()
        except ValueError:
            pass
    return None


def _match(low, areas, want_oeif, oeif_in_file):
    cols = {}
    for key, _label, need, avoid in areas:
        for h, l in low.items():
            if "previous" in l or "ungraded" in l or "date" in l or h in cols.values():
                continue
            if oeif_in_file and (("oeif" in l) != want_oeif):
                continue
            if all(n in l for n in need) and not any(a in l for a in avoid):
                cols[key] = h
                break
    return cols


def map_columns(headers):
    low = {h: " ".join(h.lower().replace("\u2011", "-").split()) for h in headers}
    oeif_in_file = any("oeif" in l for l in low.values())
    rc = _match(low, RC_AREAS, False, oeif_in_file)
    oeif = _match(low, OEIF_AREAS, True, oeif_in_file)
    urn = next((h for h, l in low.items() if l == "urn"), None)

    def find(*need, avoid=()):
        return next((h for h, l in low.items() if all(n in l for n in need) and not any(a in l for a in avoid)), None)

    dates = {
        "rc": find("inspection start date", avoid=("oeif", "ungraded", "previous")),
        "rcPub": find("publication date", avoid=("oeif", "ungraded", "previous")),
        "oeif": find("inspection start date", "oeif") if oeif_in_file else find("inspection start date"),
        "oeifPub": find("publication date", "oeif") if oeif_in_file else None,
        "ungraded": find("date of latest ungraded inspection"),
        "ungradedOutcome": find("ungraded inspection overall outcome"),
        "concern": find("category of concern", avoid=("oeif", "previous", "most recent")),
    }
    return urn, dates, rc, oeif


def clean_grade(v, key):
    v = (v or "").strip()
    if v.lower() in EMPTY:
        return None
    if key in ("overall", "quality", "behaviour", "personal", "leadership", "earlyYears", "sixthForm"):
        return OLD_GRADES.get(v, v)
    return v


def run():
    files = find_files()
    if not files:
        raise RuntimeError("No Ofsted management information CSV found on GOV.UK")
    for f in files[:4]:
        print(f"    found: {f['title']}")
    out, used = {}, []
    # Read the newest file, plus an older one if the newest is split by scheme.
    for f in files[:2]:
        r = get(f["url"], timeout=300)
        if r.status_code != 200:
            print(f"    {f['url']}: HTTP {r.status_code}")
            continue
        text = r.content.decode("utf-8-sig", errors="replace")
        if text.lstrip().startswith("<"):
            print(f"    {f['url']} returned HTML, skipped")
            continue
        reader = csv.DictReader(io.StringIO(text))
        urn_col, dcols, rc_cols, oeif_cols = map_columns(reader.fieldnames or [])
        print(f"    {f['title']}: {len(reader.fieldnames or [])} columns")
        print(f"    headers: {reader.fieldnames}")
        print(f"    matched: urn={urn_col!r} dates={dcols}")
        print(f"    report card areas={rc_cols}")
        print(f"    graded areas={oeif_cols}")
        if not urn_col:
            continue
        used.append(f["title"])
        n = skipped = 0
        for row in reader:
            try:
                urn = str(int(row[urn_col]))
            except (TypeError, ValueError):
                continue
            col = lambda k: _date(row.get(dcols[k])) if dcols.get(k) else None  # noqa: E731
            rc = {k: g for k, c in rc_cols.items() if (g := clean_grade(row.get(c), k))}
            graded = {k: g for k, c in oeif_cols.items() if (g := clean_grade(row.get(c), k))}
            if rc:
                rec = {"scheme": "report-card", "date": col("rc"), "published": col("rcPub"), "g": rc}
                if graded:
                    rec["previous"] = {"date": col("oeif"), "g": graded}
            elif graded:
                rec = {"scheme": "graded", "date": col("oeif"), "published": col("oeifPub"), "g": graded}
            else:
                skipped += 1
                if skipped <= 3:
                    print(f"    no grades for URN {urn}: { {k: v for k, v in row.items() if v and v.strip()} }")
                continue
            if col("ungraded") and (rec["date"] or "") < col("ungraded"):
                outcome = (row.get(dcols["ungradedOutcome"]) or "").strip() if dcols.get("ungradedOutcome") else ""
                rec["ungraded"] = {"date": col("ungraded"), "outcome": outcome or None}
            concern = (row.get(dcols["concern"]) or "").strip() if dcols.get("concern") else ""
            if concern and concern.lower() not in EMPTY:
                rec["concern"] = concern
            rec = {k: v for k, v in rec.items() if v is not None}
            old = out.get(urn)
            if not old or (rec.get("date") or "") > (old.get("date") or ""):
                out[urn] = rec
            n += 1
        print(f"    {n} schools read, {skipped} without any grade")
        if n and len(out) > 15000:
            break
    if not out:
        raise RuntimeError("Ofsted file read, but no rows matched; check the headers above")
    schemes = {}
    for v in out.values():
        schemes[v["scheme"]] = schemes.get(v["scheme"], 0) + 1
    print(f"  Ofsted outcomes for {len(out)} schools {schemes}")
    write_json(RAW / "ofsted_england.json", {
        "source": "Ofsted management information",
        "sourceUrl": f"{GOVUK}{PAGES[0]}",
        "files": used,
        "labels": {k: label for k, label, _, _ in AREAS},
        "schools": out,
    })


if __name__ == "__main__":
    run()
