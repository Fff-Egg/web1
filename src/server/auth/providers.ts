import type { Provider } from "../db/schema.js";

/**
 * Where to send the browser for an interactive login, per provider. The user
 * logs in here with their own ID/password (and 2FA/captcha if any); we only
 * save the resulting session.
 */
export const LOGIN_URLS: Partial<Record<Provider, string>> = {
  substack: "https://substack.com/sign-in",
  naver_premium: "https://nid.naver.com/nidlogin.login",
  fanding: "https://fanding.kr/login",
  x: "https://x.com/i/flow/login",
};

/** Providers that authenticate via a stored login session. */
export const AUTH_PROVIDERS: Provider[] = ["substack", "naver_premium", "fanding", "x"];

export function loginUrlFor(provider: Provider): string | undefined {
  return LOGIN_URLS[provider];
}
