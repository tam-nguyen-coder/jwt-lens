/* ---------------------------------------------------------------------------
   Asking the page directly.

   On one real app, `chrome.devtools.network` delivered 136 requests during a full
   reload — scripts, stylesheets, fonts, documents, a websocket, and every CORS
   preflight to the API hosts — and not one `xhr` or `fetch`. The preflights prove
   those calls happened; the extension was never told about them.

   That is not how Chrome usually behaves. A lab built to reproduce it — two
   origins, real preflights, the extension loaded for real — gets `fetch` and its
   Authorization header reported normally, with or without a service worker in
   play. So the omission is specific to some setups rather than a rule, and
   whatever causes it, reading the HAR cannot be the only way in.

   The second way needs no permission either. A DevTools panel may run code in
   the page it is inspecting, and a page always knows what it asked for:

   - `probePage` is read-only. It asks the page how many fetch/XHR calls its own
     Resource Timing log contains, and whether a service worker is driving them,
     which is what separates "DevTools is hiding them" from "they are not the
     page's requests at all".

   - `WATCH_SHIM` is opt-in and does change the page: it wraps `fetch` and
     `XMLHttpRequest` so the Authorization header is captured as the app sets it.
     Injected through `reload({ injectedScript })` so it is in place before any
     app code can capture its own reference to `fetch`.

   The shim is a string because it runs in the page, not here. It touches nothing
   but its own global, forwards every call untouched, and swallows its own errors
   so a bug in it can never break the app being debugged.
   --------------------------------------------------------------------------- */

import type { RequestFacts } from "./extract.ts";

export interface PageProbe {
  /** Fetch/XHR entries in the page's own Resource Timing log. */
  pageXhr: number;
  /** True when a service worker is handling the page's requests. */
  serviceWorker: boolean;
  /** Set when the page could not be asked at all. */
  error?: string;
}

const PROBE = `(() => {
  try {
    var r = performance.getEntriesByType('resource') || [];
    var n = 0;
    for (var i = 0; i < r.length; i++) {
      var t = r[i].initiatorType;
      if (t === 'xmlhttprequest' || t === 'fetch') n++;
    }
    return JSON.stringify({
      pageXhr: n,
      serviceWorker: !!(navigator.serviceWorker && navigator.serviceWorker.controller)
    });
  } catch (e) { return JSON.stringify({ pageXhr: -1, serviceWorker: false, error: String(e) }); }
})()`;

/** Nothing here may assume the API exists; that assumption is what started all this. */
function evaluator() {
  const api = typeof chrome !== "undefined" ? chrome : undefined;
  const win = api?.devtools?.inspectedWindow;
  return typeof win?.eval === "function" ? win : null;
}

export function canReadPage(): boolean {
  return evaluator() !== null;
}

export function probePage(done: (probe: PageProbe) => void) {
  const win = evaluator();
  if (!win) { done({ pageXhr: -1, serviceWorker: false, error: "this host cannot read the page" }); return; }
  try {
    win.eval(PROBE, (result, info) => {
      if (info?.isError || info?.isException || typeof result !== "string") {
        done({ pageXhr: -1, serviceWorker: false, error: info?.value ?? info?.description ?? "the page could not be asked" });
        return;
      }
      try {
        done(JSON.parse(result) as PageProbe);
      } catch {
        done({ pageXhr: -1, serviceWorker: false, error: "unreadable answer" });
      }
    });
  } catch (e) {
    done({ pageXhr: -1, serviceWorker: false, error: String(e) });
  }
}

/** Runs in the page. Keep it ES5-plain: it has to survive whatever the app is built with. */
export const WATCH_SHIM = `(function () {
  if (window.__jwtLens) return;
  var buf = [];
  var MAX = 200;
  var push = function (url, method, auth) {
    if (!auth || buf.length >= MAX) return;
    buf.push({ url: String(url), method: String(method || 'GET'), auth: String(auth) });
  };
  window.__jwtLens = { drain: function () { return buf.splice(0, 50); } };

  var authOf = function (headers) {
    if (!headers) return '';
    try {
      if (typeof Headers !== 'undefined' && headers instanceof Headers) return headers.get('authorization') || '';
      if (Array.isArray(headers)) {
        for (var i = 0; i < headers.length; i++) {
          if (String(headers[i][0]).toLowerCase() === 'authorization') return headers[i][1];
        }
        return '';
      }
      for (var k in headers) {
        if (String(k).toLowerCase() === 'authorization') return headers[k];
      }
    } catch (e) { /* a header bag we do not understand is not worth a crash */ }
    return '';
  };

  var nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input, init) {
      try {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        var method = (init && init.method) || (input && input.method) || 'GET';
        var auth = authOf(init && init.headers) || authOf(input && input.headers);
        push(url, method, auth);
      } catch (e) { /* never get in the app's way */ }
      return nativeFetch.apply(this, arguments);
    };
  }

  var X = window.XMLHttpRequest;
  if (X && X.prototype) {
    var open = X.prototype.open, setHeader = X.prototype.setRequestHeader, send = X.prototype.send;
    X.prototype.open = function (method, url) {
      try { this.__jl = { method: method, url: url, auth: '' }; } catch (e) {}
      return open.apply(this, arguments);
    };
    X.prototype.setRequestHeader = function (name, value) {
      try { if (this.__jl && String(name).toLowerCase() === 'authorization') this.__jl.auth = value; } catch (e) {}
      return setHeader.apply(this, arguments);
    };
    X.prototype.send = function () {
      try { if (this.__jl) push(this.__jl.url, this.__jl.method, this.__jl.auth); } catch (e) {}
      return send.apply(this, arguments);
    };
  }
})()`;

interface Captured { url: string; method: string; auth: string }

/** Turn what the page reported into the same shape every other feed produces. */
export function toFacts(item: Captured, at: number): RequestFacts {
  return {
    id: `page|${item.method}|${item.url}|${at}`,
    method: item.method,
    url: item.url,
    status: 0,
    startedAt: at,
    requestHeaders: [{ name: "authorization", value: item.auth }],
    responseHeaders: [],
    resourceType: "page-watch",
  };
}

/** Parse one drain result. Anything unexpected yields nothing rather than throwing. */
export function parseDrain(result: unknown): Captured[] {
  if (typeof result !== "string" || result === "" || result === "null") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is Captured =>
    item !== null && typeof item === "object"
    && typeof (item as Captured).url === "string"
    && typeof (item as Captured).auth === "string");
}

const DRAIN = `(window.__jwtLens ? JSON.stringify(window.__jwtLens.drain()) : 'null')`;

/** True once the shim is installed in the page. */
export function shimInstalled(done: (yes: boolean) => void) {
  const win = evaluator();
  if (!win) { done(false); return; }
  win.eval("!!window.__jwtLens", (result) => done(result === true));
}

/** Reload the inspected page with the shim in front of every other script. */
export function installShim() {
  const win = evaluator();
  if (typeof win?.reload !== "function") return;
  win.reload({ injectedScript: WATCH_SHIM });
}

export function drainPage(onRequest: (facts: RequestFacts) => void) {
  const win = evaluator();
  if (!win) return;
  win.eval(DRAIN, (result) => {
    const at = Date.now();
    for (const item of parseDrain(result)) onRequest(toFacts(item, at));
  });
}
