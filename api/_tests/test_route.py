"""Tests for api/route.py. Run: uv run --no-project --python 3.12 --with pytest --with ortools pytest api/_tests -q

This folder starts with an underscore on purpose: Vercel turns every .py/.ts file under api/ into
a function unless a path segment starts with "_" or ".".
"""

from __future__ import annotations

import importlib.util
import itertools
import json
import random
import threading
import urllib.error
import urllib.request
from http.server import HTTPServer
from pathlib import Path

import pytest

ROUTE_PATH = Path(__file__).resolve().parents[1] / "route.py"
_spec = importlib.util.spec_from_file_location("hotspot_route_fn", ROUTE_PATH)
assert _spec and _spec.loader
route = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(route)

FAST = 0.3  # seconds; the deployed function uses route.TIME_LIMIT_S (2 s)


def stop(i, lat, lng):
    return {"id": i, "lat": lat, "lng": lng}


# ---------------------------------------------------------------- solver

def test_line_of_stops_is_walked_in_order_from_the_start():
    lat = 33.82
    stops = [stop("c", lat, -84.56), stop("a", lat, -84.60), stop("d", lat, -84.54), stop("b", lat, -84.58)]
    out = route.plan_route({"stops": stops, "start_id": "a"}, time_limit_s=FAST)
    assert out["order"] == ["a", "b", "c", "d"]
    assert out["solver"] == "ortools"


def test_open_path_goes_to_the_near_end_first():
    # Start in the middle. B->A->C (0.01 + 0.10 deg) beats B->C->A (0.09 + 0.10 deg).
    lat = 33.82
    stops = [stop("B", lat, -84.59), stop("A", lat, -84.60), stop("C", lat, -84.50)]
    out = route.plan_route({"stops": stops, "start_id": "B"}, time_limit_s=FAST)
    assert out["order"] == ["B", "A", "C"]
    expected = route.haversine_km(route.Stop("B", lat, -84.59), route.Stop("A", lat, -84.60)) + route.haversine_km(
        route.Stop("A", lat, -84.60), route.Stop("C", lat, -84.50)
    )
    assert out["distance_km"] == pytest.approx(expected, abs=0.001)


def test_start_defaults_to_first_stop():
    stops = [stop("x", 33.80, -84.58), stop("y", 33.81, -84.58)]
    out = route.plan_route({"stops": stops}, time_limit_s=FAST)
    assert out["order"] == ["x", "y"]
    out = route.plan_route({"stops": stops, "start_id": None}, time_limit_s=FAST)
    assert out["order"] == ["x", "y"]


def test_matches_brute_force_optimum_on_random_instances():
    rng = random.Random(311)
    for _ in range(3):
        pts = [route.Stop(f"s{i}", rng.uniform(33.75, 33.87), rng.uniform(-84.64, -84.50)) for i in range(7)]
        best = min(
            route.path_length_km(pts, [0, *perm]) for perm in itertools.permutations(range(1, len(pts)))
        )
        order = route.solve_open_path(pts, 0, time_limit_s=FAST)
        assert order[0] == 0 and sorted(order) == list(range(7))
        # Arc costs are rounded to whole metres, so allow a few metres of slack.
        assert route.path_length_km(pts, order) == pytest.approx(best, abs=0.01)


def test_haversine_one_hundredth_degree_latitude():
    a, b = route.Stop("a", 33.80, -84.6), route.Stop("b", 33.81, -84.6)
    assert route.haversine_km(a, b) == pytest.approx(1.112, abs=0.001)


# ------------------------------------------------------------ validation

GOOD = [stop("a", 33.8, -84.6), stop("b", 33.81, -84.59)]


