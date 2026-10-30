"""Incremental, rate-limited fetch of public SeeClickFix issues for Mableton's bounding box.

Data: SeeClickFix API v2, licensed CC BY-NC-SA 3.0 US, attribution to seeclickfix.com.
The API allows 20 requests a minute. We only fetch issues created since the newest one already
cached (minus a 30-day overlap to pick up status changes), so a nightly run makes a few requests.

Reporter identity never leaves this module: the reporter object is replaced by a keyed
pseudonym (HMAC-SHA256 with a random key that lives only in the private cache folder, so a
public reporter ID cannot be hashed and matched offline) and a guest flag. The cache and the
key are gitignored and never exported or uploaded.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import hmac
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

from .config import CACHE, ISSUES_CACHE, SCF_API, SCF_MIN_INTERVAL_S, USER_AGENT
from .geo import city_bbox

STATUSES = "open,acknowledged,closed,archived"
_last_request = 0.0


HASH_KEY = CACHE / "hash_key"
# A fingerprint of the key (an HMAC of a fixed label, so it reveals nothing about the key). It binds
# the cache to the key that made its pseudonyms: a different key would silently split one account
# into two and corrupt every account-based number.
KEY_ID = CACHE / "hash_key.id"


class PseudonymKeyError(RuntimeError):
    """The pseudonym key is missing, malformed, or not the key the cache was made with."""


def _fingerprint(key: bytes) -> str:
    return hmac.new(key, b"hotspot-ledger pseudonym key id", hashlib.sha256).hexdigest()[:16]


def _cache_is_keyed() -> bool:
    if not ISSUES_CACHE.exists():
        return False
    return any(len(r.get("reporter_hash", "")) == 16 for r in json.loads(ISSUES_CACHE.read_text()))


def _key() -> bytes:
    """Load the pseudonym key, failing closed. A new key is made only for a cache with no keyed rows."""
    if HASH_KEY.exists():
        key = HASH_KEY.read_bytes()
        if len(key) != 32:
            raise PseudonymKeyError(f"{HASH_KEY} must hold exactly 32 bytes; restore the original key")
        if KEY_ID.exists():
            if KEY_ID.read_text().strip() != _fingerprint(key):
                raise PseudonymKeyError(f"{HASH_KEY} is not the key this cache was made with; restore the original key")
        else:
            KEY_ID.write_text(_fingerprint(key))
        return key
    if _cache_is_keyed():
        raise PseudonymKeyError(
            f"{ISSUES_CACHE} holds keyed pseudonyms but {HASH_KEY} is missing. Restore the key, or delete "
            "the cache and run a full fetch so every report is pseudonymized with one new key."
        )
    CACHE.mkdir(parents=True, exist_ok=True)
    key = os.urandom(32)
    HASH_KEY.write_bytes(key)
    HASH_KEY.chmod(0o600)
    KEY_ID.write_text(_fingerprint(key))
    return key


def pseudonym(legacy: str) -> str:
    """Keyed pseudonym of the legacy sha256(id)[:12] digest the first pull stored."""
    return hmac.new(_key(), legacy.encode(), hashlib.sha256).hexdigest()[:16]


def reporter_fields(rep: dict | None) -> dict:
    rep = rep or {}
    legacy = hashlib.sha256(str(rep.get("id", "none")).encode()).hexdigest()[:12]
    return {
        "reporter_hash": pseudonym(legacy),
        "reporter_is_guest": str(rep.get("name", "")).lower() == "guest" or rep.get("role") == "Guest",
    }


def rekey_cache() -> int:
    """One-time upgrade: replace unkeyed 12-character hashes in the cache with keyed pseudonyms.

    Runs at the start of every pipeline run, so it also checks the key first: a missing or
    different key stops the run here instead of corrupting account-based numbers later.
    """
    if not ISSUES_CACHE.exists():
        return 0
    _key()
    rows = json.loads(ISSUES_CACHE.read_text())
    changed = 0
    for r in rows:
        h = r.get("reporter_hash", "")
        if len(h) == 12:
            r["reporter_hash"] = pseudonym(h)
            changed += 1
    if changed:
        tmp = ISSUES_CACHE.with_suffix(".tmp")
        tmp.write_text(json.dumps(rows))
        tmp.replace(ISSUES_CACHE)
    return changed


def scrub(issue: dict) -> dict:
    out = {k: v for k, v in issue.items() if k not in ("reporter", "comments", "votes", "user")}
    out.update(reporter_fields(issue.get("reporter")))
    return out


def _get(params: dict, retries: int = 5) -> dict:
    global _last_request
    url = f"{SCF_API}?{urllib.parse.urlencode(params)}"
    for _attempt in range(retries):
        wait = SCF_MIN_INTERVAL_S - (time.monotonic() - _last_request)
        if wait > 0:
            time.sleep(wait)
        _last_request = time.monotonic()
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                body = r.read()
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(int(e.headers.get("Retry-After", "15")) + 1)
                continue
            raise
        data = json.loads(body)  # raises on an HTML error page: never cache a non-JSON body
        if not isinstance(data, dict) or not isinstance(data.get("issues"), list):
            raise RuntimeError(f"unexpected SeeClickFix response shape for {url[:120]}")
        return data
    raise RuntimeError("SeeClickFix kept rate-limiting; giving up for this run")


def load_cache() -> dict[int, dict]:
    if not ISSUES_CACHE.exists():
        return {}
    return {int(i["id"]): i for i in json.loads(ISSUES_CACHE.read_text())}


def fetch(full: bool = False, max_pages: int = 200) -> dict:
    cache = {} if full else load_cache()
    s, w, n, e = city_bbox(pad=0.005)
    params = {
        "min_lat": s,
        "min_lng": w,
        "max_lat": n,
        "max_lng": e,
        "status": STATUSES,
        "per_page": 100,
        "sort": "created_at",
        "sort_direction": "DESC",
    }
    if cache and not full:
        newest = max(dt.datetime.fromisoformat(i["created_at"]) for i in cache.values())
        params["after"] = (newest - dt.timedelta(days=30)).isoformat()
    added = updated = pages = 0
    page = 1
    while page <= max_pages:
        data = _get({**params, "page": page})
        pages += 1
        for raw in data["issues"]:
            row = scrub(raw)
            iid = int(row["id"])
            if iid in cache:
                updated += 1
            else:
                added += 1
            cache[iid] = row
        meta = (data.get("metadata") or {}).get("pagination") or {}
        if not data["issues"] or not meta.get("next_page"):
            break
        page += 1
    CACHE.mkdir(parents=True, exist_ok=True)
    rows = sorted(cache.values(), key=lambda i: i["created_at"])
    tmp = ISSUES_CACHE.with_suffix(".tmp")
    tmp.write_text(json.dumps(rows))
    tmp.replace(ISSUES_CACHE)
    return {"pages": pages, "added": added, "updated": updated, "total": len(rows)}


if __name__ == "__main__":
    print(fetch())
