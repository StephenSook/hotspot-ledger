"""Turn cached reports into the measured ledger: cells, hotspots, metrics, item mix, owner hints."""

from __future__ import annotations

import collections
import datetime as dt
import json
import math
import re
import statistics
from dataclasses import dataclass, field

from openlocationcode import openlocationcode as olc

from .config import DUMP_TYPES, HOTSPOT_MIN_REPORTS, ISSUES_CACHE, START_YEAR
from .geo import cell_center, cell_key, district_of, districts, in_city

ITEM_PATTERNS = {
    "tires": r"\btires?\b|\btyres?\b",
    "furniture": r"\bcouch(es)?\b|\bsofas?\b|\bmattress(es)?\b|\bfurniture\b|\bchairs?\b|\bdressers?\b|\bbox ?springs?\b|\brecliners?\b",
    "appliances": r"\bfridges?\b|\brefrigerators?\b|\bwashers?\b|\bdryers?\b|\bstoves?\b|\bappliances?\b|\btv'?s?\b|\btelevisions?\b",
    "bags": r"\bbags?\b|\bgarbage\b|\bhousehold\b|\btrash bags?\b",
    "construction": r"\bconstruction\b|\bdrywall\b|\bshingles?\b|\blumber\b|\bconcrete\b|\bbricks?\b|\bcarpet\b|\bdebris pile\b|\bbuilding materials?\b",
}
ITEM_RE = {k: re.compile(v, re.I) for k, v in ITEM_PATTERNS.items()}


def parse_t(s: str) -> dt.datetime:
    return dt.datetime.fromisoformat(s)


@dataclass
class Report:
    lat: float
    lng: float
    created: dt.datetime
    closed: dt.datetime | None
    rtype: str
    reporter: str
    items: tuple[str, ...]
    has_photo: bool
    street: str = ""
    key: tuple[int, int] = field(init=False)

    def __post_init__(self):
        self.key = cell_key(self.lat, self.lng)


def items_in(text: str) -> tuple[str, ...]:
    return tuple(k for k, rx in ITEM_RE.items() if rx.search(text or ""))


STREET_SUFFIX = re.compile(r"\b(St|Rd|Dr|Ave|Ln|Cir|Ct|Hwy|Way|Pkwy|Blvd|Trl|Pl|Ter|Pt)\b\.?", re.I)


def street_of(address: str) -> str:
    """Street name only: house numbers, city, state and ZIP are dropped. Public geography, not a person."""
    s = (address or "").split(",")[0]
    s = re.split(r"\s+(?:Mableton|Austell|Smyrna|Atlanta|Marietta|Powder Springs|GA|Georgia)\b", s, flags=re.I)[0]
    s = re.sub(r"^[\d\-a-zA-Z]*\d[\d\-a-zA-Z]*\s+", "", s.strip())  # leading house number like 1234 or 12-B
    s = re.sub(r"\s+", " ", s).strip()
    if not s or any(ch.isdigit() for ch in s.split(" ")[0]) or not STREET_SUFFIX.search(s):
        return ""
    words = []
    for w in s.split(" "):
        words.append(w.upper() if w.upper() in DIRECTIONS else w if w.isupper() and len(w) <= 3 else w.capitalize())
    return " ".join(words)[:48]


DIRECTIONS = {"SW", "SE", "NW", "NE", "N", "S", "E", "W", "&"}


def load_reports(path=ISSUES_CACHE) -> tuple[list[Report], int]:
    """(dumping-type reports inside the city since START_YEAR, all in-city reports since START_YEAR)."""
    raw = json.loads(path.read_text())
    dump, total_in_city = [], 0
    for i in raw:
        if not i.get("lng") or i["created_at"][:4] < str(START_YEAR):
            continue
        if not in_city(i["lng"], i["lat"]):
            continue
        total_in_city += 1
        rtype = (i.get("request_type") or {}).get("title") or ""
        if rtype not in DUMP_TYPES:
            continue
        media = i.get("media") or {}
        dump.append(
            Report(
                lat=float(i["lat"]),
                lng=float(i["lng"]),
                created=parse_t(i["created_at"]),
                closed=parse_t(i["closed_at"]) if i.get("closed_at") else None,
                rtype=rtype,
                reporter=i.get("reporter_hash", ""),
                items=items_in(f"{i.get('summary') or ''} {i.get('description') or ''}"),
                has_photo=bool(media.get("image_full")),
                street=street_of(i.get("address") or ""),
            )
        )
    dump.sort(key=lambda r: r.created)
    return dump, total_in_city


def top_reporter(reports: list[Report]) -> str:
    return collections.Counter(r.reporter for r in reports).most_common(1)[0][0]


def return_rates(reports: list[Report], now: dt.datetime, keep=lambda r: True) -> dict[str, dict]:
    """Share of closed reports followed by a new report in the same cell within N days."""
    by_cell = collections.defaultdict(list)
    for r in reports:
        by_cell[r.key].append(r)
    out = {}
    for days in (28, 56, 84):
        n = hit = 0
        win = dt.timedelta(days=days)
        for rows in by_cell.values():
            for k, r in enumerate(rows):
                if not keep(r) or r.closed is None or r.closed + win > now:
                    continue
                n += 1
                if any(r.closed < j.created <= r.closed + win for j in rows[k + 1 :]):
                    hit += 1
        out[str(days)] = {"closed": n, "returned": hit, "share": round(hit / n, 4) if n else None}
    return out


