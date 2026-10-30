"""Run the whole pipeline: fetch (optional) -> ledger -> predictors -> model -> export.

uv run python -m hotspot.cli            # use the cache, recompute everything
uv run python -m hotspot.cli --fetch    # pull new SeeClickFix issues first
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
import time
from zoneinfo import ZoneInfo

import numpy as np

from . import fetch_scf, ledger, mapdata, model, predictors
from .config import ISSUES_CACHE, LAT_STEP, LNG_STEP, OUT, START_YEAR
from .geo import district_of, in_city

FORBIDDEN_KEYS = {
    "reporter",
    "reporter_hash",
    "reporter_is_guest",
    "description",
    "summary",
    "address",
    "media",
    "html_url",
    "comment_url",
}
TZ = ZoneInfo("America/New_York")


def all_reports_pre(cutoff_year: int) -> list[dict]:
    """Every in-city report (any type) up to cutoff_year, as light dicts for predictor features."""
    out = []
    for i in json.loads(ISSUES_CACHE.read_text()):
        if not i.get("lng") or not (str(START_YEAR) <= i["created_at"][:4] <= str(cutoff_year)):
            continue
        if in_city(i["lng"], i["lat"]):
            out.append({"lat": i["lat"], "lng": i["lng"], "rtype": (i.get("request_type") or {}).get("title") or ""})
    return out


def privacy_guard(obj, reporter_hashes: set[str], path="$") -> None:
    """Fail loudly if anything identifying or free-text could reach a public file."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in FORBIDDEN_KEYS:
                raise ValueError(f"privacy guard: forbidden key {k!r} at {path}")
            privacy_guard(v, reporter_hashes, f"{path}.{k}")
    elif isinstance(obj, list):
        for k, v in enumerate(obj):
            privacy_guard(v, reporter_hashes, f"{path}[{k}]")
    elif isinstance(obj, str):
        if obj in reporter_hashes:
            raise ValueError(f"privacy guard: reporter hash at {path}")
        if re.search(r"\b\d{2,5}\s+\w+\s+(st|rd|dr|ave|ln|cir|ct|hwy|way|pkwy|blvd)\b", obj, re.I):
            raise ValueError(f"privacy guard: something address-like at {path}")


CELL_KEYS = {
    "id",
    "lat",
    "lng",
    "street",
    "n",
    "hotspot",
    "n_others",
    "years",
    "years_others",
    "items",
    "first_year",
    "last_month",
    "last_12_months",
    "photos",
    "district",
    "plus_code",
    "risk",
    "owner_hint",
    "context",
}
DETAIL_KEYS = ("n_others", "years", "years_others", "items", "first_year", "last_month")
STREET_OK = re.compile(r"^[A-Za-z0-9 .&'/-]{0,48}$")
PLUS_OK = re.compile(r"^[23456789CFGHJMPQRVWX]{8}\+[23456789CFGHJMPQRVWX]{2}$")


def validate_cells(cells: list[dict]) -> None:
    """Allow-list schema for public cells: exact keys, cell-center coordinates, no detail on small cells."""
    for c in cells:
        if set(c) != CELL_KEYS:
            raise ValueError(f"cell schema: unexpected keys {sorted(set(c) ^ CELL_KEYS)}")
        a, b = (int(x) for x in c["id"].split("_"))
        if abs(c["lat"] - a * LAT_STEP) > 1e-5 or abs(c["lng"] - b * LNG_STEP) > 1e-5:
            raise ValueError(f"cell {c['id']}: coordinates are not the cell center")
        if not STREET_OK.match(c["street"]) or not PLUS_OK.match(c["plus_code"]):
            raise ValueError(f"cell {c['id']}: street or plus code outside the allowed pattern")
        if not c["hotspot"] and any(c[k] is not None for k in DETAIL_KEYS):
            raise ValueError(f"cell {c['id']}: detail published for a cell with fewer than 3 reports")


