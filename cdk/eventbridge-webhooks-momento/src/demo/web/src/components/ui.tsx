import type { ReactNode } from "react";

export type Status = { ok: boolean; text: string };

export function StatusLine({ status }: { status?: Status }) {
  if (!status) return null;
  return (
    <p role="status" className={`text-sm ${status.ok ? "text-teal-700" : "text-red-600"}`}>
      {status.text}
    </p>
  );
}

export function CodeSnippet({ children }: { children: string }) {
  return (
    <pre className="bg-gray-100 p-2 rounded-lg text-sm whitespace-pre-wrap">
      <code>{children}</code>
    </pre>
  );
}

export function Panel({
  title,
  description,
  children,
}: {
  title: string;
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="bg-white p-4 rounded-lg shadow-md flex-1 space-y-3">
      <div className="flex flex-row items-center text-sm space-x-2">
        <h2 className="font-bold text-teal-700 shrink-0">{title}</h2>
        <p className="text-gray-500">{description}</p>
      </div>
      {children}
    </section>
  );
}

export const inputClass =
  "rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:ring-blue-500";
