# Chrome Web Store listing

Everything the dashboard asks for, written out so it can be pasted rather than improvised.
Assets in this folder are already the right dimensions.

| Asset | File | Required |
| --- | --- | --- |
| Store icon, 128×128 (96×96 art + 16px padding) | `icon-128.png` | yes |
| Small promo tile, 440×280 | `tile-440x280.png` | yes |
| Screenshot, 1280×800 | `screenshot-1280x800.png` | yes, at least one |
| Marquee promo, 1400×560 | — | no |

A second screenshot of the panel docked inside DevTools is worth adding once the extension
is loaded — it shows the thing the listing is actually about, and only a real Chrome can
take it.

## Store listing tab

**Name** (45 max)

```
JWT Lens
```

**Summary** (132 max — this is also the `description` in the manifest)

```
Decode the JWTs your app is actually sending, read straight off the requests of the tab you are inspecting.
```

**Category:** Developer Tools **· Language:** English

**Description**

```
Every JWT decoder takes a token you already have. Getting that token is the tedious part:
open the Network tab, find the right request, expand the headers, select the value out of
"Authorization: Bearer ...", paste it somewhere else — and do it again after the next refresh.

JWT Lens reads the requests instead. Open DevTools, take the JWT panel, reload the page, and
every token the tab sent or received is listed and decoded.

WHERE IT LOOKS
• Authorization and Proxy-Authorization headers, any scheme
• Custom headers such as X-Access-Token or X-Id-Jwt
• Cookies on the request, and Set-Cookie on the response
• Query strings, and the #fragment the OAuth implicit flow uses
• Response bodies, walked recursively — a hit is reported as data.tokens.access_token
• Request bodies, both JSON and urlencoded, so the refresh call is covered

WHAT IT SHOWS
• A live expiry countdown: "expires in 4m" ticking down, "expired 1h ago" in red
• Rotation: tokens sharing an issuer, subject and audience are grouped and ordered by iat,
  so a refresh looks like a refresh instead of a second mystery token
• Every request that carried the token, with method, status and the surface it rode on
• Warnings that matter: alg "none", an empty signature, exp before iat, a token issued in
  the future, no exp at all
• Registered claims labelled in plain language, times in your own timezone

It never tells you a token is valid. Without the signing key a signature cannot be checked,
so every token is labelled "unverified" and that is the honest end of it.

PERMISSIONS
None. The manifest requests no permissions and no host access at all. The panel uses the
DevTools network API, which only ever sees the tab you deliberately opened DevTools on.

PRIVACY
Nothing is uploaded and no token is stored. Tokens live in the panel's memory and are gone
when you close it. Only your theme and the list width are saved.

Open source: https://github.com/tam-nguyen-coder/jwt-lens
```

## Privacy tab

**Single purpose**

```
Display and explain the JSON Web Tokens carried by the network requests of the tab the user
has opened DevTools on, inside a DevTools panel.
```

**Permission justifications**

The extension requests no permissions and no host permissions, so this section should be
empty. If the form insists on a justification for the DevTools page, use:

```
The extension is a DevTools panel and uses chrome.devtools.network to read the requests of
the inspected tab, which is the sole function of the extension. It requests no permissions
and no host access.
```

**Remote code:** No. Everything is bundled; nothing is fetched or eval'd at runtime.

**Data usage** — tick nothing. The extension collects and transmits none of these:
personally identifiable information, health information, financial information,
authentication information, personal communications, location, web history, user activity,
website content.

Note on "authentication information": the panel *displays* tokens that are already in the
page's own traffic, in the user's own browser, and never collects, stores or transmits them.
The three certifications at the bottom of the form all apply:

- does not sell or transfer user data to third parties outside of approved use cases
- does not use or transfer user data for purposes unrelated to the item's single purpose
- does not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL**

```
https://github.com/tam-nguyen-coder/jwt-lens/blob/main/PRIVACY.md
```

## Distribution tab

- Visibility: **Public** (or Unlisted while testing)
- Regions: all
- Pricing: free
- **Trader status (EU DSA):** answer this before submitting or the review stalls. An
  individual publishing a free tool is a **non-trader**.

## Test instructions tab

Reviewers need a way to see it work in under a minute. Give them one:

```
1. Open any page, then open DevTools (Cmd+Option+I / F12) and select the "JWT" panel.
2. Load https://<the pages url>/?emit — the page immediately sends two same-origin requests
   carrying an "Authorization: Bearer <sample token>" header.
3. The panel lists the token, its claims, and the two requests that carried it.

No account or credentials are needed. https://<the pages url>/?demo replays a longer scripted
session (login, API calls, a 401 on a stale token, a refresh) without any extension involved.
```

Fill in the Pages URL once the project is connected, or point at any site you can log into.

## Before uploading

```bash
npm run package     # builds, then zips dist/ with manifest.json at the archive root
```

Upload `jwt-lens.zip`. Bump `version` in `public/manifest.json` for every resubmission —
the store rejects an upload that reuses a version number.
