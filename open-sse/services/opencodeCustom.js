import { CUSTOM_OPENCODE_PROVIDER, CUSTOM_HANDLED_ERROR, CUSTOM_ENDPOINT_UNAVAILABLE, CUSTOM_PROXY_UNAVAILABLE } from "../config/opencodeCustom.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
export function shouldStopOpenCodeFallback(provider, result) {
  if (provider !== CUSTOM_OPENCODE_PROVIDER) return false;
  const message = String(result.error || "");
  return message.includes(CUSTOM_HANDLED_ERROR) ||
    (result.status === HTTP_STATUS.RATE_LIMITED && CUSTOM_ENDPOINT_UNAVAILABLE.test(message)) ||
    (result.status === HTTP_STATUS.SERVICE_UNAVAILABLE && CUSTOM_PROXY_UNAVAILABLE.test(message));
}
