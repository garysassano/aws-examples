import preact from "@astrojs/preact";
import { defineConfig } from "astro/config";
import aws from "astro-sst";

export default defineConfig({
  adapter: aws(),
  site: "https://example.com",
  integrations: [preact()],
});
