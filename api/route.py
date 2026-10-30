"""POST /api/route: order a crew's stops with Google OR-Tools.

Request:  {"stops": [{"id": str, "lat": float, "lng": float}, ...], "start_id": str | null}
Response: {"order": [id, ...], "distance_km": float, "solver": "ortools"}

The route is an open path: it starts at `start_id` (or the first stop) and does not return.
Distances are great-circle (haversine), so the order is a straight-line approximation of drive
time. Nothing here needs a key or touches personal data.
"""

from __future__ import annotations

import json
import math
import re
from http.server import BaseHTTPRequestHandler
from typing import NamedTuple

MIN_STOPS = 2
MAX_STOPS = 25
MAX_BODY_BYTES = 8 * 1024
LAT_RANGE = (33.6, 34.0)
LNG_RANGE = (-84.8, -84.3)
ID_PATTERN = re.compile(r"[A-Za-z0-9_.:+-]{1,64}")
TOP_KEYS = frozenset({"stops", "start_id"})
STOP_KEYS = frozenset({"id", "lat", "lng"})
EARTH_RADIUS_KM = 6371.0088
TIME_LIMIT_S = 2.0


class Stop(NamedTuple):
    id: str
    lat: float
    lng: float


class InputError(ValueError):
    """Bad request input. The message is safe to return to the client."""


class SolverError(RuntimeError):
    pass


def _reject_constant(name: str) -> None:
    # json.loads accepts NaN / Infinity by default; they are not JSON and not coordinates.
    raise InputError(f"invalid number {name}")


def _no_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    out: dict[str, object] = {}
    for key, value in pairs:
        if key in out:
            raise InputError(f"duplicate key {key!r}")
        out[key] = value
    return out


def parse_json(raw: bytes) -> object:
    if len(raw) > MAX_BODY_BYTES:
        raise InputError(f"body larger than {MAX_BODY_BYTES} bytes")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise InputError("body is not UTF-8") from None
    try:
        return json.loads(text, parse_constant=_reject_constant, object_pairs_hook=_no_duplicate_keys)
    except InputError:
        raise
    except (ValueError, RecursionError):
        raise InputError("body is not valid JSON") from None


def _coordinate(value: object, name: str, bounds: tuple[float, float]) -> float:
    # bool is a subclass of int in Python, so it must be excluded explicitly.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise InputError(f"{name} must be a number")
    # Range check before any float() call: a huge JSON integer would overflow float conversion.
    if (isinstance(value, float) and not math.isfinite(value)) or not bounds[0] <= value <= bounds[1]:
        raise InputError(f"{name} must be between {bounds[0]} and {bounds[1]}")
    return float(value)


def validate_payload(payload: object) -> tuple[list[Stop], int]:
    """Return the stops and the index of the start stop, or raise InputError."""
    if not isinstance(payload, dict):
        raise InputError("body must be a JSON object")
    unknown = set(payload) - TOP_KEYS
    if unknown:
        raise InputError(f"unknown key {sorted(unknown)[0]!r}")
    raw_stops = payload.get("stops")
    if not isinstance(raw_stops, list):
        raise InputError("stops must be an array")
    if not MIN_STOPS <= len(raw_stops) <= MAX_STOPS:
        raise InputError(f"stops must have {MIN_STOPS} to {MAX_STOPS} entries")

    stops: list[Stop] = []
    seen: set[str] = set()
    for i, raw in enumerate(raw_stops):
        where = f"stops[{i}]"
        if not isinstance(raw, dict):
            raise InputError(f"{where} must be an object")
        missing = STOP_KEYS - set(raw)
        if missing:
            raise InputError(f"{where} is missing {sorted(missing)[0]!r}")
        extra = set(raw) - STOP_KEYS
        if extra:
            raise InputError(f"{where} has unknown key {sorted(extra)[0]!r}")
        stop_id = raw["id"]
        if not isinstance(stop_id, str) or not ID_PATTERN.fullmatch(stop_id):
            raise InputError(f"{where}.id must be 1 to 64 characters of A-Z a-z 0-9 _ . : + -")
        if stop_id in seen:
            raise InputError(f"duplicate stop id {stop_id!r}")
        seen.add(stop_id)
        lat = _coordinate(raw["lat"], f"{where}.lat", LAT_RANGE)
        lng = _coordinate(raw["lng"], f"{where}.lng", LNG_RANGE)
        stops.append(Stop(stop_id, lat, lng))

    start_id = payload.get("start_id")
    if start_id is None:
        return stops, 0
    if not isinstance(start_id, str):
        raise InputError("start_id must be a string or null")
    for index, stop in enumerate(stops):
        if stop.id == start_id:
            return stops, index
    raise InputError("start_id is not one of the stop ids")


