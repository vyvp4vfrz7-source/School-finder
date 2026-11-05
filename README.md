# School Finder

A school and property map for families, in the spirit of Locrating. It covers **all of England**
for schools, results, Ofsted, crime and sold prices. Catchment estimates cover **Sutton** and
**Kingston upon Thames** so far, because councils publish them only as PDFs.

What it shows:

- **Schools** from the DfE register, all of England (state, independent and special; primary to sixth form).
- **Exam results trends**: SATs, GCSE (Attainment 8, grade 5+ English and maths) and A level
  (average grade, AAB rate), for the years DfE's current school-level data sets hold.
- **Ofsted**: the latest inspection outcome, under whichever scheme it was made (graded with an
  overall grade, graded without one from September 2024, or a report card from November 2025).
- **Crime** within 500 m, asked live from police.uk, with a 3-year trend, the most common crime
  types, and how it compares with school neighbourhoods across England.
- **Sold prices** within 500 m, asked live from HM Land Registry, by property type and by year.
- **Estimated catchments** (Sutton and Kingston) for secondary schools, from the councils'
  "last distance offered" figures for the last 3 to 5 years, with a Likely / Borderline /
  Unlikely verdict for any postcode.
- **Mobile signal** by operator from Ofcom (pilot area only; needs a free API key, see below).
- **Links to Rightmove and Zoopla** for homes for sale in the postcode district. Listings are not scraped.

## What is copied and what is live

| Data | How the site gets it | Why |
|---|---|---|
| Postcodes, towns | Live from postcodes.io in the browser | Free API that allows browser requests |
| Crime | Live from police.uk in the browser (36 small requests per area) | Free API; copying all of England would be tens of millions of rows |
| Sold prices | Live from Land Registry's SPARQL endpoint, for the postcodes postcodes.io lists within 500 m | Free query endpoint |
| Schools, results, Ofsted | Downloaded monthly by the pipeline, split into map tiles | DfE and Ofsted publish bulk files only, with no query API |
| Catchments | Typed in by hand from council booklets | Not published as data anywhere |

The **Refresh data** workflow's `probe` step checks each month that the live sources still answer
and still allow browser requests. If one stops, the site falls back to the pilot's stored files
where it has them. Scotland, Wales and Northern Ireland publish school data in different systems
and are not covered yet.

## How it is built

```
data/manual/        hand-collected catchment figures and their sources (edit these)
data/cache/         pilot schools, postcode and coverage lookups, kept so monthly runs are quick
pipeline/           Python scripts that download open data and write site/data/*.json
site/data/tiles/    schools, results and Ofsted for England, in 0.25 degree squares
site/               the static website (HTML, CSS, one JS file, Leaflet map)
.github/workflows/  data refresh (monthly and on change) and GitHub Pages deploy
```

There is no server and no build step. The site reads JSON files, so it can be hosted anywhere static.

### Run locally

```bash
pip install -r pipeline/requirements.txt
python -m pipeline.run_all            # all steps, or e.g. `python -m pipeline.run_all schools catchments`
python -m http.server -d site 8000    # then open http://localhost:8000
```

The full run takes a while: the national results files are large, and the pilot's crime
and price fallbacks are fetched month by month. In GitHub the **Refresh data** workflow does this and commits the results.

### Add or update catchment figures

1. Add rows to `data/manual/catchments.csv`: council, school name as in the DfE register,
   entry year, distance in metres, and a status:
   `distance`, `all_offered`, `selective`, `faith`, `banding` or `unclear`.
2. Use `measured_from` when a council measures from somewhere other than the school
   (for example Cheam High's Worcester Park places, measured from Dorchester Primary).
3. Add the document to `data/manual/catchment_sources.csv` and reference its id.
4. Push. The workflow rebuilds `site/data/catchments.json`, and fails if a name does not match.

### Add catchments for another council

Schools, results and Ofsted already cover England. To add catchment estimates for another
council, add its DfE local authority code to `LAS` in `pipeline/common.py` and its rows to
`data/manual/catchments.csv`.

### Mobile coverage

Register for a free key at the [Ofcom API portal](https://api.ofcom.org.uk/) and add it as a
repository secret named `OFCOM_API_KEY` (Settings → Secrets and variables → Actions). Each run
fetches up to 1,500 new postcodes and caches them.

### Publish the site

In the repository settings, open **Pages** and set the source to **GitHub Actions**. Every push
to `main` then deploys `site/`.

## Data sources and licences

| Layer | Source | Licence |
|---|---|---|
| Schools | [DfE Get Information about Schools](https://get-information-schools.service.gov.uk/) | OGL v3 |
| Results | [DfE Explore Education Statistics](https://explore-education-statistics.service.gov.uk/) | OGL v3 |
| Ofsted | [Ofsted monthly management information](https://www.gov.uk/government/statistical-data-sets/monthly-management-information-ofsteds-school-inspections-outcomes) | OGL v3 |
| Catchments | Kingston and Sutton council admissions publications (see `data/manual/catchment_sources.csv`) | Published by the councils |
| Crime | [police.uk](https://data.police.uk/) | OGL v3 |
| Sold prices | [HM Land Registry Price Paid Data](https://www.gov.uk/government/statistical-data-sets/price-paid-data-downloads) | OGL v3 |
| Postcodes | [postcodes.io](https://postcodes.io/) (ONS Postcode Directory) | OGL v3 |
| Mobile coverage | [Ofcom](https://api.ofcom.org.uk/) | Ofcom terms |
| Map tiles | OpenStreetMap contributors, CARTO | ODbL / CARTO terms |

The CARTO basemap is fine for a prototype; a commercial launch should use a paid tile plan or self-hosted tiles.

## Known limits

- Catchment figures are a guide: priority groups (siblings, looked-after children, faith, test
  places) are offered first, and the cut-off moves every year.
- Kingston 2025 shows "Overseas" for three schools, which the pipeline treats as unclear.
- Sutton's current offer-day page has no year label; it is recorded as 2026 entry.
- Primary school catchments are not collected yet.
- Independent schools' inspections are not in Ofsted's state school file, so they show a link only.
- Live crime and price lookups depend on police.uk and Land Registry being up; each area takes a
  few seconds to load.
