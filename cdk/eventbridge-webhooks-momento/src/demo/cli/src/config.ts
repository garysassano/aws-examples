export const CONFIG = {
  DYNAMO: {
    TABLE_NAME: "weather-stats-table",
  },
  MOMENTO: {
    CACHE_NAME: "momento-eventbridge-cache",
    TOPIC_NAME: "momento-eventbridge-topic",
    DEFAULT_TTL_SECONDS: 120,
  },
  REQUIRED_ENV_VARS: ["MOMENTO_API_KEY"],
} as const;

export function validateEnvVariables(): void {
  for (const variable of CONFIG.REQUIRED_ENV_VARS) {
    if (!process.env[variable]) {
      throw new Error(`${variable} must be set in the environment variables`);
    }
  }
}
