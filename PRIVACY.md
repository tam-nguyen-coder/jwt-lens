# Privacy policy — JWT Lens

Last updated: 25 August 2026

## The short version

JWT Lens collects nothing, sends nothing, and stores no tokens.

## What it does

JWT Lens is a Chrome DevTools panel. While DevTools is open on a tab, it reads the network
requests of **that tab only**, looks for JSON Web Tokens in the headers, cookies, URLs and
bodies of those requests, decodes them, and displays the result inside the panel.

All of this happens locally, in the browser, in the panel's own memory.

## Permissions

The extension's manifest requests **no permissions and no host permissions**. It uses the
`chrome.devtools.network` API, which is available to a DevTools panel without any permission
grant and only exposes the tab whose DevTools the user has deliberately opened.

The extension cannot see any other tab, and sees nothing at all when DevTools is closed.

## Data collection

None. Specifically, JWT Lens does not collect, transmit, sell or share:

- personally identifiable information
- authentication information, including the tokens it displays
- health, financial or location data
- personal communications
- browsing history or user activity
- website content

There is no server, no analytics, no telemetry, no error reporting and no network request of
the extension's own. The code is bundled at build time; nothing is fetched or evaluated at
runtime.

## Storage

The only thing written to storage is your interface preference — the colour theme and the
width of the token list — under the `localStorage` key `jwt-lens.v1`.

Tokens are deliberately **not** persisted. They exist in the panel's memory while it is open
and are gone when it closes, because a credential left in a browser profile is a risk this
tool has no reason to create.

## Changes

Any change to this policy will be committed to the repository, and its history is public.

## Contact

Issues and questions: https://github.com/tam-nguyen-coder/jwt-lens/issues
