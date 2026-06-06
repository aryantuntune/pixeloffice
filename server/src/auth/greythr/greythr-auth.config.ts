// Reads the greytHR login env vars (GREYTHR_LOGIN_ENABLED / _CLIENT_URL /
// _SUBDOMAIN / _LOGIN_TIMEOUT_MS). Disabled unless GREYTHR_LOGIN_ENABLED=true.

const DEFAULT_CLIENT_URL = "http://localhost:3000";
const DEFAULT_TIMEOUT_MS = 8000;

export interface GreytHrLoginConfig {
  /** Base URL of the greytHR ESS client service. */
  baseUrl: string;
  /** Default company subdomain (shown in the login form; may be empty). */
  subdomain: string;
  /** Per-request timeout in ms. */
  timeoutMs: number;
}

/** Returns the config, or null when greytHR login is not enabled. */
export function buildGreytHrLoginConfig(
  env: NodeJS.ProcessEnv = process.env,
): GreytHrLoginConfig | null {
  if (env.GREYTHR_LOGIN_ENABLED !== "true") return null;

  const baseUrl = (env.GREYTHR_CLIENT_URL?.trim() || DEFAULT_CLIENT_URL).replace(/\/+$/, "");
  const subdomain = env.GREYTHR_SUBDOMAIN?.trim() ?? "";
  const timeoutMs = Number(env.GREYTHR_LOGIN_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

  return { baseUrl, subdomain, timeoutMs };
}
