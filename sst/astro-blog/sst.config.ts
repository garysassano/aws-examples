/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "sst-astro-blog",
      removal: input?.stage === "production" ? "retain" : "remove",
      protect: ["production"].includes(input?.stage),
      home: "aws",
      // `sst remove` also deletes a non-production stage's state and passphrase.
      state: { purge: input?.stage !== "production" },
    };
  },

  async run() {
    new sst.aws.Astro("MyBlog");
  },
});
