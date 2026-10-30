"""Paths and constants shared by every pipeline step."""

from pathlib import Path

PIPE = Path(__file__).resolve().parents[1]
ROOT = PIPE.parent
DATA_IN = PIPE / "data"
CACHE = PIPE / "cache"
OUT = ROOT / "web" / "public" / "data"

CITY_GEOJSON = DATA_IN / "mableton_citylimit_cobb.geojson"
DISTRICTS_GEOJSON = DATA_IN / "mableton_council_districts.geojson"
ISSUES_CACHE = CACHE / "scf_issues.json"
OSM_CACHE = CACHE / "osm.json"
TRACTS_CACHE = CACHE / "tracts.geojson"
ACS_CACHE = CACHE / "acs_tracts.json"

# ~150 m grid; the same cell definition is used everywhere so counts stay comparable.
LAT_STEP = 0.00135
LNG_STEP = 0.0016

DUMP_TYPES = {"Debris on Shoulder", "Litter|Graffiti"}
START_YEAR = 2021
HOTSPOT_MIN_REPORTS = 3

SCF_API = "https://seeclickfix.com/api/v2/issues"
SCF_MIN_INTERVAL_S = 3.2  # SeeClickFix allows 20 requests a minute
USER_AGENT = "HotspotLedger/0.1 (Georgia 311 Challenge student prototype; https://github.com/StephenSook/hotspot-ledger)"
