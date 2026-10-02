"""ULIDs: 26-char Crockford base32, a 48-bit millisecond timestamp then 80 random
bits, so they sort by creation time and need no coordination between clients."""

import os
import threading
import time

_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_lock = threading.Lock()
_last_ms = -1
_last_rand = 0


def _encode(n: int, length: int) -> str:
    out = []
    for _ in range(length):
        out.append(_ALPHABET[n & 31])
        n >>= 5
    return "".join(reversed(out))


def new() -> str:
    """A fresh ULID. Two in the same millisecond increment the random part, so
    ids from one process stay strictly ordered."""
    global _last_ms, _last_rand
    with _lock:
        ms = int(time.time() * 1000)
        if ms <= _last_ms:
            ms = _last_ms
            rand = (_last_rand + 1) & ((1 << 80) - 1)
        else:
            rand = int.from_bytes(os.urandom(10), "big")
        _last_ms, _last_rand = ms, rand
    return _encode(ms, 10) + _encode(rand, 16)
