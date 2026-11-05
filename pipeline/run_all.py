"""Run every pipeline step. Usage: python -m pipeline.run_all [step ...]

Steps: schools, catchments, results, crime, prices, coverage, basemap.
A failing step is reported and the others still run, so one slow or broken
source never blocks the rest of the site's data.
"""

import os
import sys
import time
import traceback

from .common import SITE_DATA
from . import basemap, catchments, coverage, crime, prices, results, schools

STEPS = {
    "schools": schools.run,
    "catchments": catchments.run,
    "results": results.run,
    "crime": crime.run,
    "prices": prices.run,
    "coverage": coverage.run,
    "basemap": basemap.run,
}

# Steps that take a long time; a push-triggered run reuses their last output.
SLOW = {"crime": "crime.json", "prices": "sales.json", "basemap": "basemap.json"}


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
