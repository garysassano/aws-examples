import { useId, useState } from "react";
import { getRecord } from "../api";
import { getCacheItem } from "../momento";
import { CACHE_NAME } from "../shared";
import { CodeSnippet, Panel, inputClass } from "./ui";

type Result = { key: string; cache: string; remainingTtlSeconds?: number; dynamodb: string };

function pretty(text: string) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

const describe = (reason: unknown) => `Error: ${reason instanceof Error ? reason.message : reason}`;

type Props = {
  location: string;
  onLocationChange: (location: string) => void;
};

export default function CacheLookup({ location, onLocationChange }: Props) {
  const inputId = useId();
  const [result, setResult] = useState<Result>();
  const [busy, setBusy] = useState(false);

  const lookUp = async () => {
    const key = location.trim();
    setBusy(true);
    const [cached, stored] = await Promise.allSettled([getCacheItem(key), getRecord(key)]);
    setResult({
      key,
      cache:
        cached.status === "rejected"
          ? describe(cached.reason)
          : cached.value
            ? pretty(cached.value.value)
            : "Cache miss",
      remainingTtlSeconds:
        cached.status === "fulfilled" ? cached.value?.remainingTtlSeconds : undefined,
      dynamodb:
        stored.status === "rejected"
          ? describe(stored.reason)
          : stored.value
            ? JSON.stringify(stored.value, null, 2)
            : "No record",
    });
    setBusy(false);
  };

  return (
    <Panel
      title="Cache lookup:"
      description="The other EventBridge Pipes put inserted and updated records in the Momento cache and delete removed ones. Compare an item with its DynamoDB record:"
    >
      <CodeSnippet>{`cacheClient.get("${CACHE_NAME}", "${location.trim() || "key"}")`}</CodeSnippet>
      <div className="flex items-center gap-2">
        <label htmlFor={inputId} className="text-sm font-medium text-gray-600">
          Key (location)
        </label>
        <input
          id={inputId}
          type="text"
          value={location}
          onChange={(event) => onLocationChange(event.target.value)}
          className={`${inputClass} flex-1`}
        />
        <button
          type="button"
          onClick={lookUp}
          disabled={busy || location.trim() === ""}
          className="rounded-lg bg-teal-500 px-4 py-2 font-bold text-white hover:bg-teal-600 disabled:opacity-50 focus:outline-hidden focus:ring-2 focus:ring-blue-500"
        >
          {busy ? "Loading…" : "Get item"}
        </button>
      </div>
      <div className="flex flex-col md:flex-row gap-4">
        <div className="flex-1 h-56 overflow-auto rounded-lg border bg-gray-50 p-4 text-sm text-gray-500">
          <h3 className="font-bold mb-2">
            Cache{result && ` (${result.key})`}
            {result?.remainingTtlSeconds !== undefined && (
              <span className="ml-2 font-normal">
                expires in{" "}
                <span className="font-bold text-blue-500">{result.remainingTtlSeconds} s</span>
              </span>
            )}
          </h3>
          <pre className="whitespace-pre-wrap">{result?.cache ?? "No data to display"}</pre>
        </div>
        <div className="flex-1 h-56 overflow-auto rounded-lg border bg-gray-50 p-4 text-sm text-gray-500">
          <h3 className="font-bold mb-2">DynamoDB{result && ` (${result.key})`}</h3>
          <pre className="whitespace-pre-wrap">{result?.dynamodb ?? "No data to display"}</pre>
        </div>
      </div>
    </Panel>
  );
}
