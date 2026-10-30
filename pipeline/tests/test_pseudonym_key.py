import json

import pytest

from hotspot import fetch_scf


@pytest.fixture
def cache(tmp_path, monkeypatch):
    monkeypatch.setattr(fetch_scf, "CACHE", tmp_path)
    monkeypatch.setattr(fetch_scf, "HASH_KEY", tmp_path / "hash_key")
    monkeypatch.setattr(fetch_scf, "KEY_ID", tmp_path / "hash_key.id")
    monkeypatch.setattr(fetch_scf, "ISSUES_CACHE", tmp_path / "scf_issues.json")
    return tmp_path


def test_first_run_makes_a_private_key_and_stable_pseudonyms(cache):
    a = fetch_scf.pseudonym("d9dcdf123456")
    assert a == fetch_scf.pseudonym("d9dcdf123456") and len(a) == 16
    assert len((cache / "hash_key").read_bytes()) == 32
    assert (cache / "hash_key").stat().st_mode & 0o777 == 0o600
    assert (cache / "hash_key.id").exists()


def test_keyed_cache_without_its_key_fails_closed(cache):
    fetch_scf.pseudonym("x")  # make a key
    (cache / "scf_issues.json").write_text(json.dumps([{"id": 1, "reporter_hash": fetch_scf.pseudonym("x")}]))
    (cache / "hash_key").unlink()
    with pytest.raises(fetch_scf.PseudonymKeyError, match="missing"):
        fetch_scf.pseudonym("x")
    with pytest.raises(fetch_scf.PseudonymKeyError, match="missing"):
        fetch_scf.rekey_cache()  # every pipeline run starts here, so the run stops at once
    assert not (cache / "hash_key").exists()  # no silent replacement key


def test_a_different_key_is_refused(cache):
    fetch_scf.pseudonym("x")
    (cache / "hash_key").write_bytes(b"\x01" * 32)
    with pytest.raises(fetch_scf.PseudonymKeyError, match="not the key"):
        fetch_scf.pseudonym("x")


def test_a_malformed_key_is_refused(cache):
    (cache / "hash_key").write_bytes(b"short")
    with pytest.raises(fetch_scf.PseudonymKeyError, match="32 bytes"):
        fetch_scf.pseudonym("x")


def test_an_unkeyed_legacy_cache_still_gets_a_new_key_and_is_rekeyed(cache):
    (cache / "scf_issues.json").write_text(json.dumps([{"id": 1, "reporter_hash": "d9dcdf123456"}]))
    assert fetch_scf.rekey_cache() == 1
    rows = json.loads((cache / "scf_issues.json").read_text())
    assert rows[0]["reporter_hash"] == fetch_scf.pseudonym("d9dcdf123456")
    assert fetch_scf.rekey_cache() == 0  # idempotent
