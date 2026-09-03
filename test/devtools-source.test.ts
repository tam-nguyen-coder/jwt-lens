/* The DevTools glue, against a fake `chrome`. This is the corner that had no
   coverage, and it is exactly where the panel failed: it only ever listened for
   future requests, so an app that authenticated before the panel was opened
   produced an empty list no matter how much traffic it made. */

import { createDevtoolsSource, deliver, keyOf } from "../src/devtools-source.ts";
import type { Source } from "../src/app.ts";
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

/**
 * Start a source and guarantee it is stopped: its poll timer would otherwise
 * keep the whole test process alive long after the assertions passed.
 */
function started(onRequest: (f: RequestFacts) => void, body: (source: Source) => void) {
  const source = createDevtoolsSource();
  source.start(onRequest);
  try { body(source); } finally { source.stop(); }
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
    started((f) => got.push(f), () => {
      eq(got.length, 2, "both already-recorded requests arrive");
      eq(fake.harCalls(), 1);
      eq(got[0]!.requestHeaders[0]!.value, `Bearer ${TOKEN}`, "headers survive the conversion");
    });
  });

  test("the live listener is registered as well as the backfill", () => {
    const fake = fakeChrome([]);
    const got: RequestFacts[] = [];
    started((f) => got.push(f), () => {
      eq(fake.listenerCount(), 1);
      eq(got.length, 0, "nothing recorded yet");
      fake.emit(entry({ response: { status: 200, headers: [], content: { mimeType: "image/png", size: 10 } } }));
      eq(got.length, 1, "a live request still arrives");
    });
  });

  test("a request in both feeds is only reported once", () => {
    const shared = entry();
    const fake = fakeChrome([shared]);
    const got: RequestFacts[] = [];
    started((f) => got.push(f), () => {
      eq(got.length, 1);
      fake.emit(shared);
      eq(got.length, 1, "the live event repeats what the HAR already gave");
    });
  });

  test("rescan re-reads the log without duplicating what is already known", () => {
    const first = entry();
    const har = [first];
    const fake = fakeChrome(har);
    const got: RequestFacts[] = [];
    started((f) => got.push(f), (source) => {
      eq(got.length, 1);
      har.push(entry({ startedDateTime: "2026-09-03T04:05:00.000Z" }));
      source.rescan!((f) => got.push(f));
      eq(got.length, 2, "only the new entry is added");
      eq(fake.harCalls(), 2);
    });
  });

  test("a navigation clears the dedupe keys, because DevTools clears its log", () => {
    const shared = entry();
    const fake = fakeChrome([]);
    const got: RequestFacts[] = [];
    started((f) => got.push(f), () => {
      fake.emit(shared);
      eq(got.length, 1);
      fake.emit(shared);
      eq(got.length, 1, "still deduplicated");
      fake.navigate();
      fake.emit(shared);
      eq(got.length, 2, "after a reload the same request is a new one");
    });
  });

  test("a host without getHAR still gets the live feed", () => {
    const fake = fakeChrome([]);
    const api = (globalThis as Record<string, unknown>)["chrome"] as { devtools: { network: Record<string, unknown> } };
    api.devtools.network["getHAR"] = () => { throw new Error("not implemented"); };
    const got: RequestFacts[] = [];
    started((f) => got.push(f), () => {
      fake.emit(entry());
      eq(got.length, 1);
    });
  });
});

