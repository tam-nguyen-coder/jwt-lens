/* ---------------------------------------------------------------------------
   JWT decoding.

   Decoding only: without the signing key a signature cannot be checked, so
   nothing here ever claims a token is *valid* — only that it is well formed and
   what its claims say. The UI has to be equally careful; a green tick next to an
   unverified token is a lie.
   --------------------------------------------------------------------------- */

export type TokenKind = "jws" | "jwe" | "unsecured";

export interface Claim {
  name: string;
  value: unknown;
  /** Registered claims (RFC 7519) and the widely used de-facto ones. */
  known: string | null;
  /** Rendered form for time claims: "2026-08-25 12:04:11 · in 14m". */
  display: string | null;
}

export type NoteLevel = "info" | "warn" | "danger";

export interface Note { level: NoteLevel; text: string }

export interface Jwt {
  raw: string;
  kind: TokenKind;
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  /** Base64url signature segment, empty for `alg: none`. */
  signature: string;
  claims: Claim[];
  notes: Note[];
  alg: string;
  kid: string | null;
  /** Seconds since the epoch, or null when the claim is absent or unusable. */
  exp: number | null;
  nbf: number | null;
  iat: number | null;
  sub: string | null;
  iss: string | null;
  aud: string | null;
}

export interface DecodeFailure { raw: string; error: string }

/** A JWT-shaped run of base64url segments. Three for a JWS, five for a JWE. */
const TOKEN_RE = /eyJ[A-Za-z0-9_-]{2,}(?:\.[A-Za-z0-9_-]*){2,4}/g;

const REGISTERED: Record<string, string> = {
  iss: "Issuer", sub: "Subject", aud: "Audience", exp: "Expires", nbf: "Not before",
  iat: "Issued at", jti: "JWT ID",
  // Not registered, but every provider uses them and a dev wants them labelled.
  scope: "Scope", scp: "Scope", roles: "Roles", permissions: "Permissions",
  azp: "Authorised party", client_id: "Client", email: "Email",
  preferred_username: "Username", name: "Name", sid: "Session", typ: "Type",
  alg: "Algorithm", kid: "Key ID", auth_time: "Authenticated at", updated_at: "Updated at",
};

const TIME_CLAIMS = new Set(["exp", "nbf", "iat", "auth_time", "updated_at"]);

