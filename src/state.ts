/* ---------------------------------------------------------------------------
   The session store: everything the user would be annoyed to lose on a refresh,
   under one versioned localStorage key. Bump `.v1` when the shape changes in a
   way `coerce` cannot rescue.
   --------------------------------------------------------------------------- */

export type Theme = "dark" | "light";

export interface Store {
  theme: Theme;
  text: string;
  /** Side panel width as a percentage of the workspace. */
  ratio: number;
  panel: boolean;
}

export const STORE_KEY = "jwt-lens.v1";

export const RATIO_MIN = 15;
export const RATIO_MAX = 85;

export const DEFAULTS: Store = {
  theme: "dark",
  text: "",
  ratio: 32,
  panel: true,
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Pure, host-free: turn whatever came out of storage into a valid `Store`.
 * Validation is per field on purpose — one corrupt value must never cost the
 * user the rest of their session — and this never throws.
 */
export function coerce(raw: unknown, defaults: Store = DEFAULTS): Store {
  const p = (raw !== null && typeof raw === "object" ? raw : {}) as Partial<Record<keyof Store, unknown>>;
  return {
    theme: p.theme === "light" ? "light" : p.theme === "dark" ? "dark" : defaults.theme,
    text: typeof p.text === "string" ? p.text : defaults.text,
    ratio: typeof p.ratio === "number" && Number.isFinite(p.ratio)
      ? clamp(p.ratio, RATIO_MIN, RATIO_MAX)
      : defaults.ratio,
    panel: typeof p.panel === "boolean" ? p.panel : defaults.panel,
  };
}

export function loadStore(): Store {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return coerce(raw === null ? null : JSON.parse(raw));
  } catch {
    return { ...DEFAULTS };
  }
}

let timer: number | undefined;

/** Debounced — typing must not hit storage on every keystroke. */
export function saveStore(store: Store, delay = 200): void {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(store));
    } catch { /* quota or private mode — losing a save is better than a crash */ }
  }, delay);
}
