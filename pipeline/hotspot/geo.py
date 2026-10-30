"""Geometry helpers: point-in-polygon, grid cells and local metric coordinates."""

from __future__ import annotations

import json
import math
from functools import lru_cache

from .config import CITY_GEOJSON, DISTRICTS_GEOJSON, LAT_STEP, LNG_STEP

LAT0 = 33.81
LNG0 = -84.57
KX = 111320.0 * math.cos(math.radians(LAT0))
KY = 110540.0


def polygons(geom: dict) -> list:
    return [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]


def point_in_polygon(x: float, y: float, poly: list) -> bool:
    """Even-odd rule over all rings, so holes are handled."""
    inside = False
    for ring in poly:
        j = len(ring) - 1
        for i in range(len(ring)):
            xi, yi = ring[i][:2]
            xj, yj = ring[j][:2]
            if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi:
                inside = not inside
            j = i
    return inside


@lru_cache(maxsize=1)
def city_polygons() -> list:
    feat = json.loads(CITY_GEOJSON.read_text())["features"][0]
    return polygons(feat["geometry"])


@lru_cache(maxsize=1)
def districts() -> list[tuple[str, int, list]]:
    out = []
    for f in json.loads(DISTRICTS_GEOJSON.read_text())["features"]:
        p = f["properties"]
        out.append((str(p["DISTRICT"]).lstrip("0") or "0", int(p.get("POPULATION") or 0), polygons(f["geometry"])))
    return out


def in_city(lng: float, lat: float) -> bool:
    return any(point_in_polygon(lng, lat, p) for p in city_polygons())


def district_of(lng: float, lat: float) -> str | None:
    for name, _pop, polys in districts():
        if any(point_in_polygon(lng, lat, p) for p in polys):
            return name
    return None


def cell_key(lat: float, lng: float) -> tuple[int, int]:
    return (round(lat / LAT_STEP), round(lng / LNG_STEP))


def cell_center(key: tuple[int, int]) -> tuple[float, float]:
    """(lat, lng) of a cell's center."""
    return (key[0] * LAT_STEP, key[1] * LNG_STEP)


def to_xy(lng: float, lat: float) -> tuple[float, float]:
    """Local equirectangular meters around Mableton; fine at city scale."""
    return ((lng - LNG0) * KX, (lat - LAT0) * KY)


def city_bbox(pad: float = 0.0) -> tuple[float, float, float, float]:
    """(min_lat, min_lng, max_lat, max_lng)."""
    lons = [c[0] for p in city_polygons() for r in p for c in r]
    lats = [c[1] for p in city_polygons() for r in p for c in r]
    return (min(lats) - pad, min(lons) - pad, max(lats) + pad, max(lons) + pad)
