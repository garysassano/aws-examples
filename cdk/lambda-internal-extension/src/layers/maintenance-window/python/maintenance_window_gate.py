"""Maintenance-window gate that runs in front of the function's configured handler.

The layer's wrapper script points `_HANDLER` at this module and keeps the configured
handler in `MAINTENANCE_WINDOW_ORIGINAL_HANDLER`, so the managed runtime interface
client runs unmodified.

Each invocation checks the window from Parameter Store. Inside `[start, end)` the event
is archived to DynamoDB and the gate returns a `skipped` result instead of an error, so
Lambda does not retry it and the archive is the only copy to replay. Outside the window,
or when the window cannot be determined, the configured handler runs as usual.
"""

import gzip
import importlib
import json
import logging
import os
import time
from datetime import UTC, datetime

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

logger = logging.getLogger(__name__)

PARAMETER_NAME = os.environ["MAINTENANCE_WINDOW_PARAMETER_NAME"]
TABLE_NAME = os.environ["MAINTENANCE_WINDOW_TABLE_NAME"]

# Parameter Store allows 40 GetParameter calls per second per account and Region by
# default, so each execution environment rereads the window at most this often.
WINDOW_CACHE_SECONDS = 30

# DynamoDB's item size limit, counting attribute names and values.
MAX_ITEM_BYTES = 400 * 1024

# The SDK defaults are 60-second timeouts with up to five attempts, which would outlast
# the function timeout and turn "fail open" into a timed-out invocation.
aws_config = Config(
    connect_timeout=1,
    read_timeout=1,
    retries={"mode": "standard", "total_max_attempts": 2},
)
ssm = boto3.client("ssm", config=aws_config)
dynamodb = boto3.client("dynamodb", config=aws_config)

window_cache = {"expires_at": 0.0, "window": None}


class EventTooLargeToArchive(Exception):
    """Raised when an event exceeds DynamoDB's item limit even after compression."""


def load_original_handler():
    handler = os.environ["MAINTENANCE_WINDOW_ORIGINAL_HANDLER"]
    module_name, _, function_name = handler.rpartition(".")
    module = importlib.import_module(module_name.replace("/", "."))
    return getattr(module, function_name)


original_handler = load_original_handler()


def parse_window(value):
    start, end = (datetime.fromisoformat(bound) for bound in value.split(","))
    if start.tzinfo is None or end.tzinfo is None:
        raise ValueError("maintenance window bounds need a UTC offset")
    if start >= end:
        raise ValueError("maintenance window start must be before its end")
    return start, end


def fetch_window():
    """Return the `(start, end)` window, or None when it cannot be determined.

    Failing open is deliberate: a broken or unreachable schedule must not stop the function.
    """
    try:
        value = ssm.get_parameter(Name=PARAMETER_NAME)["Parameter"]["Value"]
    except (BotoCoreError, ClientError):
        logger.exception(
            "Could not read parameter %s; running the handler", PARAMETER_NAME
        )
        return None
    try:
        return parse_window(value)
    except ValueError as error:
        logger.error(
            "Ignoring parameter %s (%s); running the handler: %r",
            PARAMETER_NAME,
            error,
            value,
        )
        return None


def read_window():
    # Failures are cached too, so an SSM outage or throttling is not retried on every call.
    if time.monotonic() >= window_cache["expires_at"]:
        window_cache["window"] = fetch_window()
        window_cache["expires_at"] = time.monotonic() + WINDOW_CACHE_SECONDS
    return window_cache["window"]


def archive_item(context, now, event):
    item = {
        "invoke_id": {"S": context.aws_request_id},
        "timestamp": {
            "S": now.isoformat(timespec="microseconds").replace("+00:00", "Z")
        },
        "invoked_function_arn": {"S": context.invoked_function_arn},
    }
    # Unescaped, compact JSON: `ensure_ascii` would inflate non-ASCII text up to 3x.
    payload = json.dumps(event, ensure_ascii=False, separators=(",", ":")).encode()
    base_size = sum(
        len(name) + len(value["S"].encode()) for name, value in item.items()
    )

    if base_size + len("event") + len(payload) <= MAX_ITEM_BYTES:
        item["event"] = {"S": payload.decode()}
        return item

    compressed = gzip.compress(payload)
    if base_size + len("event_gzip") + len(compressed) <= MAX_ITEM_BYTES:
        item["event_gzip"] = {"B": compressed}
        return item

    # No retry can fix this; the error names the cause and leaves the event to the
    # function's failure handling (a dead-letter queue or on-failure destination, if set).
    raise EventTooLargeToArchive(
        f"Event is {len(payload)} bytes ({len(compressed)} gzipped); "
        f"DynamoDB items are limited to {MAX_ITEM_BYTES} bytes"
    )


def handler(event, context):
    # Read the window before taking the time, so a slow read cannot straddle its start.
    window = read_window()
    now = datetime.now(UTC)
    if window is None or not window[0] <= now < window[1]:
        return original_handler(event, context)

    start, end = window
    # An archive failure raises, which leaves the event to Lambda's own retry handling.
    dynamodb.put_item(TableName=TABLE_NAME, Item=archive_item(context, now, event))
    logger.warning(
        "Skipped invocation during maintenance window; event archived to %s", TABLE_NAME
    )
    return {
        "skipped": True,
        "reason": "maintenance-window",
        "window": {"start": start.isoformat(), "end": end.isoformat()},
    }
