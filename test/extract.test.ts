import { extractTokens } from "../src/extract.ts";
import type { RequestFacts } from "../src/extract.ts";
import { TokenStore, identityOf } from "../src/store.ts";
import { decodeJwt, isJwt } from "../src/jwt.ts";
import { eq, ok, suite, test } from "./harness.ts";

function b64url(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const NOW = 1_800_000_000;
const H = { alg: "RS256", typ: "JWT", kid: "k1" };
const make = (payload: unknown, sig = "c2ln") => `${b64url(H)}.${b64url(payload)}.${sig}`;

const ACCESS = make({ sub: "u-1", iss: "https://id.test", aud: "api", iat: NOW, exp: NOW + 900 });
const REFRESHED = make({ sub: "u-1", iss: "https://id.test", aud: "api", iat: NOW + 800, exp: NOW + 1700 });
const OTHER = make({ sub: "u-2", iss: "https://id.test", aud: "api", iat: NOW, exp: NOW + 900 });

const req = (over: Partial<RequestFacts> = {}): RequestFacts => ({
  method: "GET",
  url: "https://api.test/v1/me",
  status: 200,
  startedAt: NOW * 1000,
  requestHeaders: [],
  responseHeaders: [],
  ...over,
});

suite("extract / request headers", () => {
  test("a bearer token is found and its scheme recorded", () => {
    const found = extractTokens(req({ requestHeaders: [{ name: "Authorization", value: `Bearer ${ACCESS}` }] }));
    eq(found.length, 1);
    eq(found[0]!.token, ACCESS);
    eq(found[0]!.where, "authorization");
    eq(found[0]!.detail, "Authorization: Bearer");
  });

  test("a scheme-less Authorization header still works", () => {
    const found = extractTokens(req({ requestHeaders: [{ name: "authorization", value: ACCESS }] }));
    eq(found[0]!.detail, "authorization");
  });

  test("custom token headers are read, ordinary ones are not", () => {
    const found = extractTokens(req({
      requestHeaders: [
        { name: "X-Access-Token", value: ACCESS },
        { name: "x-id-jwt", value: OTHER },
        { name: "User-Agent", value: `Mozilla ${ACCESS}` },
        { name: "X-Request-Id", value: "abc" },
      ],
    }));
    eq(found.map((f) => f.detail), ["X-Access-Token", "x-id-jwt"]);
    eq(found.every((f) => f.where === "header"), true);
  });

  test("cookies are split and named", () => {
    const found = extractTokens(req({
      requestHeaders: [{ name: "Cookie", value: `theme=dark; access=${ACCESS}; id=${OTHER}` }],
    }));
    eq(found.map((f) => [f.where, f.detail]), [["cookie", "access"], ["cookie", "id"]]);
  });

  test("Set-Cookie on the response is read, and its attributes are not mistaken for the value", () => {
    const found = extractTokens(req({
      responseHeaders: [
        { name: "set-cookie", value: `session=${ACCESS}; Path=/; HttpOnly; SameSite=Lax` },
        { name: "set-cookie", value: "csrf=plain; Path=/" },
      ],
    }));
    eq(found.length, 1);
    eq(found[0]!.where, "set-cookie");
    eq(found[0]!.detail, "session");
  });
});

suite("extract / url", () => {
  test("a query parameter is found and named", () => {
    const found = extractTokens(req({ url: `https://app.test/cb?state=x&access_token=${ACCESS}` }));
    eq(found.length, 1);
    eq(found[0]!.where, "url");
    eq(found[0]!.detail, "access_token");
  });

  test("the OAuth implicit fragment is read too", () => {
    const found = extractTokens(req({ url: `https://app.test/cb#id_token=${ACCESS}&token_type=bearer` }));
    eq(found[0]!.detail, "id_token");
  });

  test("a token sitting in the path is still found, just unnamed", () => {
    const found = extractTokens(req({ url: `https://app.test/verify/${ACCESS}` }));
    eq(found[0]!.detail, "url");
  });

  test("a malformed url does not throw", () => {
    const found = extractTokens(req({ url: `not a url at all ${ACCESS}` }));
    eq(found.length, 1);
    eq(found[0]!.where, "url");
  });
});

suite("extract / response body", () => {
  test("the field a token came from is reported, however deep", () => {
    const body = JSON.stringify({
      data: { tokens: { access_token: ACCESS, refresh_token: OTHER } },
      expires_in: 900,
    });
    const found = extractTokens(req({ responseBody: body }));
    eq(found.map((f) => f.detail), ["data.tokens.access_token", "data.tokens.refresh_token"]);
    eq(found.every((f) => f.where === "body"), true);
  });

  test("arrays are indexed rather than skipped", () => {
    const body = JSON.stringify({ items: [{ jwt: ACCESS }] });
    eq(extractTokens(req({ responseBody: body }))[0]!.detail, "items[0].jwt");
  });

  test("a body that is not JSON is still scanned", () => {
    const found = extractTokens(req({ responseBody: `<html>token: ${ACCESS}</html>` }));
    eq(found.length, 1);
    eq(found[0]!.detail, "body");
  });

  test("a refresh token posted in the request body is found", () => {
    const found = extractTokens(req({
      method: "POST",
      requestBody: JSON.stringify({ grant_type: "refresh_token", refresh_token: OTHER }),
    }));
    eq(found.length, 1);
    eq(found[0]!.where, "request-body");
    eq(found[0]!.detail, "refresh_token");
  });

  test("a urlencoded form post is parsed into its fields", () => {
    const found = extractTokens(req({
      method: "POST",
      requestBody: `grant_type=refresh_token&refresh_token=${OTHER}`,
    }));
    eq(found[0]!.detail, "refresh_token");
    eq(found[0]!.where, "request-body");
  });

  test("a body with no token contributes nothing", () => {
    eq(extractTokens(req({ responseBody: JSON.stringify({ ok: true }) })).length, 0);
  });
});

suite("extract / deduplication", () => {
  test("the same token on two surfaces is reported twice, once per surface", () => {
    const found = extractTokens(req({
      requestHeaders: [
        { name: "Authorization", value: `Bearer ${ACCESS}` },
        { name: "Cookie", value: `access=${ACCESS}` },
      ],
    }));
    eq(found.length, 2, "both surfaces matter");
    eq(found.map((f) => f.where), ["authorization", "cookie"]);
  });

  test("the same token in the same place twice is reported once", () => {
    const found = extractTokens(req({
      url: `https://app.test/cb?access_token=${ACCESS}&access_token=${ACCESS}`,
    }));
    eq(found.length, 1);
  });

  test("a request with nothing in it yields nothing", () => {
    eq(extractTokens(req()).length, 0);
  });
});

suite("store / accumulating", () => {
  test("a repeated token is one entry with a rising count", () => {
    const store = new TokenStore();
    for (let i = 0; i < 3; i++) {
      store.add(req({ startedAt: (NOW + i) * 1000, requestHeaders: [{ name: "Authorization", value: `Bearer ${ACCESS}` }] }));
    }
    eq(store.size, 1);
    const entry = store.list()[0]!;
    eq(entry.count, 3);
    eq(entry.first, NOW * 1000);
    eq(entry.last, (NOW + 2) * 1000);
    eq(entry.sightings.length, 3);
    eq(entry.sightings[0]!.at, (NOW + 2) * 1000, "newest sighting first");
  });

  test("surfaces accumulate on the entry without duplicating", () => {
    const store = new TokenStore();
    store.add(req({ requestHeaders: [{ name: "Authorization", value: `Bearer ${ACCESS}` }] }));
    store.add(req({ requestHeaders: [{ name: "Cookie", value: `access=${ACCESS}` }] }));
    store.add(req({ requestHeaders: [{ name: "Cookie", value: `access=${ACCESS}` }] }));
    eq(store.list()[0]!.wheres, ["authorization", "cookie"]);
  });

  test("requests without tokens still count towards the denominator", () => {
    const store = new TokenStore();
    store.add(req());
    store.add(req({ requestHeaders: [{ name: "Authorization", value: `Bearer ${ACCESS}` }] }));
    eq(store.requests, 2);
    eq(store.withTokens, 1);
  });

  test("sightings are capped so a polling endpoint cannot grow without bound", () => {
    const store = new TokenStore();
    for (let i = 0; i < 60; i++) {
      store.add(req({ startedAt: (NOW + i) * 1000, requestHeaders: [{ name: "Authorization", value: `Bearer ${ACCESS}` }] }));
    }
    const entry = store.list()[0]!;
    eq(entry.count, 60, "the count is still honest");
    eq(entry.sightings.length, 40, "the log is bounded");
    eq(entry.sightings[0]!.at, (NOW + 59) * 1000, "the newest survive");
  });

  test("the list is newest first", () => {
    const store = new TokenStore();
    store.add(req({ startedAt: NOW * 1000, requestHeaders: [{ name: "Authorization", value: `Bearer ${ACCESS}` }] }));
    store.add(req({ startedAt: (NOW + 5) * 1000, requestHeaders: [{ name: "Authorization", value: `Bearer ${OTHER}` }] }));
    eq(store.list().map((e) => e.jwt.sub), ["u-2", "u-1"]);
  });

  test("a pasted token joins the same store", () => {
    const store = new TokenStore();
    const entry = store.addRaw(`Bearer ${ACCESS}`, NOW * 1000);
    ok(entry !== null);
    eq(store.size, 1);
    eq(entry!.wheres.length, 0, "nothing to say about where it came from");
    eq(store.addRaw("not a token", NOW * 1000), null);
  });

  test("clearing really clears", () => {
    const store = new TokenStore();
    store.add(req({ requestHeaders: [{ name: "Authorization", value: `Bearer ${ACCESS}` }] }));
    store.clear();
    eq(store.size, 0);
    eq(store.requests, 0);
    eq(store.withTokens, 0);
  });
});

suite("store / rotation chains", () => {
  test("a refresh of the same session is one chain, oldest first", () => {
    const store = new TokenStore();
    store.add(req({ startedAt: NOW * 1000, requestHeaders: [{ name: "Authorization", value: `Bearer ${ACCESS}` }] }));
    store.add(req({ startedAt: (NOW + 800) * 1000, requestHeaders: [{ name: "Authorization", value: `Bearer ${REFRESHED}` }] }));
    const chains = store.chains();
    eq(chains.length, 1, "a refresh is not a new identity");
    eq(chains[0]!.entries.length, 2);
    eq(chains[0]!.entries.map((e) => e.jwt.iat), [NOW, NOW + 800], "oldest first");
    eq(chains[0]!.label, "u-1");
  });

  test("a different subject is a different chain", () => {
    const store = new TokenStore();
    store.add(req({ requestHeaders: [{ name: "Authorization", value: `Bearer ${ACCESS}` }] }));
    store.add(req({ requestHeaders: [{ name: "Authorization", value: `Bearer ${OTHER}` }] }));
    eq(store.chains().length, 2);
  });

  test("identity ignores the times and the signature, not the issuer", () => {
    const a = decodeJwt(ACCESS, NOW);
    const b = decodeJwt(REFRESHED, NOW);
    const c = decodeJwt(make({ sub: "u-1", iss: "https://other.test", aud: "api" }), NOW);
    ok(isJwt(a) && isJwt(b) && isJwt(c));
    eq(identityOf(a as never), identityOf(b as never));
    ok(identityOf(a as never) !== identityOf(c as never), "a different issuer is a different identity");
  });
});

suite("store / diagnostics", () => {
  test("a request with no headers at all is reported as such", () => {
    const store = new TokenStore();
    store.add(req({ requestHeaders: [] }));
    const d = store.diagnostics();
    eq(d.requests, 1);
    eq(d.withHeaders, 0);
    eq(d.withAuthHeader, 0);
    eq(d.jwtShaped, 0);
  });

  test("headers without an Authorization are told apart from a missing header set", () => {
    const store = new TokenStore();
    store.add(req({ requestHeaders: [{ name: "accept", value: "application/json" }] }));
    const d = store.diagnostics();
    eq(d.withHeaders, 1);
    eq(d.withAuthHeader, 0);
    eq(d.headerNames, ["accept"]);
  });

  test("an opaque bearer token counts as an Authorization but not as JWT-shaped", () => {
    const store = new TokenStore();
    store.add(req({ requestHeaders: [{ name: "authorization", value: "Bearer 8f3c1a2e-not-a-jwt" }] }));
    const d = store.diagnostics();
    eq(d.withAuthHeader, 1);
    eq(d.withBearer, 1);
    eq(d.jwtShaped, 0, "nothing to decode is not the same as failing to decode");
    eq(d.rejected, 0);
  });

  test("JWT-shaped but undecodable is counted as a rejection, which would be our bug", () => {
    const store = new TokenStore();
    store.add(req({ requestHeaders: [{ name: "authorization", value: "Bearer eyJvery.broken" }] }));
    const d = store.diagnostics();
    eq(d.jwtShaped, 1);
    eq(d.rejected, 1);
    eq(store.size, 0);
  });

  test("a request that yields a token is not counted as a rejection", () => {
    const store = new TokenStore();
    store.add(req({ requestHeaders: [{ name: "authorization", value: `Bearer ${ACCESS}` }] }));
    const d = store.diagnostics();
    eq(d.jwtShaped, 1);
    eq(d.rejected, 0);
    eq(store.size, 1);
  });

  test("header names are collected across requests, most frequent first", () => {
    const store = new TokenStore();
    for (let i = 0; i < 3; i++) {
      store.add(req({ requestHeaders: [{ name: "Accept", value: "*/*" }, { name: "X-Trace", value: "1" }] }));
    }
    store.add(req({ requestHeaders: [{ name: "cookie", value: "a=1" }] }));
    eq(store.diagnostics().headerNames.slice(0, 2), ["accept", "x-trace"]);
  });

  test("clearing resets the diagnosis too", () => {
    const store = new TokenStore();
    store.add(req({ requestHeaders: [{ name: "authorization", value: `Bearer ${ACCESS}` }] }));
    store.clear();
    const d = store.diagnostics();
    eq(d.requests, 0);
    eq(d.withAuthHeader, 0);
    eq(d.headerNames, []);
  });
});
