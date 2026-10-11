import { useEffect, useRef } from "react";
import { CACHE_NAME, TABLE_NAME, TOPIC_NAME } from "../shared";
import { Help } from "../svgs/help";

export default function HelpDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);

  // Show the help once when the page opens.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  return (
    <>
      <dialog
        ref={dialogRef}
        className="m-auto w-11/12 md:w-1/2 max-h-[96vh] rounded-lg p-6 shadow-lg backdrop:bg-black/50"
      >
        <h2 className="text-2xl font-bold mb-4">DynamoDB to Momento with EventBridge Pipes</h2>
        <div className="space-y-3 text-sm text-gray-700">
          <p>
            This page changes weather records in the <code>{TABLE_NAME}</code> DynamoDB table that
            the CDK stack created. The table's stream feeds three EventBridge Pipes, which call
            Momento's HTTP API:
          </p>
          <ul className="list-disc pl-6">
            <li>
              Inserts and updates put the record in the <code>{CACHE_NAME}</code> cache, with the
              TTL you choose.
            </li>
            <li>Deletes remove it from the cache.</li>
            <li>
              Every change is published to the <code>{TOPIC_NAME}</code> topic.
            </li>
          </ul>
          <ol className="list-decimal pl-6 space-y-1">
            <li>Save a record. The form starts with random data.</li>
            <li>Watch its INSERT or MODIFY message arrive on the topic.</li>
            <li>
              Get the item from the cache and compare it with the DynamoDB record. Momento drops it
              when its TTL runs out.
            </li>
            <li>Delete the record, and watch its REMOVE message and the item leaving the cache.</li>
          </ol>
          <p>
            DynamoDB deletes expired records some time after their TTL passes, usually within a few
            days, and each of those deletions also sends a REMOVE message.
          </p>
          <p>
            Credentials stay on your machine: the Vite dev server calls DynamoDB with your AWS
            credentials and gives this page a disposable Momento token that can only read the cache
            and subscribe to the topic.
          </p>
        </div>
        <form method="dialog" className="mt-4">
          <button
            type="submit"
            className="bg-teal-500 text-white px-4 py-2 rounded-sm hover:bg-teal-600"
          >
            Close
          </button>
        </form>
      </dialog>
      <button
        type="button"
        onClick={() => dialogRef.current?.showModal()}
        className="fixed bottom-4 right-4 z-50 p-4 bg-teal-500 text-white rounded-lg cursor-pointer hover:bg-teal-600 flex items-center justify-center space-x-2"
      >
        <Help />
        <span>Help</span>
      </button>
    </>
  );
}
