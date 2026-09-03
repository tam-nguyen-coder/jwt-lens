import { DEFAULTS, LIST_MAX, LIST_MIN, coerce } from "../src/prefs.ts";
import { eq, suite, test } from "./harness.ts";

suite("prefs / coerce", () => {
  test("nothing stored yields the defaults", () => {
    eq(coerce(null), DEFAULTS);
    eq(coerce("garbage"), DEFAULTS);
  });

  test("a good field survives a bad one beside it", () => {
    eq(coerce({ theme: "light", listWidth: "wide" }), { ...DEFAULTS, theme: "light" });
  });

  test("the list width is clamped, not rejected", () => {
    eq(coerce({ listWidth: 10 }).listWidth, LIST_MIN);
    eq(coerce({ listWidth: 9999 }).listWidth, LIST_MAX);
    eq(coerce({ listWidth: NaN }).listWidth, DEFAULTS.listWidth);
  });

  test("only preferences are kept — a token smuggled in is dropped", () => {
    eq(Object.keys(coerce({ theme: "dark", token: "eyJhbGciOiJIUzI1NiJ9.e30.x" })).sort(),
      ["autoReadPage", "listWidth", "theme"]);
  });

  test("the page reader stays off until it has been chosen, and then stays on", () => {
    eq(coerce({}).autoReadPage, false, "never on by default");
    eq(coerce({ autoReadPage: true }).autoReadPage, true, "a choice survives a restart");
    eq(coerce({ autoReadPage: "yes" }).autoReadPage, false, "only a real boolean counts");
  });
});
