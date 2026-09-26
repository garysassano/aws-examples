"""Regression tests for the maintenance-window gate, with AWS calls stubbed."""

import base64
import gzip
import json
import os
import unittest
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest import mock

from botocore.exceptions import ClientError, ConnectTimeoutError
from botocore.stub import Stubber

os.environ.update(
    AWS_DEFAULT_REGION="eu-west-1",
    AWS_ACCESS_KEY_ID="test",
    AWS_SECRET_ACCESS_KEY="test",
    MAINTENANCE_WINDOW_PARAMETER_NAME="maintenance-window",
    MAINTENANCE_WINDOW_TABLE_NAME="maintenance-window-events",
    MAINTENANCE_WINDOW_ORIGINAL_HANDLER="test_maintenance_window_gate.original_handler",
)


def original_handler(event, context):
    return {"handled": event}


import maintenance_window_gate as gate

START = datetime(2026, 9, 26, tzinfo=UTC)
END = datetime(2026, 9, 27, tzinfo=UTC)
WINDOW = "2026-09-26T00:00:00Z,2026-09-27T00:00:00Z"
CONTEXT = SimpleNamespace(
    aws_request_id="request-1",
    invoked_function_arn="arn:aws:lambda:eu-west-1:123456789012:function:current-time",
)


def frozen_clock(instant):
    """A `datetime` stand-in whose `now()` always returns `instant`."""

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return instant

    return Clock


