import { Cat, CircleAlert, ImageUp, LoaderCircle, RotateCcw, ShieldQuestion } from "lucide-react";
import { useEffect, useRef, useState, useTransition } from "react";
import { preconnect } from "react-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { subscribe } from "@/lib/appsync-events";
import { ACCEPTED_TYPES, MAX_BYTES, createUpload, uploadFile } from "@/lib/upload";
import { cn } from "@/lib/utils";
import type { Config, Result } from "@/types";

type State =
  | { step: "idle" }
  | { step: "uploading"; percent: number }
  | { step: "analyzing" }
  | { step: "done"; result: Result }
  | { step: "failed"; message: string };

// The wording for each detector the stack can deploy
const COPY = {
  rekognition: {
    title: "Cat Rekognizer",
    description: "Upload a photo and Amazon Rekognition tells you if it shows a cat.",
    reader: "Rekognition",
  },
  sagemaker: {
    title: "Cat Detector",
    description: "Upload a photo and an open model on SageMaker tells you if it shows a cat.",
    reader: "The model",
  },
} as const;

export function App({ config }: { config: Config }) {
  const [file, setFile] = useState<File>();
  const [previewUrl, setPreviewUrl] = useState<string>();
  const [state, setState] = useState<State>({ step: "idle" });
  const [dragging, setDragging] = useState(false);
  const [busy, startTransition] = useTransition();
  const input = useRef<HTMLInputElement>(null);
  const copy = COPY[config.detector];

  // Open the connections that Analyze needs while the user picks a file.
  preconnect(config.apiEndpointUrl, { crossOrigin: "anonymous" });
  preconnect(`https://${config.eventApiRealtimeDns}`, { crossOrigin: "anonymous" });

  useEffect(() => {
    if (!file) return setPreviewUrl(undefined);
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const reset = () => {
    setFile(undefined);
    setState({ step: "idle" });
    if (input.current) input.current.value = "";
  };

  const choose = (chosen: File | undefined) => {
    if (!chosen) return;
    if (!ACCEPTED_TYPES.includes(chosen.type)) {
      return setState({ step: "failed", message: "Choose a JPEG or PNG image." });
    }
    if (chosen.size > MAX_BYTES) {
      return setState({ step: "failed", message: "The image is larger than 15 MB." });
    }
    setFile(chosen);
    setState({ step: "idle" });
  };

  // An Action: `busy` stays true from the click until the result or the failure is shown.
  const analyze = () =>
    startTransition(async () => {
      if (!file) return;
      let subscription: Awaited<ReturnType<typeof subscribe>> | undefined;
      try {
        setState({ step: "uploading", percent: 0 });
        const presigned = await createUpload(config, file.type);
        // Listen before uploading, so the result cannot arrive before the subscription exists.
        subscription = await subscribe(config, `/results/${presigned.uploadId}`);
        await uploadFile(presigned, file, (percent) => setState({ step: "uploading", percent }));
        setState({ step: "analyzing" });
        const result = await subscription.waitForResult(config.resultTimeoutSeconds * 1000);
        setState({ step: "done", result });
      } catch (error) {
        setState({ step: "failed", message: (error as Error).message });
      } finally {
        subscription?.close();
      }
    });

  return (
    <main className="mx-auto flex min-h-screen max-w-xl items-center px-4 py-10">
      {/* The only title: index.html has none, so the page says which detector it uses. */}
      <title>{copy.title}</title>
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Cat className="size-5 text-primary" aria-hidden /> {copy.title}
          </CardTitle>
          <CardDescription>{copy.description}</CardDescription>
        </CardHeader>
        <CardContent>
          <input
            ref={input}
            type="file"
            hidden
            accept={ACCEPTED_TYPES.join(",")}
            onChange={(event) => choose(event.target.files?.[0])}
          />

          {previewUrl ? (
            <Preview url={previewUrl} result={state.step === "done" ? state.result : undefined} />
          ) : (
            <button
              type="button"
              onClick={() => input.current?.click()}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                choose(event.dataTransfer.files[0]);
              }}
              className={cn(
                "flex h-64 w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                dragging && "border-primary bg-muted",
              )}
            >
              <ImageUp className="size-8" aria-hidden />
              <span className="text-sm">Drop a JPEG or PNG here, or click to browse</span>
              <span className="text-xs">Up to 15 MB</span>
            </button>
          )}

          <div aria-live="polite" className="flex flex-col gap-4">
            {state.step === "uploading" && (
              <div className="flex flex-col gap-2">
                <p className="text-sm text-muted-foreground">Uploading…</p>
                <Progress value={state.percent} aria-label="Upload progress" />
              </div>
            )}
            {state.step === "analyzing" && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" aria-hidden /> Uploaded. Analyzing the
                image…
              </p>
            )}
            {state.step === "failed" && (
              <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
                <CircleAlert className="size-4 shrink-0" aria-hidden /> {state.message}
              </p>
            )}
            {state.step === "done" && <Verdict result={state.result} reader={copy.reader} />}
          </div>

          <div className="flex gap-2">
            <Button
              className="flex-1"
              size="lg"
              disabled={!file || busy || state.step === "done"}
              onClick={analyze}
            >
              {busy ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : null}
              Analyze
            </Button>
            {file && (
              <Button variant="outline" size="lg" disabled={busy} onClick={reset}>
                <RotateCcw className="size-4" aria-hidden /> Reset
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </main>
  );
}

function Preview({ url, result }: { url: string; result: Result | undefined }) {
  const boxes = result?.status === "done" ? result.boxes : [];
  return (
    <div className="flex h-64 items-center justify-center overflow-hidden rounded-lg bg-muted">
      {/* The wrapper hugs the image, so the box ratios apply to the image's own size. */}
      <div className="relative inline-block max-h-full max-w-full">
        <img src={url} alt="The selected upload" className="block max-h-64 max-w-full" />
        {boxes.map((box) => (
          <span
            key={`${box.left}-${box.top}`}
            className="absolute rounded-sm border-2 border-success shadow-[0_0_0_1px_rgb(0_0_0/0.4)]"
            style={{
              left: `${box.left * 100}%`,
              top: `${box.top * 100}%`,
              width: `${box.width * 100}%`,
              height: `${box.height * 100}%`,
            }}
          />
        ))}
      </div>
    </div>
  );
}

function Verdict({ result, reader }: { result: Result; reader: string }) {
  if (result.status === "unsupported") {
    return (
      <p className="flex items-center gap-2 text-sm text-destructive">
        <ShieldQuestion className="size-4 shrink-0" aria-hidden /> {reader} can't read this file.
        Try another JPEG or PNG.
      </p>
    );
  }
  if (result.status === "error") {
    return (
      <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
        <CircleAlert className="size-4 shrink-0" aria-hidden /> The analysis failed. Try again.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Badge variant={result.isCat ? "success" : "destructive"} className="px-3 py-1 text-sm">
          {result.isCat ? "It's a cat" : "No cat found"}
        </Badge>
        {result.confidence !== null && (
          <span className="text-sm text-muted-foreground">{result.confidence}% confidence</span>
        )}
        {result.cached && (
          <span className="ml-auto text-xs text-muted-foreground">
            Seen before; reused the stored result
          </span>
        )}
      </div>
      {result.labels.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {result.labels.map((label) => (
            <li key={label.name}>
              <Badge variant="outline">
                {label.name} <span className="opacity-70">{Math.round(label.confidence)}%</span>
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Shown instead of the app when the deploy-time config can't be loaded. */
export function ConfigError({ message }: { message: string }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl items-center px-4 py-10">
      <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
        <CircleAlert className="size-4 shrink-0" aria-hidden /> {message}
      </p>
    </main>
  );
}
