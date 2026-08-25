import "./style.css";
import { RATIO_MAX, RATIO_MIN, loadStore, saveStore } from "./state.ts";
import type { Theme } from "./state.ts";

/* ---------------------------------------------------------------- icons
   Inline SVG string constants, drawn on a 20 grid. Stroke, fill and size come
   from `.ib svg` in style.css — never bake them into the path. Never add an
   icon package. */
const ICONS: Record<string, string> = {
  logo: `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 6h14M3 10h9M3 14h11"/><circle cx="15.5" cy="10" r="1.4" fill="currentColor" stroke="none"/></svg>`,
  panel: `<rect x="2.5" y="4" width="15" height="12" rx="2"/><path d="M12.5 4v12"/>`,
  sun: `<circle cx="10" cy="10" r="3.5"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.5 4.5 6 6M14 14l1.5 1.5M15.5 4.5 14 6M6 14l-1.5 1.5"/>`,
  moon: `<path d="M15 12.5A6.5 6.5 0 0 1 7.5 5a6.5 6.5 0 1 0 7.5 7.5z"/>`,
  copy: `<rect x="7" y="7" width="9" height="9" rx="2"/><path d="M13 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/>`,
};

const icon = (name: string) => `<svg viewBox="0 0 20 20" aria-hidden="true">${ICONS[name] ?? ""}</svg>`;

/* ---------------------------------------------------------------- markup */
const store = loadStore();
document.documentElement.dataset.theme = store.theme;

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <header class="topbar">
    <span class="brand">${ICONS.logo}<span>Jwt Lens</span></span>
    <span class="chip" id="chip" data-state="idle" title="Whatever the tool is doing right now">ready</span>
    <span class="grow"></span>
    <select class="sel" id="sample" title="Load a sample">
      <option value="">Samples…</option>
      <option value="hello">hello</option>
      <option value="empty">empty</option>
    </select>
    <button class="ib" id="copy" title="Copy the document (⌘/Ctrl + ⇧ + C)">${icon("copy")}<span class="ib-label">Copy</span></button>
    <span class="vr"></span>
    <button class="ib" id="toggle-panel" title="Show/hide the panel (⌘/Ctrl + B)" aria-pressed="${store.panel}">${icon("panel")}</button>
    <button class="ib" id="toggle-theme" title="Toggle theme">${icon(store.theme === "dark" ? "sun" : "moon")}</button>
  </header>
  <main class="workspace">
    <div class="main">
      <textarea class="input" id="input" spellcheck="false" placeholder="Replace this with the tool's real view."></textarea>
    </div>
    <aside class="panel" id="panel" style="--panel-w:${store.ratio}%" ${store.panel ? "" : "hidden"}>
      <h2>Scaffold</h2>
      <ul>
        <li>Shell, theme and persistence are wired — replace the view.</li>
        <li>Pure logic goes in its own module and gets a suite in <code>test/</code>.</li>
        <li>Colours come from <code>tokens.css</code>; never hard-code one.</li>
        <li>Every action needs a keyboard shortcut and a line in the README.</li>
      </ul>
    </aside>
  </main>
  <footer class="statusbar">
    <span class="stats" id="stats"></span>
    <span class="grow"></span>
    <span class="stats" id="hint">⌘B panel</span>
  </footer>
  <div class="toasts" id="toasts"></div>
`;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const input = $<HTMLTextAreaElement>("input");
const panel = $<HTMLElement>("panel");
const chip = $<HTMLElement>("chip");
const stats = $<HTMLElement>("stats");
const toasts = $<HTMLElement>("toasts");
const btnPanel = $<HTMLButtonElement>("toggle-panel");
const btnTheme = $<HTMLButtonElement>("toggle-theme");
const sample = $<HTMLSelectElement>("sample");

const SAMPLES: Record<string, string> = {
  hello: "hello, world\n",
  empty: "",
};

/* ---------------------------------------------------------------- toasts */
function toast(message: string, kind: "info" | "error" = "info") {
  const node = document.createElement("div");
  node.className = kind === "error" ? "toast error" : "toast";
  node.textContent = message;
  toasts.append(node);
  window.setTimeout(() => {
    node.classList.add("out");
    window.setTimeout(() => node.remove(), 350);
  }, 2000);
}

/* ---------------------------------------------------------------- state */
function setStatus(text: string, state: "idle" | "ok" | "error" | "busy" = "idle") {
  chip.textContent = text;
  chip.dataset.state = state;
}

function render() {
  const chars = input.value.length;
  const lines = input.value === "" ? 0 : input.value.split("\n").length;
  stats.textContent = `${lines} lines · ${chars} chars`;
  setStatus(chars === 0 ? "empty" : "ready", chars === 0 ? "idle" : "ok");
}

function setText(text: string) {
  input.value = text;
  store.text = text;
  render();
  saveStore(store);
}

function setPanel(shown: boolean) {
  store.panel = shown;
  panel.hidden = !shown;
  btnPanel.setAttribute("aria-pressed", String(shown));
  saveStore(store);
}

function setTheme(theme: Theme) {
  store.theme = theme;
  document.documentElement.dataset.theme = theme;
  btnTheme.innerHTML = icon(theme === "dark" ? "sun" : "moon");
  saveStore(store);
}

/* ---------------------------------------------------------------- wiring */
input.value = store.text;
store.ratio = Math.min(RATIO_MAX, Math.max(RATIO_MIN, store.ratio));
render();

input.addEventListener("input", () => {
  store.text = input.value;
  render();
  saveStore(store);
});

sample.addEventListener("change", () => {
  const chosen = SAMPLES[sample.value];
  if (chosen !== undefined) setText(chosen);
  sample.value = "";
});

$<HTMLButtonElement>("copy").addEventListener("click", () => { void copyDoc(); });
btnPanel.addEventListener("click", () => setPanel(!store.panel));
btnTheme.addEventListener("click", () => setTheme(store.theme === "dark" ? "light" : "dark"));

async function copyDoc() {
  try {
    await navigator.clipboard.writeText(input.value);
    toast(`Copied · ${input.value.length} chars`);
  } catch {
    toast("Could not reach the clipboard", "error");
  }
}

window.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === "b") { e.preventDefault(); setPanel(!store.panel); return; }
  if (mod && e.shiftKey && e.key.toLowerCase() === "c") { e.preventDefault(); void copyDoc(); }
});