export function base64UrlDecode(segment: string): string {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  // atob yields one char per byte; re-read those bytes as UTF-8 so that a
  // payload with a non-ASCII name comes back intact.
  const buf = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

function parseSegment(segment: string, what: string): Record<string, unknown> {
  let text: string;
  try {
    text = base64UrlDecode(segment);
  } catch {
    throw new Error(`${what} is not base64url`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${what} is not JSON`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${what} is not a JSON object`);
  }
  return value as Record<string, unknown>;
}

/** Seconds → "2026-08-25 12:04:11" in the reader's own timezone. */
export function formatTime(seconds: number): string {
  const d = new Date(seconds * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Signed seconds → "in 14m", "4m ago", "just now". Coarse on purpose. */
export function formatRelative(deltaSeconds: number): string {
  const abs = Math.abs(deltaSeconds);
  if (abs < 5) return "just now";
  const units: [number, string][] = [
    [86400 * 365, "y"], [86400 * 30, "mo"], [86400, "d"], [3600, "h"], [60, "m"], [1, "s"],
  ];
  let text = `${abs}s`;
  for (const [size, suffix] of units) {
    if (abs >= size) { text = `${Math.floor(abs / size)}${suffix}`; break; }
  }
  return deltaSeconds >= 0 ? `in ${text}` : `${text} ago`;
}

function asSeconds(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  // Some issuers send milliseconds. A plain `exp` of 1.7e12 is the year 55000,
  // which nobody means, so read anything that large as milliseconds.
  return value > 1e11 ? Math.floor(value / 1000) : Math.floor(value);
}

function asString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter((v) => typeof v === "string").join(", ") || null;
  return null;
}

/** Expiry state at a given moment. `now` is seconds, injected so it is testable. */
export function expiryOf(token: Jwt, now: number): { state: "valid" | "expired" | "early" | "unknown"; text: string } {
  if (token.exp !== null && now >= token.exp) {
    return { state: "expired", text: `expired ${formatRelative(token.exp - now)}` };
  }
  if (token.nbf !== null && now < token.nbf) {
    return { state: "early", text: `not before ${formatRelative(token.nbf - now)}` };
  }
  if (token.exp === null) return { state: "unknown", text: "no expiry" };
  return { state: "valid", text: `expires ${formatRelative(token.exp - now)}` };
}

function buildClaims(payload: Record<string, unknown>, now: number): Claim[] {
  return Object.entries(payload).map(([name, value]) => {
    const seconds = TIME_CLAIMS.has(name) ? asSeconds(value) : null;
    return {
      name,
      value,
      known: REGISTERED[name] ?? null,
      display: seconds === null ? null : `${formatTime(seconds)} · ${formatRelative(seconds - now)}`,
    };
  });
}

function buildNotes(token: Omit<Jwt, "notes">, now: number): Note[] {
  const notes: Note[] = [];
  const alg = token.alg.toLowerCase();

  if (token.kind === "unsecured") {
    notes.push({ level: "danger", text: "alg is \"none\" — this token is unsigned and anyone can forge it" });
  }
  if (token.kind === "jwe") {
    notes.push({ level: "info", text: "Encrypted (JWE) — the payload cannot be read without the decryption key" });
  }
  if (alg.startsWith("hs")) {
    notes.push({ level: "info", text: `Symmetric signature (${token.alg}) — verifying it needs the shared secret` });
  }
  if (token.kind === "jws" && token.signature === "") {
    notes.push({ level: "danger", text: "Signature segment is empty" });
  }

  const { state, text } = expiryOf(token as Jwt, now);
  if (state === "expired") notes.push({ level: "danger", text: `Token ${text}` });
  if (state === "early") notes.push({ level: "warn", text: `Token is ${text}` });
  if (state === "unknown" && token.kind !== "jwe") {
    notes.push({ level: "warn", text: "No exp claim — this token never expires on its own" });
  }
  if (token.iat !== null && token.iat - now > 60) {
    notes.push({ level: "warn", text: "Issued in the future — check the clock on the issuer" });
  }
  if (token.exp !== null && token.iat !== null && token.exp <= token.iat) {
    notes.push({ level: "danger", text: "exp is not after iat — the token was born expired" });
  }
  return notes;
}

/**
 * Decode one token. Returns a `DecodeFailure` rather than throwing, because
 * these arrive from the network and a malformed one is data, not an exception.
 * `now` is seconds since the epoch; pass it in so results are reproducible.
 */
export function decodeJwt(raw: string, now = Math.floor(Date.now() / 1000)): Jwt | DecodeFailure {
  const trimmed = raw.trim().replace(/^Bearer\s+/i, "");
  const parts = trimmed.split(".");
  if (parts.length !== 3 && parts.length !== 5) {
    return { raw: trimmed, error: `expected 3 segments (or 5 for JWE), found ${parts.length}` };
  }

  let header: Record<string, unknown>;
  try {
    header = parseSegment(parts[0]!, "header");
  } catch (e) {
    return { raw: trimmed, error: (e as Error).message };
  }

  const alg = typeof header["alg"] === "string" ? header["alg"] : "";
  const kid = typeof header["kid"] === "string" ? header["kid"] : null;
  const isJwe = parts.length === 5;

  let payload: Record<string, unknown> = {};
  if (!isJwe) {
    try {
      payload = parseSegment(parts[1]!, "payload");
    } catch (e) {
      return { raw: trimmed, error: (e as Error).message };
    }
  }

  const base: Omit<Jwt, "notes"> = {
    raw: trimmed,
    kind: isJwe ? "jwe" : alg.toLowerCase() === "none" ? "unsecured" : "jws",
    header,
    payload,
    signature: isJwe ? "" : parts[2]!,
    claims: buildClaims(payload, now),
    alg: alg || "—",
    kid,
    exp: asSeconds(payload["exp"]),
    nbf: asSeconds(payload["nbf"]),
    iat: asSeconds(payload["iat"]),
    sub: asString(payload["sub"]),
    iss: asString(payload["iss"]),
    aud: asString(payload["aud"]),
  };
  return { ...base, notes: buildNotes(base, now) };
}

export function isJwt(value: Jwt | DecodeFailure): value is Jwt {
  return (value as Jwt).claims !== undefined;
}

/**
 * Every JWT-looking run inside a blob of text, deduplicated in first-seen order.
 * Used on headers, cookies, URLs and response bodies alike — anywhere a token
 * might be embedded in something larger.
 */
export function findTokens(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(TOKEN_RE)) {
    const candidate = match[0].replace(/\.+$/, "");
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    // The regex only proves the shape; decoding proves it is a token.
    if (isJwt(decodeJwt(candidate, 0))) out.push(candidate);
  }
  return out;
}

/** A short, stable label for a token: who it is for, or its id. */
export function labelOf(token: Jwt): string {
  const p = token.payload;
  for (const key of ["preferred_username", "email", "name", "sub", "client_id", "azp", "jti"]) {
    const v = p[key];
    if (typeof v === "string" && v) return v;
  }
  return token.alg;
}
