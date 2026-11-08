"""Workload shared by every variant, so only the image pull differs between them.

LOAD_AT=init imports the libraries and reads the weights before the first request.
LOAD_AT=handler defers both to the first request, which then pays for fetching those
files when the image is lazy loaded.
"""

import os
import time

_load_seconds = None


def load() -> float:
    begin = time.perf_counter()

    import torch

    with open("/opt/model/weights.bin", "rb") as weights:
        while weights.read(1024 * 1024):
            pass

    torch.ones(8, 8).sum().item()
    return time.perf_counter() - begin


if os.environ["LOAD_AT"] == "init":
    _load_seconds = load()


def handler(event=None, context=None):
    global _load_seconds

    begin = time.perf_counter()
    if _load_seconds is None:
        _load_seconds = load()

    return {
        "loadSeconds": _load_seconds,
        "requestSeconds": time.perf_counter() - begin,
        "readyAt": time.time(),
    }