class GateTest(unittest.TestCase):
    def setUp(self):
        gate.window_cache.update(expires_at=0.0, window=None)
        self.ssm = Stubber(gate.ssm)
        self.dynamodb = Stubber(gate.dynamodb)
        self.ssm.activate()
        self.dynamodb.activate()
        self.addCleanup(self.ssm.deactivate)
        self.addCleanup(self.dynamodb.deactivate)

    def tearDown(self):
        self.ssm.assert_no_pending_responses()
        self.dynamodb.assert_no_pending_responses()

    def stub_window(self, value):
        self.ssm.add_response(
            "get_parameter",
            {
                "Parameter": {
                    "Name": "maintenance-window",
                    "Type": "StringList",
                    "Value": value,
                }
            },
            {"Name": "maintenance-window"},
        )

    def invoke(self, now, event=None):
        with mock.patch.object(gate, "datetime", frozen_clock(now)):
            return gate.handler(event or {"order": 1}, CONTEXT)

    def archived_item(self):
        """Stub the next PutItem call and return a list that receives its item."""
        items = []

        def capture(params, **_):
            items.append(params["Item"])

        events = gate.dynamodb.meta.events
        events.register("provide-client-params.dynamodb.PutItem", capture)
        self.addCleanup(
            events.unregister, "provide-client-params.dynamodb.PutItem", capture
        )
        self.dynamodb.add_response("put_item", {})
        return items

    def test_inside_window_archives_and_skips(self):
        self.stub_window(WINDOW)
        items = self.archived_item()

        result = self.invoke(
            datetime(2026, 9, 26, 12, tzinfo=UTC), {"name": "café", "n": 9.99}
        )

        self.assertTrue(result["skipped"])
        self.assertEqual(items[0]["invoke_id"], {"S": "request-1"})
        self.assertEqual(items[0]["event"], {"S": '{"name":"café","n":9.99}'})

    def test_window_start_is_inclusive(self):
        self.stub_window(WINDOW)
        self.archived_item()
        self.assertTrue(self.invoke(START)["skipped"])

    def test_window_end_is_exclusive(self):
        self.stub_window(WINDOW)
        self.assertEqual(self.invoke(END), {"handled": {"order": 1}})

    def test_time_is_taken_after_reading_the_window(self):
        # A read that starts before the window and returns inside it must not run the handler.
        self.archived_item()
        calls = []

        class Clock(datetime):
            @classmethod
            def now(cls, tz=None):
                calls.append("now")
                return START

        def read_window():
            calls.append("read")
            return START, END

        with (
            mock.patch.object(gate, "datetime", Clock),
            mock.patch.object(gate, "read_window", read_window),
        ):
            self.assertTrue(gate.handler({}, CONTEXT)["skipped"])
        self.assertEqual(calls, ["read", "now"])

    def test_invalid_windows_fail_open(self):
        for value in [
            "2026-09-26T00:00:00Z,2026-09-26T00:00:00Z",
            "2026-09-27T00:00:00Z,2026-09-26T00:00:00Z",
            "2026-09-26T00:00:00,2026-09-27T00:00:00",
            "2026-09-26T00:00:00Z",
            "not-a-date",
        ]:
            with self.subTest(value=value):
                gate.window_cache.update(expires_at=0.0)
                self.stub_window(value)
                with self.assertLogs(gate.logger, "ERROR"):
                    self.assertEqual(self.invoke(START), {"handled": {"order": 1}})

    def test_ssm_errors_fail_open(self):
        self.ssm.add_client_error(
            "get_parameter", "ThrottlingException", http_status_code=400
        )
        with self.assertLogs(gate.logger, "ERROR"):
            self.assertEqual(self.invoke(START), {"handled": {"order": 1}})

    def test_ssm_timeouts_fail_open(self):
        with (
            mock.patch.object(
                gate.ssm,
                "get_parameter",
                side_effect=ConnectTimeoutError(endpoint_url="https://ssm"),
            ),
            self.assertLogs(gate.logger, "ERROR"),
        ):
            self.assertEqual(self.invoke(START), {"handled": {"order": 1}})

    def test_sdk_calls_are_bounded(self):
        for client in (gate.ssm, gate.dynamodb):
            config = client.meta.config
            self.assertLessEqual(config.connect_timeout, 1)
            self.assertLessEqual(config.read_timeout, 1)
            self.assertLessEqual(config.retries["total_max_attempts"], 2)

    def test_window_is_cached_between_invocations(self):
        self.stub_window(WINDOW)
        self.archived_item()
        self.archived_item()
        self.invoke(START)
        self.invoke(START)  # No second GetParameter stub: a second read would fail.

    def test_cache_expiry_failed_refresh_and_recovery(self):
        clock = mock.patch.object(gate.time, "monotonic", return_value=1000.0)
        monotonic = clock.start()
        self.addCleanup(clock.stop)

        # A valid window is enforced.
        self.stub_window(WINDOW)
        self.archived_item()
        self.assertTrue(self.invoke(START)["skipped"])

        # Once the cache expires, a throttled refresh discards that window and fails open,
        # and the failure itself is cached so the next call does not hit SSM again.
        monotonic.return_value += gate.WINDOW_CACHE_SECONDS
        self.ssm.add_client_error("get_parameter", "ThrottlingException")
        with self.assertLogs(gate.logger, "ERROR"):
            self.assertEqual(self.invoke(START), {"handled": {"order": 1}})
        self.assertEqual(self.invoke(START), {"handled": {"order": 1}})

        # After the next expiry, a successful refresh enforces the window again.
        monotonic.return_value += gate.WINDOW_CACHE_SECONDS
        self.stub_window(WINDOW)
        self.archived_item()
        self.assertTrue(self.invoke(START)["skipped"])

    def test_archive_failure_raises(self):
        self.stub_window(WINDOW)
        self.dynamodb.add_client_error(
            "put_item", "ProvisionedThroughputExceededException"
        )
        with self.assertRaises(ClientError):
            self.invoke(START)

    def test_large_event_is_compressed(self):
        self.stub_window(WINDOW)
        items = self.archived_item()
        event = {"text": "日本語" * 60_000}  # 540 KB of UTF-8, compressible.

        self.invoke(START, event)

        self.assertNotIn("event", items[0])
        self.assertEqual(
            json.loads(gzip.decompress(items[0]["event_gzip"]["B"])), event
        )

    def test_incompressible_oversized_event_is_rejected(self):
        self.stub_window(WINDOW)
        event = {
            "blob": base64.b64encode(os.urandom(450_000)).decode()
        }  # 600 KB, ~450 KB gzipped.
        with self.assertRaises(gate.EventTooLargeToArchive):
            self.invoke(START, event)


if __name__ == "__main__":
    unittest.main()
