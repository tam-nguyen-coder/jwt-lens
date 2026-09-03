/* The DevTools panel: the app, fed by the network of the inspected tab. */

import { mountApp } from "./app.ts";
import { createDevtoolsSource } from "./devtools-source.ts";

// panel.html is a plain page, so it also opens under `npm run dev`. Outside an
// extension there is no devtools API to hook, and crashing on a missing global
// would be a poor way to say so.
const host = typeof chrome !== "undefined" ? chrome : undefined;
if (host?.devtools?.network) {
  mountApp(createDevtoolsSource());
} else {
  // No source at all, so the pause control stays hidden — there is nothing to pause.
  mountApp(null, "This page is the DevTools panel. Load the extension, open DevTools on the tab you want to watch, and pick the JWT tab — or paste a token here.");
}
