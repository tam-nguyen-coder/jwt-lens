/* ---------------------------------------------------------------------------
   The panel: token list on the left, everything about one token on the right.

   The same shell runs in two places. In the DevTools panel a source feeds it
   requests; on the web there is no source and tokens arrive by paste. Nothing
   below knows which — that is the whole point of `Source`.
   --------------------------------------------------------------------------- */

import "./style.css";
import { decodeJwt, expiryOf, formatRelative, formatTime, isJwt, labelOf } from "./jwt.ts";
import type { Jwt, Note } from "./jwt.ts";
import type { RequestFacts, Where } from "./extract.ts";
import { TokenStore } from "./store.ts";
import type { Diagnostics } from "./store.ts";
import { loadPrefs, savePrefs } from "./prefs.ts";
import type { Theme } from "./prefs.ts";

/** Where requests come from, when they come from anywhere. */
export interface Source {
  /** Shown in the empty state — how this host expects to be fed. */
  hint: string;
  start(onRequest: (facts: RequestFacts) => void): void;
  /** Re-read whatever the host has already recorded. Shows a button when present. */
  rescan?(onRequest: (facts: RequestFacts) => void): void;
  /** Lines about what the host itself reported, shown when nothing was found. */
  stats?(): string[];
  stop(): void;
}

const ICONS: Record<string, string> = {
  logo: `<circle cx="8" cy="10" r="3.2"/><path d="M11.2 10H18"/><path d="M15 10v2.6"/><path d="M17.6 10v1.8"/>`,
  pause: `<path d="M7.5 5v10M12.5 5v10"/>`,
  play: `<path d="M6.5 4.5v11l9-5.5z"/>`,
  clear: `<path d="M4 6h12M8 6V4.5h4V6M6.5 6l.7 9h5.6l.7-9"/>`,
  rescan: `<path d="M16 10a6 6 0 1 1-1.8-4.3"/><path d="M16 3v3.5h-3.5"/>`,
  copy: `<rect x="7" y="7" width="9" height="9" rx="2"/><path d="M13 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/>`,
  paste: `<rect x="4.5" y="4" width="11" height="13" rx="2"/><path d="M8 4V2.8h4V4"/><path d="M7.5 9h5M7.5 12h3"/>`,
  sun: `<circle cx="10" cy="10" r="3.5"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.5 4.5 6 6M14 14l1.5 1.5M15.5 4.5 14 6M6 14l-1.5 1.5"/>`,
  moon: `<path d="M15 12.5A6.5 6.5 0 0 1 7.5 5a6.5 6.5 0 1 0 7.5 7.5z"/>`,
};

const icon = (name: string) => `<svg viewBox="0 0 20 20" aria-hidden="true">${ICONS[name] ?? ""}</svg>`;

const WHERE_LABEL: Record<Where, string> = {
  authorization: "Authorization header",
  header: "custom header",
  cookie: "cookie",
  "set-cookie": "Set-Cookie",
  url: "URL",
  body: "response body",
  "request-body": "request body",
};

/** The list is narrow — a docked panel can be 300px wide — so rows get the terse form. */
const WHERE_SHORT: Record<Where, string> = {
  authorization: "bearer",
  header: "header",
  cookie: "cookie",
  "set-cookie": "set-cookie",
  url: "url",
  body: "body",
  "request-body": "req body",
};

/**
 * Why the list is empty. On a busy app "no tokens" has several very different
 * causes and they need different fixes, so the panel reports what it saw rather
 * than leaving the user to guess — which is the exact failure this tool exists
 * to end.
 */
