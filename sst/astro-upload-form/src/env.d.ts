/// <reference types="astro/client" />

interface ImportMetaEnv {
  /** URL of the SST function that issues presigned upload URLs, set at build time. */
  readonly PUBLIC_PRESIGN_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
