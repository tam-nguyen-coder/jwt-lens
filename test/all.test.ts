/* ---------- entry point: import every suite, then run them ---------- */

import "./prefs.test.ts";
import "./jwt.test.ts";
import "./extract.test.ts";
import "./devtools-source.test.ts";
import "./page-watch.test.ts";
import { run } from "./harness.ts";

run();
