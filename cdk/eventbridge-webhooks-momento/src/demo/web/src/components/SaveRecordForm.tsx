import { type FormEvent, useState } from "react";
import { saveRecord } from "../api";
import { type RecordDraft, randomDraft, toRecord } from "../records";
import { type Status, StatusLine, inputClass } from "./ui";

const FIELDS: { name: keyof RecordDraft; label: string; min?: number; max?: number }[] = [
  { name: "location", label: "Location" },
  { name: "maxTemp", label: "Max temp (°F)" },
  { name: "minTemp", label: "Min temp (°F)" },
  { name: "precipitation", label: "Precipitation (%)", min: 0, max: 100 },
  { name: "ttlSeconds", label: "TTL (seconds)", min: 1 },
];

type Props = {
  draft: RecordDraft;
  onChange: (draft: RecordDraft) => void;
};

export default function SaveRecordForm({ draft, onChange }: Props) {
  const [status, setStatus] = useState<Status>();
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const record = toRecord(draft);
    setBusy(true);
    try {
      await saveRecord(record);
      setStatus({
        ok: true,
        text: `Saved ${record.location}. Watch for its message on the topic.`,
      });
    } catch (error) {
      setStatus({ ok: false, text: `Could not save the record: ${(error as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <div className="grid grid-cols-1 md:grid-cols-6 gap-4 text-sm">
        {FIELDS.map(({ name, label, min, max }) => (
          <label key={name} className="flex flex-col font-medium text-gray-600">
            <span className="mb-1">{label}</span>
            <input
              type={name === "location" ? "text" : "number"}
              value={draft[name]}
              onChange={(event) => onChange({ ...draft, [name]: event.target.value })}
              min={min}
              max={max}
              required
              className={`${inputClass} font-normal`}
            />
          </label>
        ))}
        <div className="flex items-end">
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-teal-500 px-4 w-full py-2 font-bold text-white hover:bg-teal-600 disabled:opacity-50 focus:outline-hidden focus:ring-2 focus:ring-blue-500"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={() => onChange(randomDraft())}
          className="text-sm text-teal-700 underline hover:text-teal-900"
        >
          Fill with random data
        </button>
        <StatusLine status={status} />
      </div>
    </form>
  );
}