def capture_recapture(reports: list[Report], top: str, last_year: int) -> dict:
    """Two-source Chapman estimate of cells with dumping: the top account vs everyone else."""
    rows = [r for r in reports if r.created.year <= last_year]
    a = {r.key for r in rows if r.reporter == top}
    b = {r.key for r in rows if r.reporter != top}
    n1, n2, m = len(a), len(b), len(a & b)
    est = (n1 + 1) * (n2 + 1) / (m + 1) - 1
    var = (n1 + 1) * (n2 + 1) * (n1 - m) * (n2 - m) / ((m + 1) ** 2 * (m + 2))
    se = math.sqrt(var)
    return {
        "years": f"{reports[0].created.year}-{last_year}",
        "top_account_cells": n1,
        "other_cells": n2,
        "both": m,
        "seen": len(a | b),
        "estimate": round(est),
        "ci95": [round(est - 1.96 * se), round(est + 1.96 * se)],
        "note": "Floor: both sources watch the same roadsides, which biases the estimate low.",
    }


def build(reports: list[Report], total_in_city: int, now: dt.datetime) -> dict:
    top = top_reporter(reports)
    years = list(range(START_YEAR, now.year + 1))
    yearly = {y: sum(1 for r in reports if r.created.year == y) for y in years}
    yearly_others = {y: sum(1 for r in reports if r.created.year == y and r.reporter != top) for y in years}
    close_days = [(r.closed - r.created).total_seconds() / 86400 for r in reports if r.closed and r.closed >= r.created]

    cells: dict[tuple[int, int], dict] = {}
    for r in reports:
        c = cells.setdefault(
            r.key,
            {
                "n": 0,
                "n_others": 0,
                "years": collections.Counter(),
                "items": collections.Counter(),
                "streets": collections.Counter(),
                "years_others": collections.Counter(),
                "first": r.created,
                "last": r.created,
                "photos": 0,
                "lat_sum": 0.0,
                "lng_sum": 0.0,
            },
        )
        c["n"] += 1
        c["n_others"] += r.reporter != top
        c["years"][r.created.year] += 1
        if r.reporter != top:
            c["years_others"][r.created.year] += 1
        for it in r.items:
            c["items"][it] += 1
        if r.street:
            c["streets"][r.street] += 1
        c["first"] = min(c["first"], r.created)
        c["last"] = max(c["last"], r.created)
        c["photos"] += r.has_photo
        c["lat_sum"] += r.lat
        c["lng_sum"] += r.lng

    hot = {k: c for k, c in cells.items() if c["n"] >= HOTSPOT_MIN_REPORTS}
    by_district = collections.Counter(district_of(r.lng, r.lat) or "outside" for r in reports)
    pops = {name: pop for name, pop, _ in districts()}
    twelve_months_ago = now - dt.timedelta(days=365)

    cell_rows = []
    for k, c in cells.items():
        lat, lng = c["lat_sum"] / c["n"], c["lng_sum"] / c["n"]
        clat, clng = cell_center(k)
        cell_rows.append(
            {
                "id": f"{k[0]}_{k[1]}",
                "lat": round(lat, 6),
                "lng": round(lng, 6),
                "cell_lat": round(clat, 6),
                "cell_lng": round(clng, 6),
                "street": c["streets"].most_common(1)[0][0] if c["streets"] else "",
                "n": c["n"],
                "n_others": c["n_others"],
                "hotspot": c["n"] >= HOTSPOT_MIN_REPORTS,
                "years": {str(y): c["years"].get(y, 0) for y in years},
                "years_others": {str(y): c["years_others"].get(y, 0) for y in years},
                "items": {it: c["items"].get(it, 0) for it in ITEM_PATTERNS},
                "first": c["first"].date().isoformat(),
                "last": c["last"].date().isoformat(),
                "last_12_months": sum(1 for r in reports if r.key == k and r.created >= twelve_months_ago),
                "photos": c["photos"],
                "district": district_of(lng, lat),
                "plus_code": olc.encode(lat, lng, 10),
            }
        )
    cell_rows.sort(key=lambda c: -c["n"])

    metrics = {
        "generated_at": now.isoformat(timespec="seconds"),
        "window": f"{START_YEAR}-01-01 to {now.date().isoformat()}",
        "reports_total_in_city": total_in_city,
        "dumping_reports": len(reports),
        "dumping_share": round(len(reports) / total_in_city, 4),
        "yearly": {str(y): yearly[y] for y in years},
        "yearly_without_top_account": {str(y): yearly_others[y] for y in years},
        "top_account_share": round(sum(1 for r in reports if r.reporter == top) / len(reports), 4),
        "cells_with_dumping": len(cells),
        "hotspots": len(hot),
        "hotspot_report_share": round(sum(c["n"] for c in hot.values()) / len(reports), 4),
        "median_close_days": round(statistics.median(close_days), 2) if close_days else None,
        "p90_close_days": round(statistics.quantiles(close_days, n=10)[-1], 2) if len(close_days) > 10 else None,
        "photo_share": round(sum(r.has_photo for r in reports) / len(reports), 4),
        "items": {it: sum(1 for r in reports if it in r.items) for it in ITEM_PATTERNS},
        "districts": {d: {"reports": by_district.get(d, 0), "population": pops.get(d)} for d in sorted(pops)},
        "return_rates": return_rates(reports, now),
        "return_rates_without_top_account": return_rates(reports, now, keep=lambda r: r.reporter != top),
        "capture_recapture": capture_recapture(reports, top, last_year=now.year - 1),
    }
    return {"metrics": metrics, "cells": cell_rows, "top": top}
