import type { WeatherRecord } from "./shared";

// The form's field values, kept as strings while they are being edited.
export type RecordDraft = { [K in keyof WeatherRecord]: string };

const LOCATIONS = [
  "Seattle",
  "New York",
  "Los Angeles",
  "Chicago",
  "Houston",
  "Phoenix",
  "Philadelphia",
  "San Antonio",
  "San Diego",
  "Dallas",
];

export function randomDraft(): RecordDraft {
  const maxTemp = Math.floor(Math.random() * 100);
  return {
    location: LOCATIONS[Math.floor(Math.random() * LOCATIONS.length)],
    maxTemp: String(maxTemp),
    minTemp: String(Math.floor(Math.random() * maxTemp)),
    precipitation: String(Math.floor(Math.random() * 100)),
    ttlSeconds: "120",
  };
}

export function toRecord(draft: RecordDraft): WeatherRecord {
  return {
    location: draft.location.trim(),
    maxTemp: Number(draft.maxTemp),
    minTemp: Number(draft.minTemp),
    precipitation: Number(draft.precipitation),
    ttlSeconds: Number(draft.ttlSeconds),
  };
}