def write(name: str, obj, reporter_hashes: set[str]) -> int:
    privacy_guard(obj, reporter_hashes)
    OUT.mkdir(parents=True, exist_ok=True)
    text = json.dumps(obj, separators=(",", ":"))
    (OUT / name).write_text(text)
    return len(text)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fetch", action="store_true", help="pull new SeeClickFix issues before computing")
    args = ap.parse_args(argv)
    t0 = time.time()
    if args.fetch:
        print("fetch:", fetch_scf.fetch(), flush=True)

    rekeyed = fetch_scf.rekey_cache()
    if rekeyed:
        print(f"rekeyed {rekeyed} cached reporter hashes with the private HMAC key", flush=True)
    now = dt.datetime.now(TZ)
    reports, total = ledger.load_reports()
    if len(reports) < 500:
        raise SystemExit(f"only {len(reports)} dumping reports loaded; refusing to publish a thin ledger")
    built = ledger.build(reports, total, now)
    hashes = {r.reporter for r in reports}
    cells = built["cells"]
    print(f"ledger: {len(reports)} dumping reports, {len(cells)} cells, {built['metrics']['hotspots']} hotspots", flush=True)

    osm_el = predictors.osm()
    tracts = predictors.tracts()
    acs = predictors.acs()

    # Temporal evaluation: train through last year, test on cells first reported this year.
    this_year = now.year
    past = {r.key for r in reports if r.created.year < this_year}
    new = {r.key for r in reports if r.created.year == this_year} - past
    grid = model.grid_cells({r.key for r in reports})
    feat_eval = model.features(grid, osm_el, all_reports_pre(this_year - 1), tracts, acs)
    seeds, nulls = model.ci_scale()
    evaluation = model.evaluate(grid, feat_eval, past, new, seeds=seeds, nulls=nulls)
    evaluation.update(
        {
            "train_years": f"{START_YEAR}-{this_year - 1}",
            "test_year": str(this_year),
            "seeds": list(seeds),
            "null_runs": nulls,
            "method": "positive-unlabeled random forest (YDF), spatial cross-fitting, temporal holdout",
        }
    )
    m = evaluation["models"]["map_plus_old_spots"]
    print(
        f"model: map+old spots capture@30% {m['min']:.3f}-{m['max']:.3f}; near-old-hotspots "
        f"{evaluation['baselines']['near_old_hotspots']['capture30']:.3f}",
        flush=True,
    )

    # Without the most active account, as a stress test.
    past_o = {r.key for r in reports if r.created.year < this_year and r.reporter != built["top"]}
    new_o = {r.key for r in reports if r.created.year == this_year and r.reporter != built["top"]} - past_o
    evaluation["without_top_account"] = model.evaluate(grid, feat_eval, past_o, new_o, seeds=seeds[:3], nulls=min(nulls, 4))

    # Today's risk: every cell with any report is a positive; feature counts use all years so far.
    feat_now = model.features(grid, osm_el, all_reports_pre(this_year), tracts, acs)
    scores = model.current_scores(grid, feat_now, {r.key for r in reports})
    score_of = {grid[k]: float(scores[k]) for k in range(len(grid))}
    reported = {r.key for r in reports}
    unrep = [k for k in grid if k not in reported]
    cut = np.quantile([score_of[k] for k in unrep], 0.70)
    flagged = [k for k in unrep if score_of[k] >= cut]

    grid_index = {k: n for n, k in enumerate(grid)}
    for c in cells:
        a, b = (int(x) for x in c["id"].split("_"))
        c["risk"] = round(score_of.get((a, b), 0.0), 4)
        g = grid_index[(a, b)]
        c["context"] = {
            "dead_ends_within_250": int(feat_now["dead_ends_within_250"][g]),
            "d_major_m": int(feat_now["d_major_m"][g]),
            "road_m_within_150": int(feat_now["road_m_within_150"][g]),
            "streetlight_out_within_300": int(feat_now["streetlight_out_within_300"][g]),
        }
    mapdata.owner_hints(cells, osm_el)
    mapdata.street_labels(cells, osm_el)

    risk_cells = []
    for k in flagged:
        lat, lng = k[0] * 0.00135, k[1] * 0.0016
        risk_cells.append(
            {"lat": round(lat, 6), "lng": round(lng, 6), "risk": round(score_of[k], 4), "district": district_of(lng, lat)}
        )

    equity = {}
    for d in sorted(built["metrics"]["districts"]):
        rep_cells = sum(1 for c in cells if c["district"] == d)
        flag_cells = sum(1 for rc in risk_cells if rc["district"] == d)
        equity[d] = {"reported_cells": rep_cells, "flagged_unreported_cells": flag_cells}
    tot_r = sum(v["reported_cells"] for v in equity.values()) or 1
    tot_f = sum(v["flagged_unreported_cells"] for v in equity.values()) or 1
    for v in equity.values():
        v["reported_share"] = round(v["reported_cells"] / tot_r, 4)
        v["flagged_share"] = round(v["flagged_unreported_cells"] / tot_f, 4)

    built["metrics"]["equity"] = equity
    sizes = {
        "metrics.json": write("metrics.json", built["metrics"], hashes),
        "cells.json": (validate_cells(cells), write("cells.json", cells, hashes))[1],
        "risk.json": write("risk.json", risk_cells, hashes),
        "model.json": write("model.json", evaluation, hashes),
        "map.json": write("map.json", {**mapdata.boundary_layers(), "roads": mapdata.road_layers(osm_el)}, hashes),
        "meta.json": write(
            "meta.json",
            {
                "generated_at": now.isoformat(timespec="seconds"),
                "sources": [
                    {
                        "name": "SeeClickFix API v2 (Cobb County queue)",
                        "license": "CC BY-NC-SA 3.0 US",
                        "credit": "seeclickfix.com",
                    },
                    {"name": "Cobb County GIS: Mableton city limit and council districts", "license": "public"},
                    {"name": "OpenStreetMap", "license": "ODbL", "credit": "OpenStreetMap contributors"},
                    {"name": "American Community Survey via Google Data Commons", "license": "public"},
                ],
                "privacy": "Aggregates only: no report text, no addresses, no reporter identifiers, no photos. Spots sit at the center of a ~150 m cell, never at a report's location, and spots with fewer than 3 reports publish only a count.",
            },
            hashes,
        ),
    }
    print("export:", sizes, f"in {time.time() - t0:.0f}s", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
