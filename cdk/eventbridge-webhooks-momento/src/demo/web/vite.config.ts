import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { demoApi } from "./server/api";

export default defineConfig(({ mode }) => ({
  // MOMENTO_* variables come from the environment or a local .env file and stay on the server.
  plugins: [react(), tailwindcss(), demoApi(loadEnv(mode, import.meta.dirname, "MOMENTO_"))],
}));
