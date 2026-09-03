/* ---------------------------------------------------------------------------
   The DevTools feed.

   Two feeds, not one, and the second is the one that matters. `onRequestFinished`
   reports only what happens from now on, and a DevTools panel page is not even
   loaded until the user first clicks its tab — so on an app that authenticated
   during page load, listening alone shows an empty list forever, however many
   requests the app has made. `getHAR()` returns everything DevTools has already
   recorded, so the panel backfills first and then listens.

   Kept out of panel.ts, which mounts the app on import, so this can be tested
   against a fake `chrome` rather than left as the one corner nothing covers.
   --------------------------------------------------------------------------- */

import type { Source } from "./app.ts";
import type { RequestFacts } from "./extract.ts";

/** Bodies worth scanning, and a ceiling so a big download cannot stall the panel. */
const TEXTUAL = /json|text|xml|javascript|urlencoded|form-data/i;
const BODY_MAX = 512_000;
const CONTENT_TIMEOUT_MS = 2000;

export function baseFacts(entry: HarEntry): RequestFacts {
  return {
    method: entry.request.method,
    url: entry.request.url,
    status: entry.response?.status ?? 0,
    startedAt: Date.parse(entry.startedDateTime) || Date.now(),
    requestHeaders: entry.request.headers ?? [],
    responseHeaders: entry.response?.headers ?? [],
    requestBody: entry.request.postData?.text ?? null,
  };
}

/**
 * Live requests get their response body fetched; backfilled ones do not. A HAR
 * of several hundred entries would otherwise mean several hundred round trips
 * before the list the user is already waiting for, and a token that appears
 * *only* in a response body is the rarer case.
 */
export function toFacts(entry: HarEntry, done: (facts: RequestFacts) => void, withBody: boolean) {
  const facts = baseFacts(entry);
  const mime = entry.response?.content?.mimeType ?? "";
  const size = entry.response?.content?.size ?? 0;
  if (!withBody || !TEXTUAL.test(mime) || size > BODY_MAX || typeof entry.getContent !== "function") {
    done(facts);
    return;
  }

  // getContent is asynchronous and may never call back for a cancelled request,
  // so the request is reported either way and the body only upgrades it.
  let settled = false;
  const finish = (body: string | null) => {
    if (settled) return;
    settled = true;
    done({ ...facts, responseBody: body });
  };
  setTimeout(() => finish(null), CONTENT_TIMEOUT_MS);
  try {
    entry.getContent((content, encoding) => finish(encoding === "base64" ? null : content));
  } catch {
    finish(null);
  }
}

/** A request can arrive from both feeds; this is what stops it counting twice. */
export function keyOf(entry: HarEntry): string {
  return `${entry.startedDateTime}|${entry.request.method}|${entry.request.url}`;
}

export function createDevtoolsSource(): Source {
  const seen = new Set<string>();

  const pump = (entry: HarEntry, onRequest: (f: RequestFacts) => void, withBody: boolean) => {
    const key = keyOf(entry);
    if (seen.has(key)) return;
    seen.add(key);
    toFacts(entry, onRequest, withBody);
  };

  const backfill = (onRequest: (f: RequestFacts) => void) => {
    try {
      chrome.devtools.network.getHAR((har) => {
        for (const entry of har?.entries ?? []) pump(entry, onRequest, false);
      });
    } catch { /* a host without getHAR still gets the live feed */ }
  };

  return {
    hint: "Nothing yet. Requests are read from the tab this DevTools window is attached to"
      + " — reload the page, or hit Rescan to re-read what DevTools has already recorded.",

    start(onRequest) {
      chrome.devtools.network.onRequestFinished.addListener((entry) => pump(entry, onRequest, true));
      try {
        // A navigation clears DevTools' own log, so the dedupe keys go with it.
        chrome.devtools.network.onNavigated.addListener(() => seen.clear());
      } catch { /* optional across hosts */ }
      backfill(onRequest);
    },

    rescan(onRequest) {
      backfill(onRequest);
    },

    stop() { /* the panel dies with DevTools; there is nothing to unwind */ },
  };
}
