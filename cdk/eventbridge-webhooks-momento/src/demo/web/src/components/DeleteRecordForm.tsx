import { type FormEvent, useId, useState } from "react";
import { deleteRecord } from "../api";
import { type Status, StatusLine, inputClass } from "./ui";

type Props = {
  location: string;
  onLocationChange: (location: string) => void;
};

export default function DeleteRecordForm({ location, onLocationChange }: Props) {
  const inputId = useId();
  const [status, setStatus] = useState<Status>();
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const key = location.trim();
    setBusy(true);
    try {
      const { deleted } = await deleteRecord(key);
      setStatus(
        deleted
          ? { ok: true, text: `Deleted ${key}. Watch for its REMOVE message on the topic.` }
          : { ok: false, text: `There is no record for ${key}, so nothing changed.` },
      );
    } catch (error) {
      setStatus({ ok: false, text: `Could not delete the record: ${(error as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col items-start space-y-2 w-full">
      <label htmlFor={inputId} className="text-sm font-medium text-gray-600">
        Location
      </label>
      <div className="flex w-full items-center space-x-2">
        <input
          id={inputId}
          type="text"
          value={location}
          onChange={(event) => onLocationChange(event.target.value)}
          required
          className={`${inputClass} flex-1`}
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-red-500 px-4 py-2 font-bold text-white hover:bg-red-600 disabled:opacity-50 focus:outline-hidden focus:ring-2 focus:ring-blue-500"
        >
          {busy ? "Deleting…" : "Delete"}
        </button>
      </div>
      <StatusLine status={status} />
    </form>
  );
}
