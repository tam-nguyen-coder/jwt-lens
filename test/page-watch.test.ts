import { WATCH_SHIM, canReadPage, parseDrain, probePage, toFacts } from "../src/page-watch.ts";
import { eq, ok, suite, test } from "./harness.ts";

suite("page watch / parsing what the page reports", () => {
  test("a normal drain becomes a list", () => {
    const got = parseDrain(JSON.stringify([
      { url: "https://api.test/a", method: "GET", auth: "Bearer x" },
      { url: "https://api.test/b", method: "POST", auth: "Bearer y" },
    ]));
    eq(got.length, 2);
    eq(got[1]!.method, "POST");
  });

  test("an empty page, a missing shim and junk all yield nothing", () => {
    eq(parseDrain("null"), []);
    eq(parseDrain(""), []);
    eq(parseDrain("[]"), []);
    eq(parseDrain(undefined), []);
    eq(parseDrain(42), []);
    eq(parseDrain("{not json"), []);
    eq(parseDrain('{"url":"x"}'), [], "an object is not a list");
  });

  test("malformed items are dropped, good ones beside them survive", () => {
    const got = parseDrain(JSON.stringify([
      { url: "https://ok.test", method: "GET", auth: "Bearer x" },
      { url: 5, auth: "Bearer y" },
      null,
      "nonsense",
      { auth: "Bearer z" },
    ]));
    eq(got.length, 1);
    eq(got[0]!.url, "https://ok.test");
  });

  test("a captured call becomes the same shape every other feed produces", () => {
    const facts = toFacts({ url: "https://api.test/v1/me", method: "GET", auth: "Bearer abc" }, 1_700_000_000_000);
    eq(facts.method, "GET");
    eq(facts.url, "https://api.test/v1/me");
    eq(facts.requestHeaders, [{ name: "authorization", value: "Bearer abc" }]);
    eq(facts.resourceType, "page-watch");
    eq(facts.startedAt, 1_700_000_000_000);
    ok(typeof facts.id === "string" && facts.id.length > 0, "an id, so a repeat amends rather than duplicates");
  });
});

suite("page watch / hosts without the API", () => {
  test("a host with no inspectedWindow is reported, not crashed into", () => {
    (globalThis as Record<string, unknown>)["chrome"] = { devtools: {} };
    eq(canReadPage(), false);
    let probe: { pageXhr: number; error?: string } | null = null;
    probePage((p) => { probe = p; });
    ok(probe !== null, "the callback still runs");
    eq((probe as unknown as { pageXhr: number }).pageXhr, -1);
    ok((probe as unknown as { error?: string }).error !== undefined);
  });

  test("no chrome at all is survivable", () => {
    delete (globalThis as Record<string, unknown>)["chrome"];
    eq(canReadPage(), false);
  });
});

suite("page watch / the injected shim", () => {
  // It runs in the page, so what is checked here is that it is safe to inject;
  // that it captures every header shape is checked in a real browser.
  test("it installs once and touches only its own global", () => {
    ok(WATCH_SHIM.includes("if (window.__jwtLens) return"), "guards against double install");
    ok(WATCH_SHIM.includes("nativeFetch.apply"), "forwards fetch untouched");
    ok(WATCH_SHIM.includes("send.apply"), "forwards XHR untouched");
  });

  test("every branch of it swallows its own errors", () => {
    // A bug in the shim must never break the app being debugged.
    const tries = WATCH_SHIM.split("try {").length - 1;
    const catches = WATCH_SHIM.split("catch (e)").length - 1;
    eq(tries, catches, "each try has its catch");
    ok(tries >= 5, `expected the risky parts to be guarded, saw ${tries}`);
  });

  test("it is plain ES5, so an old bundle target cannot choke on it", () => {
    ok(!/=>/.test(WATCH_SHIM), "no arrow functions");
    ok(!/\blet\b|\bconst\b/.test(WATCH_SHIM), "no block scoping");
    ok(!/`/.test(WATCH_SHIM), "no template literals");
  });
});
