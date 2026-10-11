import { useEffect, useRef, useState } from "react";
import { type TopicStatus, subscribeToTopic } from "../momento";
import { CACHE_NAME, TOPIC_NAME } from "../shared";
import { BanCircle } from "../svgs/ban-circle";
import { CheckCircle } from "../svgs/check-circle";
import { CodeSnippet, Panel } from "./ui";

type Message = { id: number; text: string; receivedAt: number };

function parse(text: string): { eventType?: string; body: string } {
  try {
    const value = JSON.parse(text);
    return { eventType: value?.EventType, body: JSON.stringify(value, null, 2) };
  } catch {
    return { body: text };
  }
}

function SubscriptionState({ status }: { status: TopicStatus }) {
  switch (status.state) {
    case "subscribed":
      return (
        <span className="flex items-center gap-1 text-green-700">
          <CheckCircle /> Subscribed
        </span>
      );
    case "failed":
      return (
        <span className="flex items-center gap-1 text-red-600">
          <BanCircle />
          {status.cacheMissing ? (
            <span>
              The cache {CACHE_NAME} doesn't exist. Create it in the{" "}
              <a
                className="text-blue-600 underline"
                href="https://console.gomomento.com"
                target="_blank"
                rel="noopener noreferrer"
              >
                Momento console
              </a>
              , then reload the page.
            </span>
          ) : (
            <span>Not subscribed: {status.message}</span>
          )}
        </span>
      );
    default:
      return <span className="text-gray-500">Subscribing…</span>;
  }
}

export default function TopicMessages() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<TopicStatus>({ state: "connecting" });
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(
    () =>
      subscribeToTopic(
        (text) =>
          setMessages((list) => [...list, { id: list.length, text, receivedAt: Date.now() }]),
        setStatus,
      ),
    [],
  );

  // Keep the newest message in view without scrolling the page.
  useEffect(() => {
    const list = listRef.current;
    if (list && messages.length > 0) {
      list.scrollTop = list.scrollHeight;
    }
  }, [messages]);

  return (
    <Panel
      title="Topic messages:"
      description="Every change to the table reaches the Momento topic through an EventBridge Pipe. The page subscribes with:"
    >
      <div className="flex flex-wrap items-center gap-x-3 text-sm">
        <span className="font-semibold">
          Cache: <span className="font-normal text-gray-600">{CACHE_NAME}</span>
        </span>
        <span className="font-semibold">
          Topic: <span className="font-normal text-gray-600">{TOPIC_NAME}</span>
        </span>
        <SubscriptionState status={status} />
      </div>
      <CodeSnippet>{`topicClient.subscribe("${CACHE_NAME}", "${TOPIC_NAME}", { onItem, onError })`}</CodeSnippet>
      <div
        ref={listRef}
        className="h-56 overflow-y-auto rounded-lg border bg-gray-50 p-4 text-left text-sm text-gray-500"
      >
        {messages.length === 0 ? (
          <p className="font-mono">No messages yet</p>
        ) : (
          messages.map((message) => {
            const { eventType, body } = parse(message.text);
            return (
              <div
                key={message.id}
                className="mb-2 flex justify-between gap-4 border-b p-2 font-mono text-gray-600"
              >
                <pre className="whitespace-pre-wrap">{body}</pre>
                <div className="shrink-0 text-right">
                  {eventType && <p className="font-semibold text-teal-700">{eventType}</p>}
                  <p>{new Date(message.receivedAt).toLocaleTimeString()}</p>
                </div>
              </div>
            );
          })
        )}
      </div>
    </Panel>
  );
}
