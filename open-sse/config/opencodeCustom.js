// Source customization constants. Kept out of provider-independent code.
export const CUSTOM_ANONYMOUS_HOOK = "9router.opencodeAnonymous.v1";
export const CUSTOM_PUBLIC_PROXY_HOOK = "9router.opencodePublicProxy.v1";
export const CUSTOM_EXPLICIT_LOW_MODEL = /(?:^|\/)deepseek-v4\.1-flash-free(?:\([^()]*\))?$/;
export const CUSTOM_OPENCODE_PROVIDER = "opencode";
export const CUSTOM_HANDLED_ERROR = "[OpenCodeAutoRecovery]";
export const CUSTOM_ENDPOINT_UNAVAILABLE = /\bendpoint is unavailable\b/i;
export const CUSTOM_PROXY_UNAVAILABLE = /OpenCodePublicProxyUnavailable|自动公共代理|匿名线路正在处理/;
