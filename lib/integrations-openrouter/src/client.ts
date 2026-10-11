// OpenRouter client configuration. Reads credentials from the environment and
// exposes the headers every OpenRouter request needs.

function requiredEnv(name: string, hint: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} must be set. ${hint}`,
    );
  }
  return value;
}

export const OPENROUTER_API_KEY: string = requiredEnv(
  "OPENROUTER_API_KEY",
  "Get a free key at https://openrouter.ai/keys — free (:free) models cost nothing.",
);

export const OPENROUTER_BASE_URL: string =
  process.env["OPENROUTER_BASE_URL"] ?? "https://openrouter.ai/api/v1";

export function openrouterHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${OPENROUTER_API_KEY}`,
    "Content-Type": "application/json",
    "X-Title": process.env["OPENROUTER_APP_TITLE"] ?? "forecaster",
  };
  const siteUrl = process.env["OPENROUTER_SITE_URL"];
  if (siteUrl) {
    headers["HTTP-Referer"] = siteUrl;
  }
  return headers;
}
