"""
Interpret pipeline date bounds as wall time in an IANA timezone (default GMT/UTC).
Convert to UTC ISO for Soul API + Supabase. Data is in GMT.
"""
from __future__ import annotations

from datetime import datetime, timezone
from zoneinfo import ZoneInfo


def normalize_naive_iso(s: str) -> str:
    s = (s or "").strip()
    if len(s) == 16 and "T" in s:
        s += ":00"
    return s


def wall_to_utc_iso(naive_iso: str, tz_name: str) -> str:
    """
    naive_iso: e.g. 2025-03-17T00:00:00 (no offset)
    tz_name: IANA e.g. UTC, America/Chicago
    Returns: 2025-03-17T05:00:00Z (example)
    """
    naive_iso = normalize_naive_iso(naive_iso)
    if not naive_iso or "T" not in naive_iso:
        raise ValueError("date_from / date_to must be valid local datetimes.")
    name = (tz_name or "UTC").strip() or "UTC"
    if name.upper() == "GMT":
        name = "UTC"
    try:
        zi = ZoneInfo(name)
    except Exception as e:
        raise ValueError(
            f"Unknown timezone {name!r}. Use an IANA name (e.g. UTC, America/New_York)."
        ) from e
    dt = datetime.fromisoformat(naive_iso)
    if dt.tzinfo is not None:
        utc = dt.astimezone(timezone.utc)
    else:
        utc = dt.replace(tzinfo=zi).astimezone(timezone.utc)
    return utc.strftime("%Y-%m-%dT%H:%M:%SZ")


def wall_to_utc_iso_optional(naive_iso: str | None, tz_name: str) -> str | None:
    if naive_iso is None or str(naive_iso).strip() == "":
        return None
    return wall_to_utc_iso(naive_iso, tz_name)