function diagnosisHtml(d: Diagnostics, hostStats: string[]): string {
  const rows: [string, string][] = [
    ["requests seen", String(d.requests)],
    ["with request headers", `${d.withHeaders}`],
    ["with an Authorization header", `${d.withAuthHeader}`],
    ["using a Bearer scheme", `${d.withBearer}`],
    ["containing a JWT-shaped string", `${d.jwtShaped}`],
  ];

  let advice: string;
  if (d.withHeaders === 0) {
    advice = "DevTools handed over these requests without any headers. Open the Network"
      + " panel once so it records them, then reload the page and press Rescan.";
  } else if (d.withAuthHeader === 0 && !d.resourceTypes.some((t) => /^(xhr|fetch)\b/.test(t))) {
    advice = "No XHR or fetch traffic was reported at all — only documents and assets. The"
      + " API calls are not reaching this panel, so check that DevTools is attached to the"
      + " tab making them, and that they are not coming from a service worker, which"
      + " DevTools reports separately.";
  } else if (d.withAuthHeader === 0) {
    advice = "XHR/fetch traffic arrived but not one request carried an Authorization header,"
      + " even though DevTools recorded the other headers. Either the token travels another"
      + " way — a cookie or a custom header — or Chrome is withholding this header from"
      + " extensions, which needs a different approach than reading the HAR.";
  } else if (d.jwtShaped === 0) {
    advice = "Authorization headers were present but none of them held a JWT. The token is"
      + " probably opaque — a random session id rather than a signed token — and there is"
      + " nothing here to decode.";
  } else if (d.rejected > 0) {
    advice = `${d.rejected} request${d.rejected === 1 ? "" : "s"} carried something JWT-shaped`
      + " that would not decode. That is a bug in this tool — please report it with the"
      + " Authorization header value.";
  } else {
    advice = "Nothing matched yet.";
  }

  const list = (label: string, items: string[], limit: number) => items.length
    ? `<p class="diag-heads"><span>${esc(label)}</span> ${items.slice(0, limit).map(esc).join(" · ")}</p>`
    : "";

  return `<div class="diag">
    <p class="diag-lead">No JWT in ${d.requests} request${d.requests === 1 ? "" : "s"}.</p>
    <table class="diag-table">${rows.map(([k, v]) =>
      `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</table>
    <p class="diag-advice">${esc(advice)}</p>
    ${list("reported by DevTools", hostStats, 6)}
    ${list("hosts requested", d.hosts, 8)}
    ${list("resource types", d.resourceTypes, 10)}
    ${list("request headers seen", d.headerNames, 16)}
  </div>`;
}

function esc(text: string): string {
  return text.replace(/[&<>"]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"));
}

/** JSON with the family's syntax colours, as a string of HTML. */
function jsonHtml(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent + 1);
  const close = "  ".repeat(indent);
  if (value === null) return `<i class="j-null">null</i>`;
  if (typeof value === "string") return `<i class="j-str">"${esc(value)}"</i>`;
  if (typeof value === "number") return `<i class="j-num">${value}</i>`;
  if (typeof value === "boolean") return `<i class="j-bool">${value}</i>`;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((v) => `${pad}${jsonHtml(v, indent + 1)}`).join(",\n");
    return `[\n${items}\n${close}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    const items = entries
      .map(([k, v]) => `${pad}<i class="j-key">"${esc(k)}"</i>: ${jsonHtml(v, indent + 1)}`)
      .join(",\n");
    return `{\n${items}\n${close}}`;
  }
  return esc(String(value));
}

