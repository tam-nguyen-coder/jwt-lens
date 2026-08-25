import {
  base64UrlDecode, decodeJwt, expiryOf, findTokens, formatRelative, isJwt, labelOf,
} from "../src/jwt.ts";
import type { Jwt } from "../src/jwt.ts";
import { eq, notOk, ok, suite, test } from "./harness.ts";

/* ---------- building tokens to decode ---------- */

function b64url(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const make = (header: unknown, payload: unknown, sig = "c2ln") => `${b64url(header)}.${b64url(payload)}.${sig}`;

const NOW = 1_800_000_000;            // a fixed "now" so every expiry assertion is stable
const H = { alg: "RS256", typ: "JWT", kid: "k1" };

/** Decode and assert success, so the tests below can read fields directly. */
function good(raw: string, now = NOW): Jwt {
  const out = decodeJwt(raw, now);
  if (!isJwt(out)) throw new Error(`expected a token, got: ${out.error}`);
  return out;
}

suite("jwt / decoding", () => {
  test("a normal token comes apart into header, payload and signature", () => {
    const t = good(make(H, { sub: "u-1", iss: "https://id.example", exp: NOW + 600, iat: NOW - 60 }));
    eq(t.kind, "jws");
    eq(t.alg, "RS256");
    eq(t.kid, "k1");
    eq(t.sub, "u-1");
    eq(t.iss, "https://id.example");
    eq(t.exp, NOW + 600);
    eq(t.iat, NOW - 60);
    eq(t.signature, "c2ln");
  });

  test("a Bearer prefix is stripped", () => {
    eq(good(`Bearer ${make(H, { sub: "x" })}`).sub, "x");
    eq(good(`  bearer   ${make(H, { sub: "x" })}  `).sub, "x");
  });

  test("payload text is read as UTF-8, not as bytes", () => {
    const t = good(make(H, { name: "Nguyễn Đức Tâm", city: "Hà Nội", emoji: "🎉" }));
    eq(t.payload["name"], "Nguyễn Đức Tâm");
    eq(t.payload["city"], "Hà Nội");
    eq(t.payload["emoji"], "🎉");
  });

  test("base64url decodes without padding and with the url alphabet", () => {
    eq(base64UrlDecode("eyJhIjoxfQ"), '{"a":1}');
    eq(base64UrlDecode(b64url({ q: "??>>" })), '{"q":"??>>"}');
  });

  test("an audience array is flattened for display but kept raw in the payload", () => {
    const t = good(make(H, { aud: ["api://a", "api://b"] }));
    eq(t.aud, "api://a, api://b");
    eq(t.payload["aud"], ["api://a", "api://b"]);
  });

  test("seconds and milliseconds both read as a time", () => {
    eq(good(make(H, { exp: NOW + 30 })).exp, NOW + 30);
    eq(good(make(H, { exp: (NOW + 30) * 1000 })).exp, NOW + 30, "milliseconds are normalised");
  });

  test("a five-segment JWE is recognised and not guessed at", () => {
    const jwe = `${b64url({ alg: "RSA-OAEP", enc: "A256GCM" })}.a.b.c.d`;
    const t = good(jwe);
    eq(t.kind, "jwe");
    eq(Object.keys(t.payload).length, 0, "an encrypted payload is not invented");
    ok(t.notes.some((n) => n.text.includes("Encrypted")), "says so");
  });
});

suite("jwt / malformed input", () => {
  const bad = (raw: string) => {
    const out = decodeJwt(raw, NOW);
    ok(!isJwt(out), `expected a failure for ${JSON.stringify(raw.slice(0, 24))}`);
    return (out as { error: string }).error;
  };

  test("the wrong number of segments is reported, not thrown", () => {
    ok(bad("abc").includes("1"));
    ok(bad("eyJhIjoxfQ.eyJiIjoyfQ").includes("2"));
    ok(bad("a.b.c.d").includes("4"));
    ok(bad("").includes("1"));
  });

  test("a header that is not base64url, not JSON, or not an object is rejected", () => {
    eq(bad("!!!.eyJhIjoxfQ.sig"), "header is not base64url");
    eq(bad(`${btoa("not json").replace(/=+$/, "")}.eyJhIjoxfQ.sig`), "header is not JSON");
    eq(bad(`${b64url([1, 2])}.${b64url({})}.sig`), "header is not a JSON object");
  });

  test("a payload that is an array or a scalar is rejected", () => {
    eq(bad(`${b64url(H)}.${b64url([1, 2])}.sig`), "payload is not a JSON object");
    eq(bad(`${b64url(H)}.${b64url("hello")}.sig`), "payload is not a JSON object");
  });

  test("an empty payload segment is rejected rather than read as {}", () => {
    ok(bad(`${b64url(H)}..sig`).length > 0);
  });
});

suite("jwt / expiry", () => {
  test("valid, expired and not-yet-valid are told apart", () => {
    eq(expiryOf(good(make(H, { exp: NOW + 600 })), NOW).state, "valid");
    eq(expiryOf(good(make(H, { exp: NOW - 1 })), NOW).state, "expired");
    eq(expiryOf(good(make(H, { nbf: NOW + 60, exp: NOW + 600 })), NOW).state, "early");
    eq(expiryOf(good(make(H, { sub: "x" })), NOW).state, "unknown");
  });

  test("the boundary second counts as expired", () => {
    eq(expiryOf(good(make(H, { exp: NOW })), NOW).state, "expired", "exp == now is over");
    eq(expiryOf(good(make(H, { exp: NOW + 1 })), NOW).state, "valid");
  });

  test("expiry text reads in human units", () => {
    eq(expiryOf(good(make(H, { exp: NOW + 840 })), NOW).text, "expires in 14m");
    eq(expiryOf(good(make(H, { exp: NOW - 240 })), NOW).text, "expired 4m ago");
  });

  test("relative time picks one coarse unit", () => {
    eq(formatRelative(0), "just now");
    eq(formatRelative(-3), "just now");
    eq(formatRelative(45), "in 45s");
    eq(formatRelative(-90), "1m ago");
    eq(formatRelative(7200), "in 2h");
    eq(formatRelative(-86400 * 3), "3d ago");
    eq(formatRelative(86400 * 45), "in 1mo");
    eq(formatRelative(86400 * 400), "in 1y");
  });
});

suite("jwt / notes", () => {
  const notes = (raw: string, now = NOW) => good(raw, now).notes.map((n) => `${n.level}:${n.text}`);
  const has = (list: string[], level: string, fragment: string) =>
    ok(list.some((n) => n.startsWith(`${level}:`) && n.includes(fragment)), `expected ${level} "${fragment}" in ${list.join(" | ")}`);

  test("alg none is called what it is", () => {
    const list = notes(`${b64url({ alg: "none" })}.${b64url({ sub: "x", exp: NOW + 60 })}.`);
    has(list, "danger", "unsigned");
  });

  test("a symmetric algorithm is flagged as needing the shared secret", () => {
    has(notes(make({ alg: "HS256" }, { exp: NOW + 60 })), "info", "shared secret");
  });

  test("an expired token is a danger, an early one only a warning", () => {
    has(notes(make(H, { exp: NOW - 300 })), "danger", "expired 5m ago");
    has(notes(make(H, { nbf: NOW + 300, exp: NOW + 600 })), "warn", "not before in 5m");
  });

  test("a token with no expiry is worth saying out loud", () => {
    has(notes(make(H, { sub: "x" })), "warn", "never expires");
  });

  test("clock nonsense is caught", () => {
    has(notes(make(H, { iat: NOW + 3600, exp: NOW + 7200 })), "warn", "Issued in the future");
    has(notes(make(H, { iat: NOW + 100, exp: NOW + 50 })), "danger", "born expired");
  });

  test("a healthy token says nothing alarming", () => {
    const list = notes(make(H, { sub: "u", iat: NOW - 60, exp: NOW + 600 }));
    notOk(list.some((n) => n.startsWith("danger:")), `unexpected danger in ${list.join(" | ")}`);
    notOk(list.some((n) => n.startsWith("warn:")), `unexpected warning in ${list.join(" | ")}`);
  });
});

suite("jwt / claims", () => {
  test("registered claims are labelled and time claims are rendered", () => {
    const t = good(make(H, { sub: "u-1", exp: NOW + 600, custom: 5 }));
    const byName = new Map(t.claims.map((c) => [c.name, c]));
    eq(byName.get("sub")!.known, "Subject");
    eq(byName.get("custom")!.known, null, "an unknown claim is not invented");
    eq(byName.get("custom")!.display, null);
    ok(byName.get("exp")!.display!.endsWith("· in 10m"), byName.get("exp")!.display!);
  });

  test("claim order follows the token, not the alphabet", () => {
    const t = good(make(H, { zeta: 1, alpha: 2, sub: "x" }));
    eq(t.claims.map((c) => c.name), ["zeta", "alpha", "sub"]);
  });

  test("the label prefers a human name, then an id", () => {
    eq(labelOf(good(make(H, { preferred_username: "tam", sub: "u-1" }))), "tam");
    eq(labelOf(good(make(H, { email: "a@b.c", sub: "u-1" }))), "a@b.c");
    eq(labelOf(good(make(H, { sub: "u-1" }))), "u-1");
    eq(labelOf(good(make(H, { jti: "j-9" }))), "j-9");
    eq(labelOf(good(make(H, {}))), "RS256", "an anonymous token falls back to its algorithm");
  });
});

suite("jwt / finding tokens in text", () => {
  const t1 = make(H, { sub: "one", exp: NOW + 60 });
  const t2 = make(H, { sub: "two", exp: NOW + 60 });

  test("a bearer header yields its token", () => {
    eq(findTokens(`Bearer ${t1}`), [t1]);
  });

  test("several tokens in one cookie header come out in order, deduplicated", () => {
    eq(findTokens(`access=${t1}; other=xyz; id=${t2}; stale=${t1}`), [t1, t2]);
  });

  test("a token embedded in a URL or a JSON body is found", () => {
    eq(findTokens(`https://x.test/cb#access_token=${t1}&state=abc`), [t1]);
    eq(findTokens(JSON.stringify({ data: { access_token: t1, expires_in: 3600 } })), [t1]);
  });

  test("things that merely look like tokens are not reported", () => {
    eq(findTokens("eyJhbGciOiJIUzI1NiJ9"), [], "a lone header segment is not a token");
    eq(findTokens("not.a.token"), []);
    eq(findTokens("eyJhIjoxfQ.!!!.sig"), []);
    eq(findTokens(""), []);
    eq(findTokens("a".repeat(500)), []);
  });

  test("trailing punctuation is not swallowed into the token", () => {
    eq(findTokens(`token is ${t1}.`), [t1]);
    eq(findTokens(`"${t1}"`), [t1]);
  });
});
