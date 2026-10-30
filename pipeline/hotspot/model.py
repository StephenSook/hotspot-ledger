"""'Where next': a positive-unlabeled random forest (Yggdrasil Decision Forests) over ~150 m cells.

Evaluation is temporal: train on reports up to the end of last year, test on the cells whose FIRST
dumping report arrived this year. Cells are scored by models that never saw them (spatial
cross-fitting in ~1.2 km blocks). Every model is compared with random picking, single-feature
baselines, the "near old hotspots" rule, and models trained on shuffled labels.
Metric: capture@30% = share of new cells inside the top 30% of eligible cells (random = 30%).
"""

from __future__ import annotations

import os

import numpy as np
import ydf
from scipy.spatial import cKDTree
from sklearn.metrics import roc_auc_score

from .config import LAT_STEP, LNG_STEP
from .geo import city_polygons, in_city, point_in_polygon, polygons, to_xy

MAJOR = {"motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link", "secondary", "secondary_link"}
SKIP_HW = {"footway", "path", "cycleway", "steps", "pedestrian", "bridleway", "corridor", "proposed", "construction"}


def grid_cells(extra_keys) -> list[tuple[int, int]]:
    lons = [c[0] for p in city_polygons() for r in p for c in r]
    lats = [c[1] for p in city_polygons() for r in p for c in r]
    cells = set()
    for a in range(round(min(lats) / LAT_STEP) - 1, round(max(lats) / LAT_STEP) + 2):
        for b in range(round(min(lons) / LNG_STEP) - 1, round(max(lons) / LNG_STEP) + 2):
            if in_city(b * LNG_STEP, a * LAT_STEP):
                cells.add((a, b))
    return sorted(cells | set(extra_keys))


