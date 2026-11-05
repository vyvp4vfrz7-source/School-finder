# School Finder

A school and property map for families, in the spirit of Locrating. The pilot covers
**Sutton** and **Kingston upon Thames**; the pipeline is built so more councils can be added later.

What it shows:

- **Schools** from the DfE register (state, independent and special; primary to sixth form).
- **Estimated catchments** for secondary schools, drawn from the councils' "last distance
  offered" figures for each of the last 3 to 5 years, with a Likely / Borderline / Unlikely
  verdict for any postcode.
- **GCSE and A-level results trends**: Attainment 8 and grade 5+ English and maths for 2024 to 2026,
  and A-level average grade and AAB rate for 2022 to 2025 (the years DfE's current school-level data sets hold).
- **Crime** within 500 m from police.uk, with a 3-year trend and the most common crime types.
- **Sold prices** within 500 m from HM Land Registry, by property type and by year.
- **Mobile signal** by operator from Ofcom (needs a free API key, see below).
- **Links to Rightmove and Zoopla** for homes for sale in the postcode district. Listings are not scraped.

## How it is built

```
data/manual/        hand-collected catchment figures and their sources (edit these)
data/cache/         postcode and coverage lookups, kept so monthly runs are quick
pipeline/           Python scripts that download open data and write site/data/*.json
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

The full run takes a while because crime is fetched month by month and the Land Registry
files are large. In GitHub the **Refresh data** workflow does this and commits the results.

### Add or update catchment figures

1. Add rows to `data/manual/catchments.csv`: council, school name as in the DfE register,
   entry year, distance in metres, and a status:
   `distance`, `all_offered`, `selective`, `faith`, `banding` or `unclear`.
2. Use `measured_from` when a council measures from somewhere other than the school
   (for example Cheam High's Worcester Park places, measured from Dorchester Primary).
3. Add the document to `data/manual/catchment_sources.csv` and reference its id.
4. Push. The workflow rebuilds `site/data/catchments.json`, and fails if a name does not match.

### Add another area

Add the council's DfE local authority code to `LAS` and its Land Registry district name to
`LR_DISTRICTS` in `pipeline/common.py`, then add its catchment rows.

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
- Ofsted's new report cards (from November 2025) are linked out, not shown.
