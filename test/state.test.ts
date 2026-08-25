import { DEFAULTS, RATIO_MAX, RATIO_MIN, coerce } from "../src/state.ts";
import { eq, suite, test } from "./harness.ts";

suite("state / coerce", () => {
  test("nothing stored yields the defaults", () => {
    eq(coerce(null), DEFAULTS);
    eq(coerce(undefined), DEFAULTS);
    eq(coerce("not an object"), DEFAULTS);
  });

  test("a good field survives a bad one beside it", () => {
    const got = coerce({ theme: "light", ratio: "wide", text: 42, panel: false });
    eq(got.theme, "light", "the valid field is kept");
    eq(got.ratio, DEFAULTS.ratio, "the invalid number falls back");
    eq(got.text, DEFAULTS.text, "the invalid string falls back");
    eq(got.panel, false, "false is a value, not a missing field");
  });

  test("ratio is clamped, not rejected", () => {
    eq(coerce({ ratio: 0 }).ratio, RATIO_MIN);
    eq(coerce({ ratio: 999 }).ratio, RATIO_MAX);
    eq(coerce({ ratio: NaN }).ratio, DEFAULTS.ratio, "NaN is not a usable width");
  });

  test("unknown keys are dropped rather than carried forward", () => {
    eq(Object.keys(coerce({ theme: "dark", legacyMode: true })).sort(), Object.keys(DEFAULTS).sort());
  });
});