/** A token, shortened for display, with the signature always cut short. */
function maskToken(raw: string): string {
  const [h = "", p = "", s = ""] = raw.split(".");
  const clip = (seg: string, n: number) => (seg.length > n ? `${seg.slice(0, n)}…` : seg);
  return `${clip(h, 24)}.${clip(p, 40)}.${clip(s, 10)}`;
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search ? "?…" : ""}`;
  } catch {
    return url.slice(0, 60);
  }
}

export function mountApp(source: Source | null, hintOverride?: string) {
  const prefs = loadPrefs();
  document.documentElement.dataset["theme"] = prefs.theme;

  const store = new TokenStore();
  let selected: string | null = null;
  let paused = false;

  const app = document.querySelector<HTMLDivElement>("#app")!;
  app.innerHTML = `
    <header class="topbar">
      <span class="brand">${icon("logo")}<span>JWT Lens</span></span>
      <span class="chip" id="chip" data-state="idle">0 tokens</span>
      <span class="grow"></span>
      <button class="ib" id="paste" title="Paste a token (⌘V anywhere)">${icon("paste")}<span class="ib-label">Paste</span></button>
      <button class="ib" id="rescan" title="Re-read every request DevTools has recorded" ${source?.rescan ? "" : "hidden"}>${icon("rescan")}<span class="ib-label">Rescan</span></button>
      <span class="vr"></span>
      <button class="ib" id="pause" title="Stop watching requests" ${source ? "" : "hidden"}>${icon("pause")}</button>
      <button class="ib" id="clear" title="Forget every token (⌘⌫)">${icon("clear")}</button>
      <button class="ib" id="theme" title="Toggle theme">${icon(prefs.theme === "dark" ? "sun" : "moon")}</button>
    </header>
    <main class="cols" id="cols" style="--list-w:${prefs.listWidth}px">
      <aside class="list" id="list"></aside>
      <div class="gutter" id="gutter" role="separator" title="Drag to resize"></div>
      <section class="detail" id="detail"></section>
    </main>
    <footer class="statusbar">
      <span id="counts"></span>
      <span class="grow"></span>
      <span class="muted">nothing is uploaded · no token is stored</span>
    </footer>
    <div class="toasts" id="toasts"></div>
  `;

  const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  const listEl = $<HTMLElement>("list");
  const detailEl = $<HTMLElement>("detail");
  const chipEl = $<HTMLElement>("chip");
  const countsEl = $<HTMLElement>("counts");
  const toastsEl = $<HTMLElement>("toasts");
  const pauseBtn = $<HTMLButtonElement>("pause");

  function toast(message: string, kind: "info" | "error" = "info") {
    const node = document.createElement("div");
    node.className = kind === "error" ? "toast error" : "toast";
    node.textContent = message;
    toastsEl.append(node);
    setTimeout(() => { node.classList.add("out"); setTimeout(() => node.remove(), 350); }, 2200);
  }

  /* ---------- rendering ---------- */

  function nowSeconds() { return Math.floor(Date.now() / 1000); }

  function renderList() {
    const chains = store.chains();
    if (chains.length === 0) {
      listEl.innerHTML = store.requests > 0
        ? diagnosisHtml(store.diagnostics(), source?.stats?.() ?? [])
        : `<p class="empty">${esc(hintOverride ?? source?.hint ?? "Paste a token to decode it.")}</p>`;
      return;
    }
    const now = nowSeconds();
    const parts: string[] = [];
    for (const chain of chains) {
      const rotated = chain.entries.length > 1;
      parts.push(`<div class="group">
        <span class="group-label">subject</span>
        <span class="group-name">${esc(chain.label)}</span>
        ${rotated ? `<span class="group-tag" title="Same issuer, subject and audience — one session, listed oldest first">${chain.entries.length} tokens</span>` : ""}
      </div>`);
      for (const entry of chain.entries) {
        const { state, text } = expiryOf(entry.jwt, now);
        parts.push(`<button class="row${entry.token === selected ? " on" : ""}" data-token="${esc(entry.token)}" type="button">
          <span class="dot" data-state="${state}"></span>
          <span class="row-main">
            <span class="row-name">${esc(labelOf(entry.jwt))}</span>
            <span class="row-sub">${esc(entry.jwt.alg)}${entry.jwt.iat !== null ? ` · issued ${esc(formatRelative(entry.jwt.iat - now))}` : ""}${entry.wheres.length ? ` · ${esc(entry.wheres.map((w) => WHERE_SHORT[w]).join("+"))}` : ""}</span>
          </span>
          <span class="row-right">
            <span class="row-exp" data-exp="${entry.jwt.exp ?? ""}" data-nbf="${entry.jwt.nbf ?? ""}">${esc(text)}</span>
            ${entry.count > 1 ? `<span class="row-count">×${entry.count}</span>` : ""}
          </span>
        </button>`);
      }
    }
    listEl.innerHTML = parts.join("");
  }

  function noteHtml(note: Note): string {
    return `<li class="note" data-level="${note.level}">${esc(note.text)}</li>`;
  }

  function renderDetail() {
    const entry = selected ? store.get(selected) : undefined;
    if (!entry) {
      detailEl.innerHTML = `<p class="empty">${esc(store.size ? "Select a token." : "")}</p>`;
      return;
    }
    const jwt = entry.jwt;
    const now = nowSeconds();
    const { state, text } = expiryOf(jwt, now);

    const claims = jwt.claims.map((c) => `<tr>
      <td class="c-name">${esc(c.name)}${c.known ? `<span class="c-known">${esc(c.known)}</span>` : ""}</td>
      <td class="c-val">${c.display ? `${esc(c.display)}` : jsonHtml(c.value)}</td>
    </tr>`).join("");

    const sightings = entry.sightings.map((s) => `<li class="sight">
      <span class="s-method">${esc(s.method)}</span>
      <span class="s-status" data-ok="${s.status < 400}">${s.status || "—"}</span>
      <span class="s-url" title="${esc(s.url)}">${esc(shortUrl(s.url))}</span>
      <span class="s-where">${esc(WHERE_LABEL[s.where])}${s.detail && s.where !== "authorization" ? ` · ${esc(s.detail)}` : ""}</span>
      <span class="s-time">${esc(formatRelative(Math.floor(s.at / 1000) - now))}</span>
    </li>`).join("");

    detailEl.innerHTML = `
      <div class="d-head">
        <span class="chip" data-state="${state === "valid" ? "ok" : state === "unknown" ? "idle" : "error"}">${esc(text)}</span>
        <span class="chip" title="A signature cannot be checked without the key">unverified</span>
        <span class="grow"></span>
        <button class="ib" data-act="copy-token" title="Copy the raw token">${icon("copy")}<span class="ib-label">Token</span></button>
        <button class="ib" data-act="copy-payload" title="Copy the payload as JSON">${icon("copy")}<span class="ib-label">Payload</span></button>
      </div>
      <div class="d-body">
        <code class="raw" title="${esc(jwt.raw)}">${esc(maskToken(jwt.raw))}</code>
        ${jwt.notes.length ? `<ul class="notes">${jwt.notes.map(noteHtml).join("")}</ul>` : ""}
        <h3>Claims</h3>
        ${jwt.claims.length ? `<table class="claims">${claims}</table>` : `<p class="empty small">This token carries no claims.</p>`}
        <h3>Header</h3>
        <pre class="code">${jsonHtml(jwt.header)}</pre>
        <h3>Payload</h3>
        <pre class="code">${jsonHtml(jwt.payload)}</pre>
        ${entry.sightings.length ? `<h3>Seen on ${entry.count} request${entry.count > 1 ? "s" : ""}</h3><ul class="sights">${sightings}</ul>` : ""}
        <p class="muted small">First seen ${esc(formatTime(Math.floor(entry.first / 1000)))}</p>
      </div>`;

    detailEl.querySelector('[data-act="copy-token"]')!.addEventListener("click", () => copy(jwt.raw, "Token copied"));
    detailEl.querySelector('[data-act="copy-payload"]')!
      .addEventListener("click", () => copy(JSON.stringify(jwt.payload, null, 2), "Payload copied"));
  }

  function renderStatus() {
    const n = store.size;
    chipEl.textContent = `${n} token${n === 1 ? "" : "s"}`;
    chipEl.dataset["state"] = paused ? "idle" : n > 0 ? "ok" : "idle";
    const carried = store.requests
      ? `${store.withTokens} of ${store.requests} requests carried a token`
      : source ? "watching — 0 requests seen yet" : "";
    countsEl.textContent = paused ? "paused" : carried;
  }

  function render() {
    renderList();
    renderDetail();
    renderStatus();
  }

  /** Once a second, refresh only the countdowns — re-rendering everything would fight the scroll. */
  function tick() {
    const now = nowSeconds();
    for (const el of listEl.querySelectorAll<HTMLElement>(".row-exp")) {
      const exp = el.dataset["exp"] ? Number(el.dataset["exp"]) : null;
      const nbf = el.dataset["nbf"] ? Number(el.dataset["nbf"]) : null;
      const fake = { exp, nbf } as Jwt;
      const { state, text } = expiryOf(fake, now);
      el.textContent = text;
      const dot = el.closest(".row")?.querySelector<HTMLElement>(".dot");
      if (dot) dot.dataset["state"] = state;
    }
    if (selected) {
      const entry = store.get(selected);
      const chip = detailEl.querySelector<HTMLElement>(".chip");
      if (entry && chip) {
        const { state, text } = expiryOf(entry.jwt, now);
        chip.textContent = text;
        chip.dataset["state"] = state === "valid" ? "ok" : state === "unknown" ? "idle" : "error";
      }
    }
  }

  function copy(text: string, message: string) {
    void navigator.clipboard.writeText(text)
      .then(() => toast(message))
      .catch(() => toast("Clipboard is not available", "error"));
  }

  /* ---------- input ---------- */

  function addRaw(text: string): boolean {
    const tokens = text.split(/\s+/).filter(Boolean);
    let added = 0;
    for (const candidate of tokens) {
      const entry = store.addRaw(candidate, Date.now());
      if (entry) { selected = entry.token; added++; }
    }
    if (added === 0) {
      const why = decodeJwt(text);
      toast(isJwt(why) ? "Already listed" : `Not a JWT — ${why.error}`, "error");
      return false;
    }
    render();
    return true;
  }

  listEl.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".row");
    if (!row) return;
    selected = row.dataset["token"] ?? null;
    renderList();
    renderDetail();
  });

  $<HTMLButtonElement>("paste").addEventListener("click", () => {
    void navigator.clipboard.readText()
      .then((text) => { if (text.trim()) addRaw(text.trim()); })
      .catch(() => toast("Clipboard is not readable — paste with ⌘V instead", "error"));
  });

  $<HTMLButtonElement>("clear").addEventListener("click", () => {
    store.clear();
    selected = null;
    render();
  });

  pauseBtn.addEventListener("click", () => {
    paused = !paused;
    pauseBtn.innerHTML = icon(paused ? "play" : "pause");
    pauseBtn.title = paused ? "Watch requests again" : "Stop watching requests";
    pauseBtn.setAttribute("aria-pressed", String(paused));
    renderStatus();
  });

  const themeBtn = $<HTMLButtonElement>("theme");
  themeBtn.addEventListener("click", () => {
    const next: Theme = prefs.theme === "dark" ? "light" : "dark";
    prefs.theme = next;
    document.documentElement.dataset["theme"] = next;
    themeBtn.innerHTML = icon(next === "dark" ? "sun" : "moon");
    savePrefs(prefs);
  });

  // Paste anywhere: the fastest path from a token in your clipboard to its claims.
  document.addEventListener("paste", (e) => {
    const text = e.clipboardData?.getData("text")?.trim();
    if (!text) return;
    e.preventDefault();
    addRaw(text);
  });

  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    const text = e.dataTransfer?.getData("text");
    if (text?.trim()) { addRaw(text.trim()); return; }
    const file = e.dataTransfer?.files?.[0];
    if (file) void file.text().then((t) => addRaw(t.trim()));
  });

  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Backspace") {
      e.preventDefault();
      store.clear();
      selected = null;
      render();
    }
  });

  /* ---------- the draggable split ---------- */

  const gutter = $<HTMLElement>("gutter");
  const cols = $<HTMLElement>("cols");
  gutter.addEventListener("pointerdown", (down) => {
    down.preventDefault();
    gutter.setPointerCapture(down.pointerId);
    const move = (e: PointerEvent) => {
      const width = Math.min(560, Math.max(200, e.clientX - cols.getBoundingClientRect().left));
      prefs.listWidth = Math.round(width);
      cols.style.setProperty("--list-w", `${prefs.listWidth}px`);
    };
    const up = () => {
      gutter.removeEventListener("pointermove", move);
      gutter.removeEventListener("pointerup", up);
      savePrefs(prefs);
    };
    gutter.addEventListener("pointermove", move);
    gutter.addEventListener("pointerup", up);
  });

  /* ---------- go ---------- */

  render();
  setInterval(tick, 1000);

  const feed = (facts: RequestFacts) => {
    if (paused) return;
    const touched = store.add(facts);
    if (touched.length === 0) {
      renderStatus();
      if (store.size === 0) renderList();
      return;
    }
    // Select the first token to arrive, so a panel left open lands on something.
    if (!selected) selected = touched[0]!.token;
    render();
  };

  if (source?.rescan) {
    $<HTMLButtonElement>("rescan").addEventListener("click", () => {
      const before = store.size;
      source.rescan!(feed);
      // The host answers asynchronously, so report once it has had a moment.
      setTimeout(() => {
        const added = store.size - before;
        toast(added > 0 ? `Found ${added} more token${added === 1 ? "" : "s"}` : "Nothing new in the recorded requests");
      }, 400);
    });
  }

  source?.start(feed);
}
