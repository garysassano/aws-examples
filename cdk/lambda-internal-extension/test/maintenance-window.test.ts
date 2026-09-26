import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getMaintenanceWindow, parseIsoDatetime } from "../src/utils/maintenance-window.js";

describe("parseIsoDatetime", () => {
  it("accepts datetimes the gate's fromisoformat() accepts", () => {
    for (const value of [
      "2026-10-01T02:00:00Z",
      "2026-10-01T02:00:00.123Z",
      "2026-10-01T02:00:00+02:00",
      "2028-02-29T00:00:00Z",
    ]) {
      assert.notEqual(parseIsoDatetime(value), undefined, value);
    }
  });

  it("rejects impossible calendar dates that Date.parse rolls over", () => {
    for (const value of [
      "2026-02-30T00:00:00Z",
      "2026-02-29T00:00:00Z",
      "2026-04-31T12:00:00Z",
      "2026-13-01T00:00:00Z",
    ]) {
      assert.equal(parseIsoDatetime(value), undefined, value);
    }
  });

  it("rejects missing or out-of-range UTC offsets", () => {
    for (const value of ["2026-10-01T02:00:00", "2026-10-01T02:00:00+25:00", "2026-10-01"]) {
      assert.equal(parseIsoDatetime(value), undefined, value);
    }
  });
});

describe("getMaintenanceWindow", () => {
  it("defaults to the synth day in UTC", () => {
    assert.deepEqual(getMaintenanceWindow(undefined, new Date("2026-09-26T23:30:00+00:00")), [
      "2026-09-26T00:00:00Z",
      "2026-09-27T00:00:00Z",
    ]);
  });

  it("passes a valid window through unchanged", () => {
    const window = "2026-10-01T02:00:00Z,2026-10-01T04:00:00+00:00";
    assert.deepEqual(getMaintenanceWindow(window), window.split(","));
  });

  it("rejects invalid windows at synth time", () => {
    for (const window of [
      "2026-02-30T00:00:00Z,2026-03-03T00:00:00Z",
      "2026-10-01T04:00:00Z,2026-10-01T02:00:00Z",
      "2026-10-01T02:00:00Z,2026-10-01T02:00:00Z",
      "2026-10-01T02:00:00Z",
      "2026-10-01T02:00:00Z,2026-10-01T04:00:00Z,2026-10-01T06:00:00Z",
    ]) {
      assert.throws(() => getMaintenanceWindow(window), /maintenanceWindow must be/, window);
    }
  });
});
