import type { WeatherRecord } from "./shared";

// Calls the API that the Vite dev server serves from server/api.ts.
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(body.error);
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

const recordPath = (location: string) => `/records/${encodeURIComponent(location)}`;

export function saveRecord({ location, ...fields }: WeatherRecord) {
  return call<void>(recordPath(location), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(fields),
  });
}

export function getRecord(location: string) {
  return call<Record<string, unknown> | null>(recordPath(location));
}

export function deleteRecord(location: string) {
  return call<{ deleted: boolean }>(recordPath(location), { method: "DELETE" });
}

export function getMomentoToken() {
  return call<{ token: string; expiresAt: number }>("/momento-token");
}
