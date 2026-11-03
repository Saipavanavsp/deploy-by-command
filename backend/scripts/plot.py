"""Fig. 14: tests passed by area + backend response time by endpoint.

Reads results/tests.json (npm test) and results/benchmark.json (npm run bench)
and saves results/fig14.png. Nothing is plotted that was not measured.
"""
import json
import sys
from pathlib import Path

import matplotlib

if "ipykernel" not in sys.modules:
    matplotlib.use("Agg")
import matplotlib.pyplot as plt

RESULTS = Path(__file__).resolve().parent.parent / "results"


def load(name):
    p = RESULTS / name
    return json.loads(p.read_text()) if p.exists() else None


def main():
    tests = load("tests.json")
    bench = load("benchmark.json")
    if not tests and not bench:
        print("No results yet: run `npm test` and `npm run bench` first. Nothing plotted.")
        return None

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(13, 4.8))
    ink, muted, grid = "#1c2430", "#64707f", "#e6e9ef"
    blue, blue2 = "#2357d9", "#9db5ef"

    if tests:
        areas = list(tests["areas"].items())
        names = [a for a, _ in areas]
        passed = [v["passed"] for _, v in areas]
        total = [v["passed"] + v["failed"] for _, v in areas]
        y = range(len(names))
        ax1.barh(y, total, color=grid, height=0.6)
        ax1.barh(y, passed, color=blue, height=0.6)
        for i, (p, t) in enumerate(zip(passed, total)):
            ax1.text(t + 0.1, i, f"{p}/{t}", va="center", color=ink, fontsize=9)
        ax1.set_yticks(list(y), names, fontsize=9)
        ax1.invert_yaxis()
        ax1.set_xlim(0, max(total) + 1.5)
        ax1.set_title(f"Tests passed by area ({tests['passed']}/{tests['total']})", loc="left", color=ink)
    else:
        ax1.text(0.5, 0.5, "tests: not measured", ha="center", va="center", color=muted)

    if bench:
        lat = bench["latency"]
        names = [l["endpoint"] for l in lat]
        x = range(len(names))
        med = [l["medianMs"] for l in lat]
        p95 = [l["p95Ms"] for l in lat]
        w = 0.38
        ax2.bar([i - w / 2 for i in x], med, w, color=blue, label="median")
        ax2.bar([i + w / 2 for i in x], p95, w, color=blue2, label="95th percentile")
        for i, (m, p) in enumerate(zip(med, p95)):
            ax2.text(i - w / 2, m, f"{m:.1f}", ha="center", va="bottom", fontsize=8, color=ink)
            ax2.text(i + w / 2, p, f"{p:.1f}", ha="center", va="bottom", fontsize=8, color=ink)
        ax2.set_xticks(list(x), names, fontsize=9)
        ax2.set_ylabel("ms", color=muted)
        ax2.set_ylim(0, max(p95) * 1.3)
        ax2.legend(frameon=False, fontsize=9, loc="upper right", ncol=2)
        ax2.set_title(f"Backend response time (n={lat[0]['n']} each, mock mode)", loc="left", color=ink)
    else:
        ax2.text(0.5, 0.5, "response time: not measured", ha="center", va="center", color=muted)

    for ax in (ax1, ax2):
        for side in ("top", "right"):
            ax.spines[side].set_visible(False)
        ax.spines["left"].set_color(grid)
        ax.spines["bottom"].set_color(grid)
        ax.tick_params(colors=muted)

    fig.suptitle("Fig. 14 — Deploy by Command evaluation", x=0.01, ha="left", fontsize=12, color=ink)
    fig.tight_layout()
    RESULTS.mkdir(exist_ok=True)
    out = RESULTS / "fig14.png"
    fig.savefig(out, dpi=150)
    print(f"Saved {out}")
    return fig


if __name__ == "__main__":
    main()
