"""Describe how the deployment package was loaded: interpreter, CPU, native code and bytecode."""

import importlib.util
import os
import platform
import sys
from types import ModuleType

# The pyc header's flags word: bit 0 marks a hash-based pyc, bit 1 asks for the source hash check.
# https://peps.python.org/pep-0552/
_HASH_BASED = 0b01
_CHECK_SOURCE = 0b10


def bytecode(module: ModuleType) -> str:
    """Say whether the import system can use the module's cached bytecode as shipped.

    Lambda's code directories are read-only, so a stale pyc is not rewritten: the module is
    compiled again in memory on every cold start.
    """
    source = getattr(module, "__file__", None)
    if not source or not source.endswith(".py"):
        return "no source"
    cached = importlib.util.cache_from_source(source)
    if not os.path.exists(cached):
        return "missing"
    with open(cached, "rb") as pyc:
        header = pyc.read(16)
    flags = int.from_bytes(header[4:8], "little")
    if flags & _HASH_BASED:
        return "checked-hash" if flags & _CHECK_SOURCE else "unchecked-hash"
    # A timestamp pyc is only used when it records the source's current mtime and size.
    mtime = int.from_bytes(header[8:12], "little")
    stat = os.stat(source)
    return (
        "timestamp" if mtime == int(stat.st_mtime) & 0xFFFFFFFF else "timestamp, stale"
    )


def describe(*modules: ModuleType) -> dict:
    """Report the interpreter and CPU, then where each module came from and its bytecode state."""
    return {
        "python": platform.python_version(),
        "machine": platform.machine(),
        "modules": {
            module.__name__: {
                "path": getattr(module, "__file__", None),
                "bytecode": bytecode(module),
            }
            for module in modules
        },
        "sys_path": [
            path for path in sys.path if path.startswith(("/var/task", "/opt"))
        ],
    }
