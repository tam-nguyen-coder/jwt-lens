# Jwt Lens

The starting point for a tool in `dev-tools/`. It is a running app, not a folder of
stubs: top bar, theme switching, debounced persistence, toasts, a status bar and a
test suite that passes. Copy it, then replace the view.

```bash
./scaffold.sh yaml-lens 5300
```

That copies the template to `../yaml-lens`, renames every occurrence of its identity
(`jwt-lens`, `Jwt Lens`, port `5300`), and makes the first commit.

## What you get

| File | Why it is here |
| --- | --- |
| `src/tokens.css` | The shared design tokens. **Identical in every tool** — copy, never edit. `diff` against another tool should be empty |
| `src/style.css` | The component vocabulary: `.topbar` `.brand` `.chip` `.ib` `.sel` `.vr` `.grow` `.statusbar` `.toast` |
| `src/state.ts` | One versioned localStorage key, per-field validation, debounced save |
| `src/main.ts` | The shell: markup in one template, then wiring. Icons as inline SVG constants |
| `test/harness.ts` | Dependency-free assertions and runner — no test framework |
| `test/state.test.ts` | An example of the rule: pure logic gets tested, DOM gets exercised in a browser |
| `.claude/launch.json` | Fixed dev port, so Claude Code can start the tool |
| `wrangler.jsonc` | Cloudflare Pages output dir |

## Commands

```bash
npm install
npm run dev         # vite on the tool's fixed port
npm run typecheck   # tsc --noEmit
npm test            # the harness, over the pure modules
npm run build       # tsc, then vite → dist/
```

Run one suite instead of all of them:

```bash
npx tsx -e 'import("./test/state.test.ts").then(()=>import("./test/harness.ts")).then(m=>m.run())'
```

## After scaffolding

1. Replace the `<textarea>` in `src/main.ts` with the real view.
2. Redraw `public/favicon.svg` — keep the 32×32 tile, `rx="7"`, `#0d0f13` ground and
   `#4ee0b5` glyph, so it sits in the family.
3. Rewrite this README to the shape the other tools use: what it is, how to run it, why
   it exists (what it is denser or faster than), a feature table, a keyboard table, a
   source map, build and deploy notes.
4. Add the tool and its port to the table in `dev-tools/CLAUDE.md`.
5. Create the GitHub repo, push, then connect Cloudflare Pages **through the dashboard**
   (Framework preset Vite, build `npm run build`, output `dist`, production branch
   `main`). Never `wrangler pages deploy` first — a direct-upload project cannot be
   converted to a Git-connected one afterwards.

## The rules this template encodes

- Vanilla TypeScript and Vite. No framework, no UI kit, no state library, no CSS
  framework, no test runner. A dependency has to be doing something genuinely hard.
- Everything runs client-side. No backend, no upload, no account.
- 34 px of fixed chrome and nothing else permanent. Density over comfort.
- Every action has a keyboard shortcut.
- Dark by default, light supported, both driven only by tokens on `data-theme`.
- The user's work survives a refresh without being asked.
