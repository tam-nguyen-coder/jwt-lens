/* ---------------------------------------------------------------------------
   The DevTools feed.

   Three rules, each of them learned the hard way on a real app:

   1. Never gate delivery on anything. `getContent` is asynchronous and its
      callback is not guaranteed; the first version waited for it before
      reporting a request, which quietly swallowed every JSON response — the
      exact requests that carry tokens — while letting bodiless ones like CORS
      preflights through. A request is reported the moment it arrives, and its
      body, if it ever shows up, amends it afterwards.

   2. Never trust one feed. `onRequestFinished` reports only what happens next,
      and a panel page is not even loaded until its tab is first clicked, so
      `getHAR()` backfills what DevTools already recorded. And because the live
      event is documented to be unreliable until the Network panel has been
      opened at least once, the HAR is re-read on a timer as well.

   3. Count what arrives. When the list is empty the panel has to be able to say
      whether Chrome handed anything over at all.
   --------------------------------------------------------------------------- */

import type { Source } from "./app.ts";
import type { RequestFacts } from "./extract.ts";
import { canReadPage, drainPage, installShimLive, installShimOnReload, probePage, shimInstalled } from "./page-watch.ts";
import type { PageProbe } from "./page-watch.ts";

/** Bodies worth scanning, and a ceiling so a big download cannot stall anything. */
const TEXTUAL = /json|text|xml|javascript|urlencoded|form-data/i;
const BODY_MAX = 512_000;
/** How often the HAR is re-read, in case the live event never fires. */
const POLL_MS = 2000;

/** A request can arrive from either feed, or twice from the poll. */
export function keyOf(entry: HarEntry): string {
  return `${entry.startedDateTime}|${entry.request.method}|${entry.request.url}`;
}

export function baseFacts(entry: HarEntry): RequestFacts {
  return {
    id: keyOf(entry),
    method: entry.request.method,
    url: entry.request.url,
    status: entry.response?.status ?? 0,
    startedAt: Date.parse(entry.startedDateTime) || Date.now(),
    requestHeaders: entry.request.headers ?? [],
    responseHeaders: entry.response?.headers ?? [],
    requestBody: entry.request.postData?.text ?? null,
    // Non-standard, and the fastest way to see whether XHR/fetch traffic is
    // being reported at all or only documents and assets.
    resourceType: (entry as { _resourceType?: string })._resourceType,
  };
}

function wantsBody(entry: HarEntry): boolean {
  const mime = entry.response?.content?.mimeType ?? "";
  const size = entry.response?.content?.size ?? 0;
  return TEXTUAL.test(mime) && size <= BODY_MAX && typeof entry.getContent === "function";
}

/**
 * Report the request now; if a body turns up later, report it again under the
 * same id so the store can amend rather than double count. Nothing here can
 * prevent the first delivery.
 */
export function deliver(entry: HarEntry, onRequest: (facts: RequestFacts) => void, withBody: boolean) {
  const facts = baseFacts(entry);
  onRequest(facts);
  if (!withBody || !wantsBody(entry)) return;
  try {
    entry.getContent((content, encoding) => {
      if (!content || encoding === "base64") return;
      onRequest({ ...facts, responseBody: content });
    });
  } catch { /* the request has already been reported; the body was a bonus */ }
}

export interface DevtoolsStats {
  /** Entries handed over by the live event. */
  live: number;
  /** Entries seen in the HAR, including repeats across polls. */
  har: number;
  /** How many HAR reads have completed. */
  polls: number;
}

export function createDevtoolsSource(): Source {
  const seen = new Set<string>();
  const stats: DevtoolsStats = { live: 0, har: 0, polls: 0 };
  let timer: ReturnType<typeof setInterval> | undefined;
  let probe: PageProbe | null = null;
  let watching = false;

  const pump = (entry: HarEntry, onRequest: (f: RequestFacts) => void, withBody: boolean) => {
    const key = keyOf(entry);
    if (seen.has(key)) return;
    seen.add(key);
    deliver(entry, onRequest, withBody);
  };

  const readHar = (onRequest: (f: RequestFacts) => void) => {
    try {
      chrome.devtools.network.getHAR((har) => {
        const entries = har?.entries ?? [];
        stats.polls++;
        stats.har = entries.length;
        for (const entry of entries) pump(entry, onRequest, false);
      });
    } catch { /* a host without getHAR still gets the live feed */ }
  };

  return {
    hint: "Nothing yet. Requests are read from the tab this DevTools window is attached to"
      + " — reload the page, or hit Rescan to re-read what DevTools has already recorded.",

    start(onRequest) {
      chrome.devtools.network.onRequestFinished.addListener((entry) => {
        stats.live++;
        pump(entry, onRequest, true);
      });
      try {
        // A navigation clears DevTools' own log, so the dedupe keys go with it.
        chrome.devtools.network.onNavigated.addListener(() => seen.clear());
      } catch { /* optional across hosts */ }

      readHar(onRequest);
      probePage((p) => { probe = p; });
      // If the page was reloaded with the shim, pick the watch back up.
      shimInstalled((yes) => { watching = yes; });

      // Polling is the belt to the live event's braces: it costs one cheap call
      // every couple of seconds and it means a silent listener cannot hide an
      // app's entire API traffic, which is precisely what happened.
      timer = setInterval(() => {
        readHar(onRequest);
        probePage((p) => { probe = p; });
        if (watching) drainPage(onRequest);
      }, POLL_MS);
    },

    /**
     * The escape hatch for a browser that will not report credentialed requests:
     * reload with a shim in front of the app so the Authorization header can be
     * read as the app sets it. Opt-in, because it does change the page.
     */
    watchPage: !canReadPage() ? undefined : function watchPage() {
      watching = true;
      // Try the live install first; only fall back to a reload if it did not take.
      installShimLive((ok) => { if (!ok) installShimOnReload(); });
    },

    watchPageReload: !canReadPage() ? undefined : function watchPageReload() {
      watching = true;
      installShimOnReload();
    },

    watchingPage() {
      return watching;
    },

    rescan(onRequest) {
      readHar(onRequest);
    },

    pageFetchCount() {
      return probe && probe.pageXhr >= 0 ? probe.pageXhr : null;
    },

    stats() {
      const lines = [`live events ${stats.live}`, `HAR entries ${stats.har}`, `HAR reads ${stats.polls}`];
      if (probe) {
        lines.push(probe.pageXhr < 0
          ? `page says: ${probe.error ?? "unavailable"}`
          : `the page itself made ${probe.pageXhr} fetch/XHR calls`);
        if (probe.serviceWorker) lines.push("a service worker is handling requests");
      }
      if (watching) lines.push("watching the page directly");
      return lines;
    },

    stop() {
      clearInterval(timer);
    },
  };
}
