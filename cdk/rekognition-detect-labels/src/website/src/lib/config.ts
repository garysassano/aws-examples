import type { Config } from "@/types";

export async function loadConfig(): Promise<Config> {
  const response = await fetch("/config.json");
  if (!response.ok) throw new Error(`Loading config.json failed: ${response.status}`);
  return response.json();
}
