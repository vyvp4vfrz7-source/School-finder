"""Run every pipeline step. Usage: python -m pipeline.run_all [step ...]

Steps: schools, results, ofsted, tiles, catchments, probe, crime_baseline,
then the pilot-only steps crime, prices, coverage and basemap.
A failing step is reported and the others still run, so one slow or broken
source never blocks the rest of the site's data.
"""

import os
import sys
import time
import traceback

from .common import SITE_DATA
from . import (basemap, catchments, coverage, crime, crime_baseline, ofsted, prices, probe,
               results, schools, tiles)

STEPS = {
    # England-wide
    "schools": schools.run,
    "results": results.run,
    "ofsted": ofsted.run,
    "tiles": tiles.run,
    "catchments": catchments.run,
    "probe": probe.run,
    "crime_baseline": crime_baseline.run,
    # Catchment pilot only: offline fallbacks for the preview and the base map
    "crime": crime.run,
    "prices": prices.run,
    "coverage": coverage.run,
    "basemap": basemap.run,
}

# Steps that take a long time; a push-triggered run reuses their last output.
SLOW = {"crime": "crime.json", "prices": "sales.json", "basemap": "basemap.json",
        "crime_baseline": "crime_baseline.json"}


def main(argv):
    wanted = argv or list(STEPS)
    failed = []
    quick = os.environ.get("QUICK") == "1"
    for name in wanted:
        print(f"== {name}")
        if quick and name in SLOW and (SITE_DATA / SLOW[name]).exists():
            print("   skipped (QUICK=1 and data already present)")
            continue
        t = time.time()
        try:
            rc = STEPS[name]()
            if rc:
                failed.append(name)
        except Exception:
            traceback.print_exc()
            failed.append(name)
        print(f"   ({time.time() - t:.0f}s)")
    if failed:
        print(f"FAILED steps: {', '.join(failed)}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
