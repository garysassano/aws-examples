const ISO_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-](\d{2}):(\d{2}))$/;

// Stricter than Date.parse, which rolls impossible dates such as February 30 over into March,
// so that every accepted value is also accepted by the gate's `datetime.fromisoformat()`.
export function parseIsoDatetime(value: string): number | undefined {
  const match = ISO_DATETIME.exec(value);
  if (!match) {
    return undefined;
  }

  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const isCalendarDatetime =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second;
  const isOffset = Number(match[7] ?? 0) <= 23 && Number(match[8] ?? 0) <= 59;

  return isCalendarDatetime && isOffset ? Date.parse(value) : undefined;
}

// Deploys own the parameter's value, so every deploy resets it to this window.
// Pass `-c maintenanceWindow=<start>,<end>` (ISO 8601 with UTC offsets) to choose one;
// otherwise the demo default runs from today 00:00 UTC to tomorrow 00:00 UTC at synth time,
// which makes maintenance active right after each deploy.
export function getMaintenanceWindow(input: unknown, now = new Date()): string[] {
  if (input === undefined) {
    const today = new Date(now);
    today.setUTCHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setUTCDate(today.getUTCDate() + 1);
    return [today, tomorrow].map((date) => date.toISOString().replace(".000Z", "Z"));
  }

  const bounds = String(input).split(",");
  const [start, end] = bounds.map((bound) => parseIsoDatetime(bound));
  if (bounds.length !== 2 || start === undefined || end === undefined || start >= end) {
    throw new Error(
      `maintenanceWindow must be "<start>,<end>" in ISO 8601 with UTC offsets and start before end, got "${input}"`,
    );
  }
  return bounds;
}
