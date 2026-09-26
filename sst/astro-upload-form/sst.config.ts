/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "sst-astro-upload-form",
      removal: input?.stage === "production" ? "retain" : "remove",
      home: "aws",
    };
  },

  async run() {
    const bucket = new sst.aws.Bucket("MyBucket", {
      access: "public",
    });

    // Issues the presigned upload URLs, so the site itself can stay static.
    const presign = new sst.aws.Function("Presign", {
      handler: "src/functions/presign.handler",
      link: [bucket],
      url: true,
    });

    new sst.aws.Astro("MyWebsite", {
      environment: {
        PUBLIC_PRESIGN_URL: presign.url,
      },
    });
  },
});
