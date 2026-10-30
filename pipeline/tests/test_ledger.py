import datetime as dt
import json

import pytest

from hotspot import cli, ledger
from hotspot.config import OUT
from hotspot.geo import cell_key, in_city, point_in_polygon

T = lambda s: dt.datetime.fromisoformat(s)  # noqa: E731


def rep(lat, lng, created, closed=None, reporter="a", items=()):
    return ledger.Report(
        lat=lat,
        lng=lng,
        created=T(created),
        closed=T(closed) if closed else None,
        rtype="Debris on Shoulder",
        reporter=reporter,
        items=tuple(items),
        has_photo=False,
    )


def test_point_in_polygon_square_with_hole():
    square = [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]]
    assert point_in_polygon(1, 1, square)
    assert not point_in_polygon(5, 5, square)  # inside the hole
    assert not point_in_polygon(11, 1, square)


def test_city_polygon_contains_front_st_and_not_downtown_atlanta():
    assert in_city(-84.58226, 33.82006)  # Front St SW, Mableton
    assert not in_city(-84.3880, 33.7490)  # downtown Atlanta


@pytest.mark.parametrize(
    "address,street",
    [
        ("5300 Front St SW Mableton GA 30126, USA", "Front St SW"),
        ("Fulton Industrial Blvd SW Atlanta, GA", "Fulton Industrial Blvd SW"),
        ("6420 dodgen rd sw, Mableton", "Dodgen Rd SW"),
        ("Unknown location", ""),
        ("", ""),
    ],
)
def test_street_of_drops_house_numbers_and_cities(address, street):
    assert ledger.street_of(address) == street


def test_item_patterns():
    assert ledger.items_in("Pile of TIRES and a mattress") == ("tires", "furniture")
    assert ledger.items_in("old refrigerator by the creek") == ("appliances",)
    assert ledger.items_in("nothing to see") == ()


def test_return_rate_counts_only_full_windows_and_same_cell():
    now = T("2026-10-29T00:00:00+00:00")
    rows = [
        rep(33.8200, -84.5800, "2026-01-01T00:00:00+00:00", "2026-01-02T00:00:00+00:00"),
        rep(33.8200, -84.5800, "2026-01-20T00:00:00+00:00", "2026-01-21T00:00:00+00:00"),  # returns within 28 d
        rep(33.8400, -84.5400, "2026-01-05T00:00:00+00:00", "2026-01-06T00:00:00+00:00"),  # other cell, never returns
        rep(33.8200, -84.5800, "2026-10-20T00:00:00+00:00", "2026-10-21T00:00:00+00:00"),  # window not complete
    ]
    rows.sort(key=lambda r: r.created)
    rr = ledger.return_rates(rows, now)
    assert rr["28"]["closed"] == 3
    assert rr["28"]["returned"] == 1


def test_capture_recapture_chapman():
    rows = []
    # top account sees cells A, B; others see B, C -> n1=2, n2=2, m=1 -> (3*3)/2 - 1 = 3.5
    for k, (lat, who) in enumerate([(33.80, "top"), (33.81, "top"), (33.81, "x"), (33.82, "x")]):
        rows.append(rep(lat, -84.58, f"2025-0{k + 1}-01T00:00:00+00:00", reporter=who))
    cr = ledger.capture_recapture(rows, "top", last_year=2025)
    assert cr["seen"] == 3 and cr["both"] == 1
    assert cr["estimate"] == round(3.5)


def test_cell_key_is_stable_grid():
    assert cell_key(33.82006, -84.58226) == cell_key(33.82010, -84.58230)


def test_privacy_guard_rejects_identifiers_text_and_addresses():
    with pytest.raises(ValueError):
        cli.privacy_guard({"reporter_hash": "abc"}, set())
    with pytest.raises(ValueError):
        cli.privacy_guard({"x": ["d9dcdf123456"]}, {"d9dcdf123456"})
    with pytest.raises(ValueError):
        cli.privacy_guard({"street": "5300 Front St SW"}, set())
    cli.privacy_guard({"street": "Front St SW", "n": 3}, set())  # street names alone are fine


@pytest.mark.skipif(not (OUT / "cells.json").exists(), reason="run the pipeline first")
def test_published_files_carry_no_identifying_fields():
    for name in ("cells.json", "metrics.json", "risk.json", "model.json", "meta.json"):
        text = (OUT / name).read_text()
        for bad in ('"reporter', '"description"', '"summary"', '"address"', '"media"', "seeclickfix.com/rails"):
            assert bad not in text, f"{bad} leaked into {name}"
    cells = json.loads((OUT / "cells.json").read_text())
    assert all(set(c) >= {"id", "lat", "lng", "n", "plus_code", "owner_hint", "context"} for c in cells)


@pytest.mark.skipif(not (OUT / "model.json").exists(), reason="run the pipeline first")
def test_model_beats_the_simple_rule_and_the_nulls():
    m = json.loads((OUT / "model.json").read_text())
    best = m["models"]["map_plus_old_spots"]
    assert best["min"] > m["baselines"]["near_old_hotspots"]["capture30"]
    assert best["min"] > m["nulls"]["max"]
