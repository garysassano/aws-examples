/** A bounding box as ratios of the image's width and height. */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** What the detect Lambda function publishes to the `/results/<uploadId>` channel. */
export type Result =
  | {
      status: "done";
      isCat: boolean;
      confidence: number | null;
      labels: { name: string; confidence: number }[];
      boxes: Box[];
    }
  | { status: "unsupported" }
  | { status: "error" };

/** The endpoints that only exist after a deploy; the stack writes them to `config.json`. */
export interface Config {
  apiEndpointUrl: string;
  eventApiHttpDns: string;
  eventApiRealtimeDns: string;
  eventApiKey: string;
}
