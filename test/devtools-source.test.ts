/* The DevTools glue, against a fake `chrome`. This is the corner that had no
   coverage, and it is exactly where the panel failed: it only ever listened for
   future requests, so an app that authenticated before the panel was opened
   produced an empty list no matter how much traffic it made. */

import { createDevtoolsSource, keyOf, toFacts } from "../src/devtools-source.ts";
import type { RequestFacts } from "../src/extract.ts";
import { eq, ok, suite, test } from "./harness.ts";

function b64url(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const NOW = 1_800_000_000;
const TOKEN = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub: "u-1", exp: NOW + 900 })}.c2ln`;

interface FakeEntry {
  startedDateTime: string;
  time: number;
  request: { method: string; url: string; headers: { name: string; value: string }[] };
  response: { status: number; headers: { name: string; value: string }[]; content?: { mimeType?: string; size?: number } };
  getContent?: (cb: (content: string | null, encoding: string) => void) => void;
}

function entry(over: Partial<FakeEntry> = {}): FakeEntry {
  return {
    startedDateTime: "2026-09-03T04:00:00.000Z",
    time: 12,
    request: {
      method: "POST",
      url: "https://definition-api.stg.example.com/api/v1/things",
      headers: [{ name: "authorization", value: `Bearer ${TOKEN}` }],
    },
    response: { status: 200, headers: [], content: { mimeType: "application/json", size: 40 } },
    ...over,
  };
}

/** Installs a fake devtools API and returns the handles the tests poke at. */
function fakeChrome(harEntries: FakeEntry[]) {
  const listeners: ((e: FakeEntry) => void)[] = [];
  const navigated: (() => void)[] = [];
  let harCalls = 0;
  const api = {
    devtools: {
      network: {
        onRequestFinished: { addListener: (cb: (e: FakeEntry) => void) => listeners.push(cb), removeListener: () => {} },
        onNavigated: { addListener: (cb: () => void) => navigated.push(cb) },
        getHAR: (cb: (har: { entries: FakeEntry[] }) => void) => { harCalls++; cb({ entries: harEntries }); },
      },
    },
  };
  (globalThis as Record<string, unknown>)["chrome"] = api;
  return {
    emit: (e: FakeEntry) => listeners.forEach((l) => l(e)),
    navigate: () => navigated.forEach((n) => n()),
    harCalls: () => harCalls,
    listenerCount: () => listeners.length,
  };
}

suite("devtools source / backfill", () => {
  test("requests recorded before the panel opened are read on start", () => {
    // The whole bug: an SPA fires its API calls during load, the user opens
    // DevTools afterwards, and a listen-only panel shows nothing forever.
    const fake = fakeChrome([entry(), entry({ startedDateTime: "2026-09-03T04:00:01.000Z" })]);
    const got: RequestFacts[] = [];
    createDevtoolsSource().start((f) => got.push(f));
    eq(got.length, 2, "both already-recorded requests arrive");
    eq(fake.harCalls(), 1);
    eq(got[0]!.requestHeaders[0]!.value, `Bearer ${TOKEN}`, "headers survive the conversion");
  });

  test("the live listener is registered as well as the backfill", () => {
    const fake = fakeChrome([]);
    const got: RequestFacts[] = [];
    createDevtoolsSource().start((f) => got.push(f));
    eq(fake.listenerCount(), 1);
    eq(got.length, 0, "nothing recorded yet");
    fake.emit(entry({ response: { status: 200, headers: [], content: { mimeType: "image/png", size: 10 } } }));
    eq(got.length, 1, "a live request still arrives");
  });

  test("a request in both feeds is only reported once", () => {
    const shared = entry();
    const fake = fakeChrome([shared]);
    const got: RequestFacts[] = [];
    createDevtoolsSource().start((f) => got.push(f));
    eq(got.length, 1);
    fake.emit(shared);
    eq(got.length, 1, "the live event repeats what the HAR already gave");
  });

  test("rescan re-reads the log without duplicating what is already known", () => {
    const first = entry();
    const har = [first];
    const fake = fakeChrome(har);
    const got: RequestFacts[] = [];
    const source = createDevtoolsSource();
    source.start((f) => got.push(f));
    eq(got.length, 1);

    har.push(entry({ startedDateTime: "2026-09-03T04:05:00.000Z" }));
    source.rescan!((f) => got.push(f));
    eq(got.length, 2, "only the new entry is added");
    eq(fake.harCalls(), 2);
  });

  test("a navigation clears the dedupe keys, because DevTools clears its log", () => {
    const shared = entry();
    const fake = fakeChrome([]);
    const got: RequestFacts[] = [];
    createDevtoolsSource().start((f) => got.push(f));
    fake.emit(shared);
    eq(got.length, 1);
    fake.emit(shared);
    eq(got.length, 1, "still deduplicated");
    fake.navigate();
    fake.emit(shared);
    eq(got.length, 2, "after a reload the same request is a new one");
  });

  test("a host without getHAR still gets the live feed", () => {
    const fake = fakeChrome([]);
    const api = (globalThis as Record<string, unknown>)["chrome"] as { devtools: { network: Record<string, unknown> } };
    api.devtools.network["getHAR"] = () => { throw new Error("not implemented"); };
    const got: RequestFacts[] = [];
    createDevtoolsSource().start((f) => got.push(f));
    fake.emit(entry());
    eq(got.length, 1);
  });
});

suite("devtools source / entry conversion", () => {
  test("the dedupe key is the request, not the object identity", () => {
    eq(keyOf(entry() as never), keyOf(entry() as never));
    ok(keyOf(entry() as never) !== keyOf(entry({ startedDateTime: "2026-09-03T05:00:00.000Z" }) as never));
  });

  test("a backfilled entry never asks for its body", () => {
    let asked = false;
    const e = entry({ getContent: (cb) => { asked = true; cb("{}", ""); } });
    let out: RequestFacts | null = null;
    toFacts(e as never, (f) => { out = f; }, false);
    eq(asked, false, "backfill must not fire hundreds of content round trips");
    ok(out !== null);
    eq((out as unknown as RequestFacts).responseBody, undefined);
  });

  test("a live JSON entry gets its body", () => {
    const e = entry({ getContent: (cb) => cb('{"access_token":"x"}', "") });
    let out: RequestFacts | null = null;
    toFacts(e as never, (f) => { out = f; }, true);
    eq((out as unknown as RequestFacts).responseBody, '{"access_token":"x"}');
  });

  test("a base64 body is dropped rather than scanned as text", () => {
    const e = entry({ getContent: (cb) => cb("AAAA", "base64") });
    let out: RequestFacts | null = null;
    toFacts(e as never, (f) => { out = f; }, true);
    eq((out as unknown as RequestFacts).responseBody, null);
  });

  test("an entry with no getContent is reported anyway", () => {
    const e = entry();
    delete e.getContent;
    let out: RequestFacts | null = null;
    toFacts(e as never, (f) => { out = f; }, true);
    ok(out !== null, "a HAR entry without getContent must not be dropped");
  });

  test("a missing response does not lose the request", () => {
    const e = entry({ response: undefined as never });
    let out: RequestFacts | null = null;
    toFacts(e as never, (f) => { out = f; }, true);
    eq((out as unknown as RequestFacts).status, 0);
    eq((out as unknown as RequestFacts).requestHeaders.length, 1);
  });
});
