/* ---------- a very small test harness (no dependencies, no node types) ---------- */

interface Case { name: string; fn: () => void }
interface Suite { name: string; cases: Case[] }

const suites: Suite[] = [];
let current: Suite | null = null;

export function suite(name: string, body: () => void) {
  current = { name, cases: [] };
  suites.push(current);
  body();
  current = null;
}

export function test(name: string, fn: () => void) {
  if (!current) throw new Error(`test("${name}") called outside a suite`);
  current.cases.push({ name, fn });
}

export class Failure extends Error {}

function fail(message: string): never {
  throw new Failure(message);
}

/** Structural equality. Object key order is ignored; use `keys()` to assert order. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") {
    return Number.isNaN(a) && Number.isNaN(b);
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  const aArr = Array.isArray(a), bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr) {
    const x = a as unknown[], y = b as unknown[];
    return x.length === y.length && x.every((v, i) => deepEqual(v, y[i]));
  }
  if (a instanceof Map || b instanceof Map) return false;
  if (a instanceof Set && b instanceof Set) {
    return a.size === b.size && [...a].every((v) => b.has(v));
  }
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
  const kx = Object.keys(x), ky = Object.keys(y);
  if (kx.length !== ky.length) return false;
  return kx.every((k) => Object.prototype.hasOwnProperty.call(y, k) && deepEqual(x[k], y[k]));
}

function show(v: unknown): string {
  if (v === undefined) return "undefined";
  if (v instanceof Set) return `Set(${[...v].map(show).join(", ")})`;
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s;
  } catch { return String(v); }
}

export function eq(actual: unknown, expected: unknown, label = "") {
  if (!deepEqual(actual, expected)) {
    fail(`${label ? `${label}: ` : ""}\n    got      ${show(actual)}\n    expected ${show(expected)}`);
  }
}

export function ok(cond: unknown, label = "expected a truthy value") {
  if (!cond) fail(label);
}

export function notOk(cond: unknown, label = "expected a falsy value") {
  if (cond) fail(label);
}

/** Assert the own-property order of an object, which JSON editing must preserve. */
export function keys(value: unknown, expected: string[], label = "key order") {
  const got = value !== null && typeof value === "object" ? Object.keys(value as object) : [];
  eq(got, expected, label);
}

export function throws(fn: () => unknown, label = "expected a throw") {
  try { fn(); } catch { return; }
  fail(label);
}

/** Assert a value is unchanged by reference — used to prove structural sharing. */
export function same(a: unknown, b: unknown, label = "expected the same reference") {
  if (a !== b) fail(label);
}

export function notSame(a: unknown, b: unknown, label = "expected a different reference") {
  if (a === b) fail(label);
}

export function run(): void {
  let passed = 0;
  const failures: string[] = [];
  for (const s of suites) {
    for (const c of s.cases) {
      try {
        c.fn();
        passed++;
      } catch (e) {
        const message = e instanceof Failure ? e.message : `threw ${(e as Error).message}\n${(e as Error).stack ?? ""}`;
        failures.push(`  ${s.name} › ${c.name}\n    ${message}`);
      }
    }
  }
  const total = passed + failures.length;
  if (failures.length > 0) {
    console.log(`\n${failures.length} of ${total} checks failed:\n`);
    for (const f of failures) console.log(f);
    throw new Error(`${failures.length} failing checks`);
  }
  console.log(`all ${total} checks passed across ${suites.length} suites`);
}
