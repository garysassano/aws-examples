import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigError } from "./App";
import { loadConfig } from "./lib/config";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");

// The endpoints only exist after a deploy, so load them before the first render.
const app = await loadConfig().then(
  (config) => <App config={config} />,
  (error: Error) => <ConfigError message={error.message} />,
);

createRoot(root).render(<StrictMode>{app}</StrictMode>);