def haversine_km(a: Stop, b: Stop) -> float:
    phi1, phi2 = math.radians(a.lat), math.radians(b.lat)
    dphi = phi2 - phi1
    dlmb = math.radians(b.lng - a.lng)
    h = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlmb / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(min(1.0, math.sqrt(h)))


def path_length_km(stops: list[Stop], order: list[int]) -> float:
    return sum(haversine_km(stops[i], stops[j]) for i, j in zip(order, order[1:]))


def solve_open_path(stops: list[Stop], start: int, time_limit_s: float | None = None) -> list[int]:
    """Indices of `stops` in visiting order, starting at `start`, minimising total distance.

    OR-Tools routes are closed (start node to end node), so an open path is modelled with a dummy
    end node that every stop reaches at zero cost: the vehicle "finishes" wherever it last stops.
    """
    from ortools.constraint_solver import pywrapcp, routing_enums_pb2

    n = len(stops)
    dummy = n
    # Integer metres: the routing solver works on integer arc costs.
    metres = [[round(haversine_km(a, b) * 1000) for b in stops] for a in stops]

    manager = pywrapcp.RoutingIndexManager(n + 1, 1, [start], [dummy])
    routing = pywrapcp.RoutingModel(manager)

    def arc_cost(from_index: int, to_index: int) -> int:
        i, j = manager.IndexToNode(from_index), manager.IndexToNode(to_index)
        if i == dummy or j == dummy:
            return 0
        return metres[i][j]

    callback = routing.RegisterTransitCallback(arc_cost)
    routing.SetArcCostEvaluatorOfAllVehicles(callback)

    params = pywrapcp.DefaultRoutingSearchParameters()
    params.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
    params.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    limit = TIME_LIMIT_S if time_limit_s is None else time_limit_s
    params.time_limit.FromMilliseconds(max(1, int(limit * 1000)))

    solution = routing.SolveWithParameters(params)
    if solution is None:
        raise SolverError("no route found")

    order: list[int] = []
    index = routing.Start(0)
    while not routing.IsEnd(index):
        order.append(manager.IndexToNode(index))
        index = solution.Value(routing.NextVar(index))
    if sorted(order) != list(range(n)) or order[0] != start:
        raise SolverError("solver returned an incomplete route")
    return order


def plan_route(payload: object, time_limit_s: float | None = None) -> dict[str, object]:
    stops, start = validate_payload(payload)
    order = solve_open_path(stops, start, time_limit_s)
    return {
        "order": [stops[i].id for i in order],
        "distance_km": round(path_length_km(stops, order), 3),
        "solver": "ortools",
    }


class handler(BaseHTTPRequestHandler):
    def _send(self, status: int, body: dict[str, object], allow: bool = False) -> None:
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if allow:
            self.send_header("Allow", "POST")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _method_not_allowed(self) -> None:
        self._send(405, {"error": "method_not_allowed"}, allow=True)

    do_GET = do_HEAD = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = _method_not_allowed

    def do_POST(self) -> None:
        content_type = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if content_type != "application/json":
            self._send(400, {"error": "Content-Type must be application/json"})
            return
        try:
            length = int(self.headers.get("Content-Length") or "")
        except ValueError:
            self._send(400, {"error": "Content-Length is required"})
            return
        if length < 0 or length > MAX_BODY_BYTES:
            # Refuse before reading, so an oversized body is never buffered.
            self._send(400, {"error": f"body larger than {MAX_BODY_BYTES} bytes"})
            return
        try:
            result = plan_route(parse_json(self.rfile.read(length)))
        except InputError as exc:
            self._send(400, {"error": str(exc)})
            return
        except Exception:  # solver or import failure: never leak internals to the client
            self.log_error("route solver failed")
            self._send(500, {"error": "solver_failed"})
            return
        self._send(200, result)

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002 (stdlib signature)
        # The default writes the request line to stderr; keep only our own error lines.
        if format.startswith("route "):
            super().log_message(format, *args)