suite("devtools source / entry conversion", () => {
  test("the dedupe key is the request, not the object identity", () => {
    eq(keyOf(entry() as never), keyOf(entry() as never));
    ok(keyOf(entry() as never) !== keyOf(entry({ startedDateTime: "2026-09-03T05:00:00.000Z" }) as never));
  });

  test("a request is delivered before its body is even asked for", () => {
    // The bug this replaces: waiting for getContent before reporting meant every
    // JSON response — the ones that carry tokens — was swallowed, while bodiless
    // requests like CORS preflights sailed through.
    const order: string[] = [];
    const e = entry({ getContent: (cb) => { order.push("asked"); cb("{}", ""); } });
    deliver(e as never, () => order.push("delivered"), true);
    eq(order[0], "delivered", "delivery must not wait on anything");
    eq(order, ["delivered", "asked", "delivered"]);
  });

  test("a body arrives as a second delivery under the same id", () => {
    const got: RequestFacts[] = [];
    const e = entry({ getContent: (cb) => cb('{"access_token":"x"}', "") });
    deliver(e as never, (f) => got.push(f), true);
    eq(got.length, 2);
    eq(got[0]!.id, got[1]!.id, "the amendment carries the same id");
    eq(got[0]!.responseBody, undefined);
    eq(got[1]!.responseBody, '{"access_token":"x"}');
  });

  test("a getContent that never answers costs nothing", () => {
    const got: RequestFacts[] = [];
    deliver(entry({ getContent: () => { /* never calls back */ } }) as never, (f) => got.push(f), true);
    eq(got.length, 1, "the request was still reported");
  });

  test("a getContent that throws costs nothing either", () => {
    const got: RequestFacts[] = [];
    deliver(entry({ getContent: () => { throw new Error("gone"); } }) as never, (f) => got.push(f), true);
    eq(got.length, 1);
  });

  test("a backfilled entry never asks for its body", () => {
    let asked = false;
    const e = entry({ getContent: () => { asked = true; } });
    const got: RequestFacts[] = [];
    deliver(e as never, (f) => got.push(f), false);
    eq(asked, false, "backfill must not fire hundreds of content round trips");
    eq(got.length, 1);
  });

  test("a base64 body is dropped rather than scanned as text", () => {
    const got: RequestFacts[] = [];
    deliver(entry({ getContent: (cb) => cb("AAAA", "base64") }) as never, (f) => got.push(f), true);
    eq(got.length, 1, "no amendment for a body we cannot read");
  });

  test("an entry with no getContent is reported anyway", () => {
    const e = entry();
    delete e.getContent;
    const got: RequestFacts[] = [];
    deliver(e as never, (f) => got.push(f), true);
    eq(got.length, 1);
  });

  test("a missing response does not lose the request", () => {
    const got: RequestFacts[] = [];
    deliver(entry({ response: undefined as never }) as never, (f) => got.push(f), true);
    eq(got.length, 1);
    eq(got[0]!.status, 0);
    eq(got[0]!.requestHeaders.length, 1);
  });

  test("a CORS preflight and the JSON request behind it both get through", () => {
    // Exactly the shape of the failure: only the bodiless one used to arrive.
    const preflight = entry({
      startedDateTime: "2026-09-03T04:00:00.000Z",
      request: { method: "OPTIONS", url: "https://api.example.com/v1/things", headers: [] },
      response: { status: 204, headers: [], content: { mimeType: "", size: 0 } },
    });
    const real = entry({
      startedDateTime: "2026-09-03T04:00:00.100Z",
      getContent: (cb) => cb('{"ok":true}', ""),
    });
    const got: RequestFacts[] = [];
    deliver(preflight as never, (f) => got.push(f), true);
    deliver(real as never, (f) => got.push(f), true);
    eq(got.filter((f) => f.method === "OPTIONS").length, 1);
    eq(got.filter((f) => f.method === "POST").length, 2, "reported, then amended with its body");
  });
});

suite("devtools source / polling", () => {
  test("the HAR is re-read on a timer, so a silent live event cannot hide traffic", () => {
    // The timer is driven by hand: a real 2s wait would be both slow and flaky,
    // and what matters is that the tick re-reads and delivers, not that the
    // clock works.
    const realSetInterval = globalThis.setInterval;
    let tick: (() => void) | null = null;
    (globalThis as Record<string, unknown>)["setInterval"] = (fn: () => void) => { tick = fn; return 1; };

    try {
      const har: FakeEntry[] = [entry()];
      const fake = fakeChrome(har);
      const got: RequestFacts[] = [];
      const source = createDevtoolsSource();
      source.start((f: RequestFacts) => got.push(f));
      eq(got.length, 1);
      eq(fake.harCalls(), 1);
      ok(tick !== null, "a poll was scheduled");

      har.push(entry({ startedDateTime: "2026-09-03T04:20:00.000Z" }));
      tick!();
      eq(fake.harCalls(), 2, "the tick re-read the log");
      eq(got.length, 2, "the new entry arrived with no live event at all");

      tick!();
      eq(got.length, 2, "a tick with nothing new delivers nothing");
      source.stop();
    } finally {
      (globalThis as Record<string, unknown>)["setInterval"] = realSetInterval;
    }
  });

  test("stats say what each feed handed over", () => {
    const fake = fakeChrome([entry()]);
    started(() => {}, (source) => {
      fake.emit(entry({ startedDateTime: "2026-09-03T04:30:00.000Z" }));
      const lines = source.stats!().join(" · ");
      ok(lines.includes("live events 1"), lines);
      ok(lines.includes("HAR entries 1"), lines);
    });
  });
});
