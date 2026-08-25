/* The web build: same panel, no network to watch. Tokens arrive by paste, drop,
   or — with `?demo` — from a scripted capture, so the DevTools panel can be seen
   working before anyone installs anything. */

import { mountApp } from "./app.ts";
import type { Source } from "./app.ts";
import type { RequestFacts } from "./extract.ts";

function b64url(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function token(payload: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", typ: "JWT", kid: "2026-08" }): string {
  return `${b64url(header)}.${b64url(payload)}.${b64url({ demo: true }).slice(0, 43)}`;
}

/** A login, a few API calls, a refresh, and one expired leftover. */
function demoScript(): RequestFacts[] {
  const now = Math.floor(Date.now() / 1000);
  const base = { iss: "https://id.acme.test", aud: "api://orders", azp: "web-console" };
  const access = token({ ...base, sub: "u-8842", preferred_username: "tam", roles: ["ops", "billing"], scope: "orders:read orders:write", iat: now - 780, exp: now + 120, jti: "a-1" });
  const refreshed = token({ ...base, sub: "u-8842", preferred_username: "tam", roles: ["ops", "billing"], scope: "orders:read orders:write", iat: now - 30, exp: now + 870, jti: "a-2" });
  const idToken = token({ ...base, sub: "u-8842", email: "tam@acme.test", name: "Tâm Nguyễn", iat: now - 780, exp: now + 120 });
  const stale = token({ ...base, sub: "svc-report", client_id: "report-runner", iat: now - 7200, exp: now - 3600, jti: "s-9" });
  const legacy = token({ sub: "u-1001", role: "admin" }, { alg: "none" });

  const at = (secondsAgo: number) => (now - secondsAgo) * 1000;
  const json = "application/json";

  return [
    {
      method: "POST", url: "https://id.acme.test/oauth/token", status: 200, startedAt: at(780),
      requestHeaders: [{ name: "content-type", value: "application/x-www-form-urlencoded" }],
      responseHeaders: [{ name: "content-type", value: json }],
      requestBody: "grant_type=authorization_code&code=abc123",
      responseBody: JSON.stringify({ access_token: access, id_token: idToken, token_type: "Bearer", expires_in: 900 }),
    },
    {
      method: "GET", url: "https://api.acme.test/v1/orders?page=1", status: 200, startedAt: at(770),
      requestHeaders: [{ name: "Authorization", value: `Bearer ${access}` }],
      responseHeaders: [],
    },
    {
      method: "GET", url: "https://api.acme.test/v1/me", status: 200, startedAt: at(700),
      requestHeaders: [{ name: "Authorization", value: `Bearer ${access}` }, { name: "Cookie", value: `theme=dark; id_token=${idToken}` }],
      responseHeaders: [],
    },
    {
      method: "GET", url: "https://api.acme.test/v1/reports/nightly", status: 401, startedAt: at(300),
      requestHeaders: [{ name: "Authorization", value: `Bearer ${stale}` }],
      responseHeaders: [{ name: "content-type", value: json }],
      responseBody: JSON.stringify({ error: "token_expired" }),
    },
    {
      method: "POST", url: "https://id.acme.test/oauth/token", status: 200, startedAt: at(30),
      requestHeaders: [{ name: "content-type", value: json }],
      responseHeaders: [{ name: "set-cookie", value: `session=${refreshed}; Path=/; HttpOnly; SameSite=Lax` }],
      requestBody: JSON.stringify({ grant_type: "refresh_token", refresh_token: "opaque-not-a-jwt" }),
      responseBody: JSON.stringify({ access_token: refreshed, expires_in: 900 }),
    },
    {
      method: "GET", url: "https://api.acme.test/v1/orders?page=2", status: 200, startedAt: at(20),
      requestHeaders: [{ name: "Authorization", value: `Bearer ${refreshed}` }],
      responseHeaders: [],
    },
    {
      method: "GET", url: `https://legacy.acme.test/callback#access_token=${legacy}&token_type=bearer`, status: 200, startedAt: at(10),
      requestHeaders: [],
      responseHeaders: [],
    },
  ];
}

const demoSource: Source = {
  hint: "Replaying a sample capture…",
  start(onRequest) {
    // Fed one at a time so the list fills the way it does in a real session.
    demoScript().forEach((facts, i) => setTimeout(() => onRequest(facts), 120 * i));
  },
  stop() { /* nothing to unwind */ },
};

/**
 * `?emit` sends a couple of same-origin requests carrying a bearer token, so the
 * DevTools panel has real traffic to catch. It is how you confirm the extension
 * is working after loading it — and what the Web Store reviewer is pointed at.
 */
function emitSampleTraffic() {
  const now = Math.floor(Date.now() / 1000);
  const sample = token({
    iss: "https://id.acme.test", aud: "api://orders", sub: "u-8842",
    preferred_username: "tam", scope: "orders:read", iat: now, exp: now + 900,
  });
  for (const path of ["favicon.svg", "manifest.json"]) {
    void fetch(`${path}?jwt-lens=sample`, { headers: { Authorization: `Bearer ${sample}` } }).catch(() => {});
  }
}

const params = new URLSearchParams(location.search);
if (params.has("emit")) {
  emitSampleTraffic();
  mountApp(null, "Two sample requests were just sent with an Authorization header. Open DevTools on this tab, take the JWT panel, and reload to see them caught.");
} else {
  mountApp(params.has("demo") ? demoSource : null);
}
