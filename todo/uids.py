"""Deterministic uids, so two clones of one store, and the server, give an
entity the same uid. Mirrors `hashUid` in server/lib/ulid.ts."""

import base64
import hashlib


def hash_uid(*parts) -> str:
    """A 26-char uid: "Z" + base32(sha1(parts joined by \\x1f)), cut to 25."""
    digest = hashlib.sha1("\x1f".join(str(p) for p in parts).encode()).digest()
    return "Z" + base64.b32encode(digest).decode()[:25]
