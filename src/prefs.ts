/* ---------------------------------------------------------------------------
   The only thing this tool persists.

   Every other tool in dev-tools/ restores the whole session — documents and all
   — from one versioned localStorage key. Here that rule is deliberately broken:
   a JWT is a live credential, and leaving one in a browser profile after the tab
   is gone creates a risk the tool has no business creating. So the layout and
   the theme persist, and tokens live and die with the panel.
   --------------------------------------------------------------------------- */

export type Theme = "dark" | "light";

export interface Prefs {
  theme: Theme;
  /** Width of the token list, in pixels. */
  listWidth: number;
}

export const PREFS_KEY = "jwt-lens.v1";

export const LIST_MIN = 200;
export const LIST_MAX = 560;

export const DEFAULTS: Prefs = { theme: "dark", listWidth: 300 };

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Pure and host-free, so the fallback rules can be tested. */
export function coerce(raw: unknown, defaults: Prefs = DEFAULTS): Prefs {
  const p = (raw !== null && typeof raw === "object" ? raw : {}) as Partial<Record<keyof Prefs, unknown>>;
  return {
    theme: p.theme === "light" ? "light" : p.theme === "dark" ? "dark" : defaults.theme,
    listWidth: typeof p.listWidth === "number" && Number.isFinite(p.listWidth)
      ? clamp(p.listWidth, LIST_MIN, LIST_MAX)
      : defaults.listWidth,
  };
}

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return coerce(raw === null ? null : JSON.parse(raw));
  } catch {
    return { ...DEFAULTS };
  }
}

let timer: number | undefined;

export function savePrefs(prefs: Prefs, delay = 200): void {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch { /* private mode or a full quota is not worth a crash */ }
  }, delay);
}
