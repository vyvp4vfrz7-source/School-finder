"""Run every pipeline step. Usage: python -m pipeline.run_all [step ...]

Steps: schools, catchments, results, crime, prices, coverage.
A failing step is reported and the others still run, so one slow or broken
source never blocks the rest of the site's data.
"""

import sys
import time
import traceback

from . import catchments, coverage, crime, prices, results, schools

STEPS = {
    "schools": schools.run,
    "catchments": catchments.run,
    "results": results.run,
    "crime": crime.run,
    "prices": prices.run,
    "coverage": coverage.run,
}


def main(argv):
    wanted = argv or list(STEPS)
    failed = []
    for name in wanted:
        print(f"== {name}")
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