def _densify(geom, step=20.0):
    pts = []
    for p, q in zip(geom, geom[1:], strict=False):
        a = np.array(to_xy(p["lon"], p["lat"]))
        b = np.array(to_xy(q["lon"], q["lat"]))
        n = max(1, int(np.hypot(*(b - a)) // step))
        for t in range(n):
            pts.append(a + (b - a) * t / n)
    if geom:
        pts.append(np.array(to_xy(geom[-1]["lon"], geom[-1]["lat"])))
    return pts


def features(cells, osm_elements, reports_pre, tracts, acs) -> dict[str, np.ndarray]:
    lat = np.array([c[0] * LAT_STEP for c in cells])
    lng = np.array([c[1] * LNG_STEP for c in cells])
    cxy = np.column_stack(to_xy(lng, lat))
    groups = {k: [] for k in ("major", "tertiary", "road", "rail", "water", "service")}
    ends: dict[tuple, int] = {}
    for el in osm_elements:
        t, g = el.get("tags", {}), el.get("geometry") or []
        if len(g) < 2:
            continue
        pts = _densify(g)
        if "highway" in t:
            hw = t["highway"]
            if hw in SKIP_HW:
                continue
            groups["road"] += pts
            if hw in MAJOR:
                groups["major"] += pts
            elif hw in ("tertiary", "tertiary_link"):
                groups["tertiary"] += pts
            if hw in ("service", "track", "unclassified"):
                groups["service"] += pts
            for node in (g[0], g[-1]):
                k = (round(node["lat"], 6), round(node["lon"], 6))
                ends[k] = ends.get(k, 0) + 1
            for node in g[1:-1]:
                k = (round(node["lat"], 6), round(node["lon"], 6))
                if k in ends:
                    ends[k] += 2
        elif t.get("railway") == "rail":
            groups["rail"] += pts
        elif "waterway" in t:
            groups["water"] += pts

    def nearest(pts):
        return cKDTree(np.array(pts)).query(cxy)[0] if pts else np.full(len(cells), 1e5)

    def within(pts, r):
        return (
            np.array([len(x) for x in cKDTree(np.array(pts)).query_ball_point(cxy, r)], dtype=float)
            if len(pts)
            else np.zeros(len(cells))
        )

    dead = [np.array(to_xy(k[1], k[0])) for k, v in ends.items() if v == 1]
    lights = [r for r in reports_pre if "street light" in r["rtype"].lower()]
    feat = {
        "d_major_m": nearest(groups["major"]),
        "d_tertiary_m": nearest(groups["tertiary"]),
        "d_rail_m": nearest(groups["rail"]),
        "d_water_m": nearest(groups["water"]),
        "road_m_within_150": within(groups["road"], 150) * 20.0,
        "service_m_within_150": within(groups["service"], 150) * 20.0,
        "dead_ends_within_250": within(dead, 250),
        "streetlight_out_within_300": within([np.array(to_xy(r["lng"], r["lat"])) for r in lights], 300),
    }
    tpolys = [(f["properties"]["GEOID"], polygons(f["geometry"])) for f in tracts]
    inc = np.full(len(cells), np.nan)
    rent = np.full(len(cells), np.nan)
    for k in range(len(cells)):
        for geoid, ps in tpolys:
            if any(point_in_polygon(lng[k], lat[k], p) for p in ps):
                v = acs.get(geoid, {})
                r, o = v.get("Count_HousingUnit_RenterOccupied"), v.get("Count_HousingUnit_OwnerOccupied")
                inc[k] = v.get("Median_Income_Household", np.nan)
                rent[k] = r / (r + o) if r is not None and o is not None and (r + o) else np.nan
                break
    feat["tract_median_income"] = inc
    feat["tract_renter_share"] = rent
    return feat


class Evaluator:
    def __init__(self, cells, feat, is_past, is_new):
        self.cells, self.feat = cells, feat
        self.is_past, self.is_new = is_past, is_new
        self.elig = ~is_past
        lat = np.array([c[0] * LAT_STEP for c in cells])
        lng = np.array([c[1] * LNG_STEP for c in cells])
        self.xy = np.column_stack(to_xy(lng, lat))
        dd, _ = cKDTree(self.xy[is_past]).query(self.xy, k=2)
        self.d_past = np.where(is_past, dd[:, 1], dd[:, 0])  # nearest OTHER past cell; 0 to itself would leak
        self.block = np.floor(self.xy[:, 0] / 1200).astype(int) * 1000 + np.floor(self.xy[:, 1] / 1200).astype(int)

    def folds(self, seed):
        rng = np.random.default_rng(seed)
        ub = np.unique(self.block)
        rng.shuffle(ub)
        fold_of = {b: k % 5 for k, b in enumerate(ub)}
        return np.array([fold_of[b] for b in self.block])

    def pu_scores(self, cols: dict, seed=7, labels=None) -> np.ndarray:
        labels = self.is_past if labels is None else labels
        fold = self.folds(seed)
        names = list(cols)
        X = np.column_stack([cols[c] for c in names])
        score = np.zeros(len(self.cells))
        for f in range(5):
            tr = fold != f
            data = {c: X[tr, j] for j, c in enumerate(names)}
            data["y"] = labels[tr].astype(int)
            m = ydf.RandomForestLearner(label="y", task=ydf.Task.CLASSIFICATION, num_trees=300, random_seed=seed).train(
                data, verbose=0
            )
            te = ~tr
            score[te] = np.asarray(m.predict({c: X[te, j] for j, c in enumerate(names)})).reshape(-1)
        return score

    def capture(self, score) -> dict:
        e = np.where(self.elig)[0]
        order = e[np.argsort(-score[e], kind="stable")]
        top = set(order[: int(round(0.30 * len(e)))].tolist())
        hits = np.array([k in top for k in np.where(self.is_new)[0]])
        rng = np.random.default_rng(0)
        boots = [hits[rng.integers(0, len(hits), len(hits))].mean() for _ in range(2000)]
        return {
            "capture30": round(float(hits.mean()), 4),
            "ci95": [round(float(np.percentile(boots, 2.5)), 4), round(float(np.percentile(boots, 97.5)), 4)],
            "auc": round(float(roc_auc_score(self.is_new[e], score[e])), 4),
        }


def evaluate(cells, feat, past_keys, new_keys, seeds=(1, 2, 3, 4, 5), nulls=10) -> dict:
    is_past = np.array([c in past_keys for c in cells])
    is_new = np.array([c in new_keys for c in cells])
    ev = Evaluator(cells, feat, is_past, is_new)
    jitter = np.random.default_rng(1).random(len(cells)) * 1e-6
    env = dict(feat)
    env_d = {**env, "d_past_m": ev.d_past}
    out = {
        "cells": len(cells),
        "past_cells": int(is_past.sum()),
        "eligible": int(ev.elig.sum()),
        "new_cells": int(is_new.sum()),
        "baselines": {},
        "models": {},
    }
    out["baselines"]["random"] = {"capture30": 0.30}
    out["baselines"]["dead_ends"] = ev.capture(feat["dead_ends_within_250"] + jitter)
    out["baselines"]["near_major_road"] = ev.capture(-feat["d_major_m"])
    out["baselines"]["road_density"] = ev.capture(feat["road_m_within_150"] + jitter)
    out["baselines"]["near_old_hotspots"] = ev.capture(-ev.d_past)
    for name, cols in (("map_only", env), ("map_plus_old_spots", env_d)):
        runs = [ev.capture(ev.pu_scores(cols, seed=s)) for s in seeds]
        caps = [r["capture30"] for r in runs]
        out["models"][name] = {"runs": runs, "min": min(caps), "max": max(caps), "mean": round(float(np.mean(caps)), 4)}
    null_caps = []
    for s in range(11, 11 + nulls):
        sh = is_past.copy()
        np.random.default_rng(s).shuffle(sh)
        null_caps.append(ev.capture(ev.pu_scores(env, seed=s, labels=sh))["capture30"])
    out["nulls"] = (
        {"runs": null_caps, "min": min(null_caps), "max": max(null_caps), "mean": round(float(np.mean(null_caps)), 4)}
        if null_caps
        else None
    )
    return out


def current_scores(cells, feat, positive_keys, seed=7) -> np.ndarray:
    """Risk for today: every cell with any dumping report so far is a positive; cross-fitted scores."""
    is_pos = np.array([c in positive_keys for c in cells])
    ev = Evaluator(cells, feat, is_pos, np.zeros(len(cells), dtype=bool))
    return ev.pu_scores({**feat, "d_past_m": ev.d_past}, seed=seed)


def ci_scale() -> tuple[tuple[int, ...], int]:
    """Fewer seeds and nulls in CI to keep runs short; full counts locally."""
    if os.environ.get("HL_FAST"):
        return (1, 2, 3), 4
    return (1, 2, 3, 4, 5), 10
