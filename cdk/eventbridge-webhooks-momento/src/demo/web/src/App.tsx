import { useState } from "react";
import EventBridgeLogo from "./assets/aws-eventbridge.svg";
import MomentoLogo from "./assets/momento-mark-mint.svg";
import CacheLookup from "./components/CacheLookup";
import DeleteRecordForm from "./components/DeleteRecordForm";
import FlowStrip from "./components/FlowStrip";
import HelpDialog from "./components/HelpDialog";
import SaveRecordForm from "./components/SaveRecordForm";
import TopicMessages from "./components/TopicMessages";
import { CodeSnippet } from "./components/ui";
import { randomDraft } from "./records";
import { TABLE_NAME } from "./shared";

const OPERATIONS = [
  { value: "save", label: "Create or update" },
  { value: "delete", label: "Delete" },
] as const;

export default function App() {
  const [operation, setOperation] = useState<(typeof OPERATIONS)[number]["value"]>("save");
  const [draft, setDraft] = useState(randomDraft);
  const setLocation = (location: string) => setDraft((current) => ({ ...current, location }));
  const key = draft.location.trim() || "key";

  return (
    <div className="flex flex-col min-h-screen bg-gray-50">
      <header className="bg-green-900 p-2 text-white">
        <div className="flex space-x-4 justify-center items-center">
          <img src={MomentoLogo} alt="Momento" className="w-6 h-6" />
          <span className="mx-2">+</span>
          <img src={EventBridgeLogo} alt="Amazon EventBridge" className="w-6 h-6" />
          <h1 className="text-lg font-semibold">DynamoDB to Momento with EventBridge Pipes</h1>
        </div>
      </header>
      <main className="flex flex-col mt-2 grow">
        <div className="flex flex-col space-y-2 justify-center p-2">
          <fieldset className="flex flex-row items-center ml-2 gap-4 text-sm">
            <legend className="float-left font-bold text-teal-700">Change a weather record</legend>
            {OPERATIONS.map(({ value, label }) => (
              <label key={value} className="flex items-center gap-2">
                <input
                  type="radio"
                  name="operation"
                  value={value}
                  checked={operation === value}
                  onChange={() => setOperation(value)}
                />
                {label}
              </label>
            ))}
          </fieldset>
          <div className="flex flex-col md:flex-row space-y-2 md:space-y-0 md:space-x-4">
            <div className="flex flex-col bg-white p-4 space-y-2 rounded-lg shadow-md md:flex-2">
              {operation === "save" ? (
                <SaveRecordForm draft={draft} onChange={setDraft} />
              ) : (
                <DeleteRecordForm location={draft.location} onLocationChange={setLocation} />
              )}
            </div>
            <div className="md:flex-1 space-y-1 text-sm">
              <h2 className="font-semibold text-teal-700">
                {operation === "save"
                  ? "Put the item in DynamoDB"
                  : "Delete the item from DynamoDB"}
              </h2>
              <p className="text-gray-500">The dev server runs this with your AWS credentials:</p>
              <CodeSnippet>
                {operation === "save"
                  ? `dynamodb.send(new PutCommand({ TableName: "${TABLE_NAME}", Item: { Location: "${key}", … } }))`
                  : `dynamodb.send(new DeleteCommand({ TableName: "${TABLE_NAME}", Key: { Location: "${key}" } }))`}
              </CodeSnippet>
            </div>
          </div>
        </div>
        <FlowStrip />
        <div className="flex flex-col md:flex-row space-y-2 md:space-y-0 md:space-x-4 p-2 mt-2">
          <TopicMessages />
          <CacheLookup location={draft.location} onLocationChange={setLocation} />
        </div>
      </main>
      <HelpDialog />
    </div>
  );
}
