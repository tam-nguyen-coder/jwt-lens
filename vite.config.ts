import { defineConfig } from "vite";
import { resolve } from "node:path";

// Three entry points from one source tree: the web app, the DevTools panel, and
// the invisible page whose only job is to register that panel.
export default defineConfig({
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "index.html"),
        panel: resolve(import.meta.dirname, "panel.html"),
        devtools: resolve(import.meta.dirname, "devtools.html"),
      },
    },
  },
});
