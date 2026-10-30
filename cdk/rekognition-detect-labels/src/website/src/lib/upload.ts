import type { Config } from "@/types";

export const MAX_BYTES = 15 * 1024 * 1024;
export const ACCEPTED_TYPES = ["image/jpeg", "image/png"];

interface Presigned {
  uploadId: string;
  url: string;
  fields: Record<string, string>;
}

/** Asks the API for a signed form that allows uploading one image of this type. */
export async function createUpload(config: Config, contentType: string): Promise<Presigned> {
  const response = await fetch(`${config.apiEndpointUrl}/uploads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contentType }),
  });
  if (!response.ok) throw new Error(`Creating the upload failed: ${response.status}`);
  return response.json();
}

/** Posts the file to S3 with the signed form, reporting progress as a percentage. */
export function uploadFile(
  presigned: Presigned,
  file: File,
  onProgress: (percent: number) => void,
): Promise<void> {
  const form = new FormData();
  for (const [name, value] of Object.entries(presigned.fields)) form.append(name, value);
  // S3 requires the file to be the last field.
  form.append("file", file);

  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", presigned.url);
    request.upload.onprogress = ({ loaded, total }) => onProgress((loaded / total) * 100);
    request.onload = () =>
      request.status >= 200 && request.status < 300
        ? resolve()
        : reject(new Error(`Uploading the image failed: ${request.status}`));
    request.onerror = () => reject(new Error("Uploading the image failed"));
    request.send(form);
  });
}
