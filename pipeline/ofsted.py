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

# Report card evaluation areas (from November 2025), then the earlier framework.
# Each entry: key, label, keywords that must all appear in the header, words that must not.
AREAS = [
    ("inclusion", "Inclusion", ["inclusion"], []),
    ("curriculum", "Curriculum and teaching", ["curriculum", "teaching"], []),
    ("achievement", "Achievement", ["achievement"], []),
    ("attendance", "Attendance and behaviour", ["attendance", "behaviour"], []),
    ("wellbeing", "Personal development and well-being", ["personal development", "well"], []),
    ("leadershipGov", "Leadership and governance", ["leadership", "governance"], []),
    ("safeguarding", "Safeguarding", ["safeguarding"], []),
    ("overall", "Overall effectiveness", ["overall effectiveness"], []),
    ("quality", "Quality of education", ["quality of education"], []),
    ("behaviour", "Behaviour and attitudes", ["behaviour and attitudes"], []),
    ("personal", "Personal development", ["personal development"], ["well"]),
    ("leadership", "Leadership and management", ["leadership and management"], []),
    ("earlyYears", "Early years", ["early years"], []),
    ("sixthForm", "Sixth form", ["sixth form"], []),
]
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


def map_columns(headers):
    cols = {}
    low = {h: h.lower().replace("‑", "-").strip() for h in headers}
    for key, _label, need, avoid in AREAS:
        for h, l in low.items():
            if "previous" in l or "ungraded" in l or h in cols.values():
                continue
            if all(n in l for n in need) and not any(a in l for a in avoid):
                cols[key] = h
                break
    urn = next((h for h, l in low.items() if l == "urn"), None)
    date_cands = [h for h, l in low.items() if "date" in l and ("inspection" in l or "publication" in l)
                  and "previous" not in l]
    start = [h for h in date_cands if "start" in low[h] and "ungraded" not in low[h]]
    date = (start or [h for h in date_cands if "ungraded" not in low[h]] or date_cands or [None])[0]
    published = next((h for h in date_cands if "publication" in low[h]), None)
    kind = next((h for h, l in low.items() if "inspection type" in l or "type of inspection" in l), None)
    return urn, date, published, kind, cols


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
        urn_col, date_col, pub_col, kind_col, cols = map_columns(reader.fieldnames or [])
        print(f"    {f['title']}: {len(reader.fieldnames or [])} columns")
        print(f"    headers: {reader.fieldnames}")
        print(f"    matched: urn={urn_col!r} date={date_col!r} published={pub_col!r} areas={cols}")
        if not urn_col:
            continue
        used.append(f["title"])
        n = 0
        for row in reader:
            try:
                urn = str(int(row[urn_col]))
            except (TypeError, ValueError):
                continue
            grades = {k: g for k, c in cols.items() if (g := clean_grade(row.get(c), k))}
            date = _date(row.get(date_col)) if date_col else None
            if not grades and not date:
                continue
            rec = {"date": date, "g": grades}
            if pub_col and _date(row.get(pub_col)):
                rec["published"] = _date(row.get(pub_col))
            if kind_col and row.get(kind_col):
                rec["type"] = row[kind_col].strip()
            rc = any(k in grades for k in ("inclusion", "curriculum", "achievement", "attendance", "wellbeing"))
            rec["scheme"] = "report-card" if rc else "graded"
            old = out.get(urn)
            if not old or (rec["date"] or "") > (old["date"] or ""):
                out[urn] = rec
            n += 1
        print(f"    {n} schools read")
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
