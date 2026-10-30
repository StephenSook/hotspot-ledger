"""Vector layers for the web map (no third-party tiles) and the likely-owner hint per spot.

Roads, rail and streams: (c) OpenStreetMap contributors, ODbL. City limit and districts: Cobb County GIS.
"""

from __future__ import annotations

import json
import math
import re

import numpy as np
from scipy.spatial import cKDTree

from .config import CITY_GEOJSON, DISTRICTS_GEOJSON
from .geo import city_bbox, polygons, to_xy

ROAD_CLASS = {
    "motorway": "major",
    "motorway_link": "major",
    "trunk": "major",
    "trunk_link": "major",
    "primary": "major",
    "primary_link": "major",
    "secondary": "major",
    "secondary_link": "major",
    "tertiary": "minor",
    "tertiary_link": "minor",
    "residential": "local",
    "unclassified": "local",
    "living_street": "local",
    "service": "service",
}
STATE_REF = re.compile(r"\b(US|GA|SR|I)[- ]?\d+", re.I)


def _dp(pts, eps):
    """Douglas-Peucker on (x, y) points; returns indexes to keep."""
    if len(pts) < 3:
        return list(range(len(pts)))
    keep = [0, len(pts) - 1]
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (x1, y1), (x2, y2) = pts[a], pts[b]
        dmax, idx = 0.0, None
        den = math.hypot(x2 - x1, y2 - y1) or 1e-9
        for k in range(a + 1, b):
            x0, y0 = pts[k]
            d = abs((y2 - y1) * x0 - (x2 - x1) * y0 + x2 * y1 - y2 * x1) / den
            if d > dmax:
                dmax, idx = d, k
        if idx is not None and dmax > eps:
            keep.append(idx)
            stack += [(a, idx), (idx, b)]
    return sorted(set(keep))


def _line(coords_lnglat, eps_m):
    xy = [to_xy(x, y) for x, y in coords_lnglat]
    return [[round(coords_lnglat[i][0], 5), round(coords_lnglat[i][1], 5)] for i in _dp(xy, eps_m)]


def _ring(coords, eps_m):
    """Simplify a closed ring by splitting it at the vertex farthest from the start."""
    if len(coords) < 4:
        return [[round(x, 5), round(y, 5)] for x, y in coords]
    x0, y0 = coords[0][:2]
    far = max(range(len(coords)), key=lambda k: math.hypot(coords[k][0] - x0, coords[k][1] - y0))
    a = _line([c[:2] for c in coords[: far + 1]], eps_m)
    b = _line([c[:2] for c in coords[far:]], eps_m)
    return a[:-1] + b


def boundary_layers() -> dict:
    city = json.loads(CITY_GEOJSON.read_text())["features"][0]["geometry"]
    city_lines = [_ring(r, 4.0) for p in polygons(city) for r in p]
    dists = []
    for f in json.loads(DISTRICTS_GEOJSON.read_text())["features"]:
        name = str(f["properties"]["DISTRICT"]).lstrip("0")
        for p in polygons(f["geometry"]):
            for r in p:
                dists.append({"district": name, "path": _ring(r, 6.0)})
    return {"city": city_lines, "districts": dists}


def road_layers(osm_elements) -> dict:
    s, w, n, e = city_bbox(pad=0.004)
    out = {"major": [], "minor": [], "local": [], "service": [], "rail": [], "water": []}
    for el in osm_elements:
        t, g = el.get("tags", {}), el.get("geometry") or []
        if len(g) < 2:
            continue
        if not any(s <= p["lat"] <= n and w <= p["lon"] <= e for p in g):
            continue
        coords = [(p["lon"], p["lat"]) for p in g]
        if "highway" in t and t["highway"] in ROAD_CLASS:
            cls = ROAD_CLASS[t["highway"]]
            out[cls].append(_line(coords, 3.0 if cls in ("major", "minor") else 5.0))
        elif t.get("railway") == "rail":
            out["rail"].append(_line(coords, 4.0))
        elif "waterway" in t:
            out["water"].append(_line(coords, 6.0))
    return out


def owner_hints(cells: list[dict], osm_elements) -> None:
    """Adds `owner_hint` to each cell: a state route within 60 m means GDOT; otherwise confirm."""
    pts, refs = [], []
    for el in osm_elements:
        t, g = el.get("tags", {}), el.get("geometry") or []
        if "highway" not in t or len(g) < 2:
            continue
        ref = t.get("ref", "")
        if not STATE_REF.search(ref):
            continue
        for p in g:
            pts.append(to_xy(p["lon"], p["lat"]))
            refs.append(ref.split(";")[0].strip())
    tree = cKDTree(np.array(pts)) if pts else None
    for c in cells:
        hint = {"owner": "confirm", "label": "Local road or private parcel: confirm the owner"}
        if tree is not None:
            d, k = tree.query(to_xy(c["lng"], c["lat"]))
            if d <= 60:
                hint = {"owner": "gdot", "label": f"State route {refs[k]}: coordinate with GDOT", "distance_m": round(float(d))}
        c["owner_hint"] = hint
