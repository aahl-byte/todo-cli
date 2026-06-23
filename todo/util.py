"""Tiny shared helpers: process exit, timestamps, and None-safe stringify."""

import sys
from datetime import datetime, timezone


def die(msg: str, code: int = 1):
    print(msg, file=sys.stderr)
    sys.exit(code)


def now() -> str:
    """ISO 8601 with millisecond precision and a Z suffix (matches the JS CLI)."""
    dt = datetime.now(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def to_str(v) -> str:
    return "" if v is None else str(v)
