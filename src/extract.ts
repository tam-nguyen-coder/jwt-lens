/* ---------------------------------------------------------------------------
   Pulling JWTs out of a request.

   A token rarely arrives in only one place. The same session shows up as an
   Authorization header on the API calls, a cookie on the document request, a
   fragment parameter on the OAuth redirect, and a field in the body of the
   login response — and which of those an app actually uses is often the thing
   you opened the panel to find out. So every surface is read, and each hit
   records where it came from.
   --------------------------------------------------------------------------- */

import { findTokens } from "./jwt.ts";

export type Where = "authorization" | "header" | "cookie" | "set-cookie" | "url" | "body" | "request-body";

export interface HeaderPair { name: string; value: string }

/** A request, flattened out of whatever the host handed us. */
export interface RequestFacts {
  method: string;
  url: string;
  status: number;
  /** Epoch milliseconds. */
  startedAt: number;
  requestHeaders: HeaderPair[];
  responseHeaders: HeaderPair[];
  /** A refresh call carries its token in the request, not the response. */
  requestBody?: string | null;
  responseBody?: string | null;
  /** Chrome's non-standard HAR addition: document, script, xhr, fetch, … */
  resourceType?: string;
}

export interface Found {
  token: string;
  where: Where;
  /** Which header, cookie, parameter or field it sat in. */
  detail: string;
}

/** Headers worth reading beyond Authorization. */
const TOKEN_HEADER = /(^|-)(token|jwt|auth|authorization|assertion)($|-)/i;
const SKIP_HEADER = /^(cookie|set-cookie|user-agent|referer|origin|accept|content-type|content-length)$/i;

function cookiePairs(header: string): HeaderPair[] {
  return header.split(";").map((part) => {
    const eq = part.indexOf("=");
    return eq < 0
      ? { name: part.trim(), value: "" }
      : { name: part.slice(0, eq).trim(), value: part.slice(eq + 1).trim() };
  });
}

/** `Set-Cookie: name=value; Path=/; HttpOnly` — only the first pair is the cookie. */
function setCookiePair(header: string): HeaderPair {
  const first = header.split(";", 1)[0] ?? "";
  const eq = first.indexOf("=");
  return eq < 0
    ? { name: first.trim(), value: "" }
    : { name: first.slice(0, eq).trim(), value: first.slice(eq + 1).trim() };
}

/** Walk parsed JSON (or urlencoded form data) and report the key each token sat under. */
function fromBody(text: string, where: Where): Found[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON. A form post is the other thing a token arrives in.
    if (/^[^\s{[]+=[^\s]*$/.test(text.trim())) {
      const out: Found[] = [];
      for (const [name, value] of new URLSearchParams(text)) {
        for (const token of findTokens(value)) out.push({ token, where, detail: name });
      }
      if (out.length > 0) return out;
    }
    return findTokens(text).map((token) => ({ token, where, detail: "body" }));
  }
  const out: Found[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown, key: string) => {
    if (typeof node === "string") {
      for (const token of findTokens(node)) {
        if (seen.has(token)) continue;
        seen.add(token);
        out.push({ token, where, detail: key || "body" });
      }
      return;
    }
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${key}[${i}]`)); return; }
    if (node !== null && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) walk(v, key ? `${key}.${k}` : k);
    }
  };
  walk(parsed, "");
  return out;
}

function fromUrl(url: string): Found[] {
  const out: Found[] = [];
  const seen = new Set<string>();
  const push = (token: string, detail: string) => {
    if (seen.has(token)) return;
    seen.add(token);
    out.push({ token, where: "url", detail });
  };
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch { /* a relative or malformed URL still gets the raw scan below */ }
  if (parsed) {
    // The fragment never reaches the server, but it is where the OAuth implicit
    // flow puts the token and it is right there in the recorded URL.
    const params = [
      ...parsed.searchParams.entries(),
      ...new URLSearchParams(parsed.hash.replace(/^#/, "")).entries(),
    ];
    for (const [name, value] of params) {
      for (const token of findTokens(value)) push(token, name);
    }
  }
  for (const token of findTokens(url)) push(token, "url");
  return out;
}

/** Every token in one request, tagged with the surface it was found on. */
export function extractTokens(facts: RequestFacts): Found[] {
  const out: Found[] = [];

  for (const h of facts.requestHeaders) {
    const name = h.name.toLowerCase();
    if (name === "authorization" || name === "proxy-authorization") {
      const scheme = /^\s*([A-Za-z]+)\s+/.exec(h.value)?.[1] ?? "";
      for (const token of findTokens(h.value)) {
        out.push({ token, where: "authorization", detail: scheme ? `${h.name}: ${scheme}` : h.name });
      }
      continue;
    }
    if (name === "cookie") {
      for (const c of cookiePairs(h.value)) {
        for (const token of findTokens(c.value)) out.push({ token, where: "cookie", detail: c.name });
      }
      continue;
    }
    if (SKIP_HEADER.test(name) || !TOKEN_HEADER.test(name)) continue;
    for (const token of findTokens(h.value)) out.push({ token, where: "header", detail: h.name });
  }

  for (const h of facts.responseHeaders) {
    if (h.name.toLowerCase() !== "set-cookie") continue;
    const c = setCookiePair(h.value);
    for (const token of findTokens(c.value)) out.push({ token, where: "set-cookie", detail: c.name });
  }

  out.push(...fromUrl(facts.url));
  if (facts.requestBody) out.push(...fromBody(facts.requestBody, "request-body"));
  if (facts.responseBody) out.push(...fromBody(facts.responseBody, "body"));

  // The same token in the same place twice is noise; in two different places it
  // is information, so dedupe on the pair rather than on the token.
  const seen = new Set<string>();
  return out.filter((f) => {
    const key = `${f.token} ${f.where} ${f.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
