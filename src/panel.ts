/* The DevTools panel: the app, fed by the network of the inspected tab. */

import { mountApp } from "./app.ts";
import type { Source } from "./app.ts";
import type { RequestFacts } from "./extract.ts";

/** Bodies worth scanning, and a ceiling so a big download cannot stall the panel. */
const TEXTUAL = /json|text|xml|javascript|urlencoded|form-data/i;
const BODY_MAX = 512_000;

function toFacts(entry: HarEntry, done: (facts: RequestFacts) => void) {
  const facts: RequestFacts = {
    method: entry.request.method,
    url: entry.request.url,
    status: entry.response.status,
    startedAt: Date.parse(entry.startedDateTime) || Date.now(),
    requestHeaders: entry.request.headers ?? [],
    responseHeaders: entry.response.headers ?? [],
    requestBody: entry.request.postData?.text ?? null,
  };

  const mime = entry.response.content?.mimeType ?? "";
  const size = entry.response.content?.size ?? 0;
  if (!TEXTUAL.test(mime) || size > BODY_MAX) { done(facts); return; }

  // getContent is asynchronous and may never call back for a cancelled request,
  // so the request is reported either way and the body only upgrades it.
  let settled = false;
  const finish = (body: string | null) => {
    if (settled) return;
    settled = true;
    done({ ...facts, responseBody: body });
  };
  setTimeout(() => finish(null), 2000);
  try {
    entry.getContent((content, encoding) => finish(encoding === "base64" ? null : content));
  } catch {
    finish(null);
  }
}

const devtoolsSource: Source = {
  hint: "Reload the page with this panel open — every request will be read for tokens.",
  start(onRequest) {
    chrome.devtools.network.onRequestFinished.addListener((entry) => toFacts(entry, onRequest));
  },
  stop() { /* the panel dies with DevTools; there is nothing to unwind */ },
};

// panel.html is a plain page, so it also opens under `npm run dev`. Outside an
// extension there is no devtools API to hook, and crashing on a missing global
// would be a poor way to say so.
const inDevtools = typeof chrome !== "undefined" && typeof chrome.devtools !== "undefined";
if (inDevtools) {
  mountApp(devtoolsSource);
} else {
  // No source at all, so the pause control stays hidden — there is nothing to pause.
  mountApp(null, "This page is the DevTools panel. Load the extension, open DevTools on the tab you want to watch, and pick the JWT tab — or paste a token here.");
}
