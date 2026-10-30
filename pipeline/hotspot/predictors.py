"""Public predictor layers: OpenStreetMap roads, rail and streams; ACS tract income and tenure.

OpenStreetMap data (c) OpenStreetMap contributors, ODbL. ACS values come through Google Data
Commons, which serves them with no key (the Census Data API now answers "Missing Key" as an
HTTP 200 HTML page, so every fetch here is content-checked).
"""

from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request

from .config import ACS_CACHE, CACHE, OSM_CACHE, TRACTS_CACHE, USER_AGENT
from .geo import city_bbox

OVERPASS = ("https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter")
DC_WITHIN = "https://datacommons.org/api/observations/point/within"
TIGER = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Tracts_Blocks/MapServer/0/query"
DC_VARS = ("Median_Income_Household", "Count_HousingUnit_RenterOccupied", "Count_HousingUnit_OwnerOccupied")


def _get(url: str, data: bytes | None = None, timeout: int = 180) -> bytes:
    req = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def osm(refresh: bool = False) -> list[dict]:
    if OSM_CACHE.exists() and not refresh:
        return json.loads(OSM_CACHE.read_text())["elements"]
    s, w, n, e = city_bbox(pad=0.01)
    q = f"""[out:json][timeout:150];
(
  way["highway"]({s},{w},{n},{e});
  way["railway"="rail"]({s},{w},{n},{e});
  way["waterway"~"^(river|stream|creek|canal|ditch)$"]({s},{w},{n},{e});
);
out tags geom;"""
    last = None
    for ep in OVERPASS:
        try:
            data = json.loads(_get(ep, urllib.parse.urlencode({"data": q}).encode()))
            if not data.get("elements"):
                raise RuntimeError("Overpass returned zero elements")
            CACHE.mkdir(parents=True, exist_ok=True)
            OSM_CACHE.write_text(json.dumps(data))
            return data["elements"]
        except Exception as ex:  # try the next mirror, keep the reason
            last = ex
            time.sleep(5)
    raise RuntimeError(f"no OpenStreetMap data: {last}")


def tracts(refresh: bool = False) -> list[dict]:
    if TRACTS_CACHE.exists() and not refresh:
        return json.loads(TRACTS_CACHE.read_text())["features"]
    url = (
        TIGER
        + "?"
        + urllib.parse.urlencode(
            {
                "where": "STATE='13' AND COUNTY='067'",
                "outFields": "GEOID",
                "returnGeometry": "true",
                "outSR": "4326",
                "f": "geojson",
            }
        )
    )
    data = json.loads(_get(url))
    if len(data.get("features", [])) < 100:
        raise RuntimeError("TIGERweb returned too few Cobb County tracts")
    CACHE.mkdir(parents=True, exist_ok=True)
    TRACTS_CACHE.write_text(json.dumps(data))
    return data["features"]


def acs(refresh: bool = False) -> dict[str, dict[str, float]]:
    """{GEOID: {variable: value}} for Cobb County tracts."""
    if ACS_CACHE.exists() and not refresh:
        return json.loads(ACS_CACHE.read_text())
    out: dict[str, dict[str, float]] = {}
    for var in DC_VARS:
        url = f"{DC_WITHIN}?parentEntity=geoId/13067&childType=CensusTract&variables={var}"
        body = json.loads(_get(url, timeout=90))
        vals = body["data"][var]
        if len(vals) < 100:
            raise RuntimeError(f"Data Commons returned too few tracts for {var}")
        for geo, v in vals.items():
            out.setdefault(geo.split("/")[1], {})[var] = v["value"]
    CACHE.mkdir(parents=True, exist_ok=True)
    ACS_CACHE.write_text(json.dumps(out))
    return out
