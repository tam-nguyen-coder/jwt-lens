# JWT Lens

A DevTools panel that reads the JWTs your app is actually sending, off the requests of the
tab you are inspecting. Claims in plain language, a live expiry countdown, and the rotation
history of a session — without copying a token out of the Network tab first.

The same app also runs as an ordinary page for pasting a token into — that half deploys to
Cloudflare Pages like the rest of `dev-tools/`, once the project is connected in the dashboard.

```bash
npm install
npm run dev          # http://localhost:5300 — the web build
```

Nothing is uploaded, no token is stored, and the extension asks for **no host permissions
at all**.

## Why this exists

Every JWT decoder on the web takes a token you already have. Getting that token is the
tedious part: open the Network tab, find the right request, expand the headers, select the
value out of `Authorization: Bearer …`, paste it somewhere else, and do it again after the
next refresh.

This reads the requests instead. Open the panel, reload, and every token the page sent or
received is listed — with the ones that belong to the same session grouped together, oldest
first, so a refresh is visible as a refresh rather than as a second mystery token.

### Where it looks

A token rarely lives in only one place, and which surface an app uses is often the thing you
opened the panel to find out.

| Surface | Example |
| --- | --- |
| `Authorization` header | `Bearer eyJ…`, any scheme, plus `Proxy-Authorization` |
| Custom headers | `X-Access-Token`, `X-Id-Jwt`, anything matching token / jwt / auth / assertion |
| Cookies | request `Cookie` and response `Set-Cookie`, each pair read separately |
| URL | query **and** the `#fragment` the OAuth implicit flow uses — named by parameter |
| Response body | JSON walked recursively, reporting the field: `data.tokens.access_token` |
| Request body | the refresh call's JSON or urlencoded form |

Each hit records where it came from, so a row reads `RS256 · issued 31s ago · set-cookie+body+bearer`.

### What it tells you that a decoder cannot

- **A live countdown.** `expires in 4m` ticking down, `expired 1h ago` in red. The most
  common auth bug is a clock, not a claim.
- **Rotation.** Tokens sharing an issuer, subject and audience are one group, ordered by
  `iat`. You can see when the app refreshed, and whether it waited until after expiry.
- **Which requests carried it**, with method, status and the surface it rode on — including
  the 401 that used the stale one.
- **Warnings that matter**: `alg: none`, an empty signature, `exp` before `iat`, a token
  issued in the future, no `exp` at all.

It never says a token is *valid*. Without the signing key a signature cannot be checked, so
every token is labelled `unverified` and that is the honest end of it.

## Install the extension

Not on the Chrome Web Store yet. To load it:

```bash
npm install && npm run build
```

Then in Chrome: **Extensions → Manage extensions → Developer mode → Load unpacked**, and
pick this repo's `dist/` folder. Open DevTools on any tab and take the **JWT** tab.

When the panel opens it reads everything DevTools has already recorded (`getHAR`), listens
for what follows, and re-reads the log every couple of seconds — three ways in, because the
live event alone is not dependable. What none of them can recover is traffic from before
DevTools was open at all: reload the page for that, or press **Rescan**. To check the
extension in one step, open the web build at `/?emit`: the page sends two same-origin
requests carrying a bearer token.

To submit it to the store, `npm run package` writes `jwt-lens.zip` with `manifest.json` at
the archive root — the shape the dashboard wants. [`store/LISTING.md`](store/LISTING.md) has
the listing copy, the single-purpose and data-usage answers, and the images at the required
sizes.

## Permissions

The manifest asks for nothing:

```json
{ "manifest_version": 3, "devtools_page": "devtools.html" }
```

`chrome.devtools.network` needs no permission and only ever sees the tab you deliberately
opened DevTools on. An extension that watched every tab would need `<all_urls>` and the
right to read `Authorization` headers everywhere — which, for a tool that exists to display
credentials, is not a trade worth making.

## Nothing is stored

This tool deliberately breaks the rule the rest of `dev-tools/` follows. The others restore
your whole session from `localStorage` so a refresh costs you nothing. Tokens are live
credentials, so here only the theme and the list width persist (`jwt-lens.v1`). Close the
panel and the tokens are gone. `test/prefs.test.ts` asserts that a token smuggled into the
stored object is dropped on the way back in.

## Keyboard

| | |
| --- | --- |
| `⌘V` | Decode whatever is in the clipboard — anywhere in the panel, no field to focus |
| drag & drop | A token or a file containing one |
| `⌘⌫` | Forget every token |

## When it finds nothing

An empty list has several very different causes, so the panel reports what it saw rather than
leaving you to guess: how many requests arrived, how many carried headers at all, how many had
an `Authorization`, how many held anything JWT-shaped, plus the hosts, the Chrome resource
types and the header names that turned up. The advice under the table follows from those
counts — including the two that look identical from the outside and are not: no XHR or fetch
traffic reported at all (the API calls are not reaching the panel), versus XHR traffic that
arrived with every header except the one that matters.

If it ever says a JWT-shaped string would not decode, that is a bug here rather than a quirk
of your app; the counts are what tell the two apart.

## Privacy

[`PRIVACY.md`](PRIVACY.md) — collects nothing, sends nothing, stores no tokens.

## Source map

| File | Contents |
| --- | --- |
| `src/jwt.ts` | base64url, decode, claim classification, expiry, warnings |
| `src/extract.ts` | Pulling tokens out of headers, cookies, URLs and bodies |
| `src/store.ts` | Deduplication, sighting log, rotation grouping |
| `src/app.ts` | The shell both entry points mount, and the `Source` they differ by |
| `src/panel.ts` | Mounts the app, with the DevTools source when there is one |
| `src/devtools-source.ts` | `chrome.devtools.network` → `RequestFacts`: backfill, live feed, dedupe |
| `src/web.ts` | The web entry, plus the `?demo` capture |
| `src/prefs.ts` | The little that is allowed to persist |
| `src/chrome.d.ts` | The four corners of the extension API this uses, hand-declared |
| `test/` | The pure-logic suites and their harness |

## Try it without installing

`/?demo` on the web build replays a scripted session — a login that returns a
token in its body, API calls carrying it as a bearer, a 401 from a stale service token, a
refresh that arrives in a `Set-Cookie`, and an unsigned `alg: none` token in a URL fragment.
It is how the screenshots are taken and how the UI is checked without Chrome.

## Build

```bash
npm run typecheck
npm test             # 89 checks over the pure modules
npm run build        # tsc, then vite → dist/
```

`npm test` runs the dependency-free harness (`test/harness.ts`) over everything that has no
DOM: decoding and its failure modes, unicode payloads, millisecond `exp` values, the expiry
boundary, every extraction surface, deduplication, the sighting cap, and rotation grouping.
The DevTools glue is covered too, against a fake `chrome` — backfill, the live feed, the
timer poll, the dedupe between all three, rescan, what a navigation resets, and the rule
that earned its own tests: a request is delivered before its body is even requested, so a
`getContent` that hangs or throws cannot lose it. The list itself is checked in a
browser against `?demo`.

One `dist/` serves both targets: Cloudflare Pages publishes `index.html`, and Chrome loads
the same folder as an unpacked extension. There are no inline scripts, so it satisfies the
MV3 content security policy as built.

Deploys are Cloudflare Pages via Git integration — push to `main` builds and deploys. Do not
run `wrangler pages deploy` first; a direct-upload project cannot be converted to a
Git-connected one afterwards.
