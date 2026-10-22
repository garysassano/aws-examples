import adapter from "@sveltejs/adapter-node";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    sveltekit({
      compilerOptions: {
        // Force runes mode for the project, except for libraries. Can be removed in Svelte 6.
        runes: ({ filename }) =>
          filename.split(/[/\\]/).includes("node_modules") ? undefined : true,
      },
      // Builds a standalone Node server into dist/build, which lambda/index.js starts.
      adapter: adapter({ out: "dist/build" }),
      // The stack passes a hash of the source, so the same source builds the same
      // package. Without it, SvelteKit names each build after the time it ran.
      version: { name: process.env.APP_VERSION },
    }),
  ],
});
