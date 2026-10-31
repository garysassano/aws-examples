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
      /** Set when the image was analyzed before and the stored result was reused. */
      cached?: boolean;
    }
  | { status: "unsupported"; cached?: boolean }
  | { status: "error" };

/** The endpoints that only exist after a deploy; the stack writes them to `config.json`. */
export interface Config {
  apiEndpointUrl: string;
  eventApiHttpDns: string;
  eventApiRealtimeDns: string;
  eventApiKey: string;
  /** Which detector the stack deployed, which sets the page's wording. */
  detector: "rekognition" | "sagemaker";
  /** How long to wait for the result after the upload. */
  resultTimeoutSeconds: number;
}