@pytest.mark.parametrize(
    "payload, needle",
    [
        ([], "JSON object"),
        ({}, "stops must be an array"),
        ({"stops": "a,b"}, "stops must be an array"),
        ({"stops": GOOD[:1]}, "2 to 25"),
        ({"stops": [stop(f"s{i}", 33.8, -84.6) for i in range(26)]}, "2 to 25"),
        ({"stops": GOOD, "extra": 1}, "unknown key"),
        ({"stops": [GOOD[0], {"id": "b", "lat": 33.8}]}, "missing 'lng'"),
        ({"stops": [GOOD[0], {**GOOD[1], "label": "x"}]}, "unknown key 'label'"),
        ({"stops": [GOOD[0], "b"]}, "must be an object"),
        ({"stops": [GOOD[0], stop(7, 33.8, -84.6)]}, ".id must be"),
        ({"stops": [GOOD[0], stop("", 33.8, -84.6)]}, ".id must be"),
        ({"stops": [GOOD[0], stop("x" * 65, 33.8, -84.6)]}, ".id must be"),
        ({"stops": [GOOD[0], stop("a b", 33.8, -84.6)]}, ".id must be"),
        ({"stops": [GOOD[0], stop("a", 33.81, -84.6)]}, "duplicate stop id"),
        ({"stops": [GOOD[0], stop("b", 33.5, -84.6)]}, "lat must be between"),
        ({"stops": [GOOD[0], stop("b", 34.01, -84.6)]}, "lat must be between"),
        ({"stops": [GOOD[0], stop("b", 33.8, -84.9)]}, "lng must be between"),
        ({"stops": [GOOD[0], stop("b", 33.8, -84.2)]}, "lng must be between"),
        ({"stops": [GOOD[0], stop("b", "33.8", -84.6)]}, "lat must be a number"),
        ({"stops": [GOOD[0], stop("b", True, -84.6)]}, "lat must be a number"),
        ({"stops": [GOOD[0], stop("b", None, -84.6)]}, "lat must be a number"),
        ({"stops": [GOOD[0], stop("b", 10**400, -84.6)]}, "lat must be between"),
        ({"stops": GOOD, "start_id": 3}, "start_id must be a string"),
        ({"stops": GOOD, "start_id": "zzz"}, "not one of the stop ids"),
    ],
)
def test_rejects_bad_payloads(payload, needle):
    with pytest.raises(route.InputError, match=None) as err:
        route.validate_payload(payload)
    assert needle in str(err.value)


@pytest.mark.parametrize(
    "raw, needle",
    [
        (b'{"stops": [{"id":"a","lat":NaN,"lng":-84.6}]}', "invalid number NaN"),
        (b'{"stops": [{"id":"a","lat":Infinity,"lng":-84.6}]}', "invalid number Infinity"),
        (b'{"stops": [], "stops": []}', "duplicate key"),
        (b"\xff\xfe{}", "not UTF-8"),
        (b'{"stops": [', "not valid JSON"),
        (b"[" * 5000 + b"]" * 5000, "larger than"),
        (b" " * (route.MAX_BODY_BYTES + 1), "larger than"),
    ],
)
def test_parse_json_rejects(raw, needle):
    with pytest.raises(route.InputError) as err:
        route.parse_json(raw)
    assert needle in str(err.value)


def test_parse_json_accepts_plain_payload():
    raw = json.dumps({"stops": GOOD, "start_id": "b"}).encode()
    stops, start = route.validate_payload(route.parse_json(raw))
    assert [s.id for s in stops] == ["a", "b"] and start == 1


# --------------------------------------------------------- HTTP handler

@pytest.fixture(scope="module")
def server():
    route.TIME_LIMIT_S = FAST
    httpd = HTTPServer(("127.0.0.1", 0), route.handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}/api/route"
    httpd.shutdown()
    route.TIME_LIMIT_S = 2.0


def call(url, method="POST", body=None, content_type="application/json"):
    headers = {"Content-Type": content_type} if content_type else {}
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            return res.status, dict(res.headers), json.loads(res.read())
    except urllib.error.HTTPError as err:
        payload = err.read()
        return err.code, dict(err.headers), json.loads(payload) if payload else None


def test_http_post_returns_order(server):
    status, headers, body = call(server, body=json.dumps({"stops": GOOD, "start_id": None}).encode())
    assert status == 200
    assert body["order"] == ["a", "b"] and body["solver"] == "ortools"
    assert isinstance(body["distance_km"], float)
    assert headers["Content-Type"].startswith("application/json")
    assert headers["Cache-Control"] == "no-store"


@pytest.mark.parametrize("method", ["GET", "PUT", "DELETE", "PATCH", "OPTIONS"])
def test_http_non_post_is_405(server, method):
    status, headers, body = call(server, method=method, body=None, content_type=None)
    assert status == 405
    assert headers["Allow"] == "POST"
    assert body == {"error": "method_not_allowed"}


def test_http_bad_input_is_400_with_error_json(server):
    status, _, body = call(server, body=b'{"stops": []}')
    assert status == 400 and "2 to 25" in body["error"]


def test_http_requires_json_content_type(server):
    status, _, body = call(server, body=json.dumps({"stops": GOOD}).encode(), content_type="text/plain")
    assert status == 400 and "Content-Type" in body["error"]


def test_http_oversized_body_is_refused(server):
    status, _, body = call(server, body=b" " * (route.MAX_BODY_BYTES + 1))
    assert status == 400 and "larger than" in body["error"]
