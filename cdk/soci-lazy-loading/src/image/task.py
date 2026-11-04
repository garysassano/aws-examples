"""Fargate entrypoint: run the same workload once, print the result, and exit."""

import json
import os
import urllib.request

from app import handler


def snapshotter() -> str:
    url = os.environ["ECS_CONTAINER_METADATA_URI_V4"]
    with urllib.request.urlopen(url) as response:
        return json.load(response).get("Snapshotter", "unknown")


print(json.dumps({**handler(), "snapshotter": snapshotter()}), flush=True)
