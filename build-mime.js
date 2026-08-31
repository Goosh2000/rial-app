/* build-mime.js — inline mime.js into index.html.
 *   node build-mime.js          # write
 *   node build-mime.js --check  # exit 1 if index.html is stale (CI / tests)
 * mime.js is the single source of truth; test-mime.mjs tests it directly. */
"use strict";
const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const SRC = path.join(DIR, "mime.js");
const INDEX = path.join(DIR, "index.html");
const START = "/* MIME:START */";
const END = "/* MIME:END */";

let body = fs.readFileSync(SRC, "utf8")
  .replace(/^\/\*[\s\S]*?\*\/\s*/, "")                              // drop the leading doc block
  .replace(/\n?if \(typeof module[\s\S]*$/, "")                     // drop the CJS export tail
  .replace(/^"use strict";\s*/m, "")                               // already strict inside the page
  .trim();
body = "/* MIME decoder — generated from mime.js by build-mime.js. Edit mime.js, then: node build-mime.js */\n" + body;

const html = fs.readFileSync(INDEX, "utf8");
const s = html.indexOf(START), e = html.indexOf(END);
if (s === -1 || e === -1 || e < s) {
  console.error("build-mime: index.html is missing the " + START + " … " + END + " markers");
  process.exit(1);
}
const next = html.slice(0, s + START.length) + "\n" + body + "\n" + html.slice(e);

if (process.argv.includes("--check")) {
  if (next !== html) { console.error("build-mime: index.html is out of sync with mime.js — run: node build-mime.js"); process.exit(1); }
  console.log("build-mime: index.html is in sync with mime.js");
  process.exit(0);
}
if (next !== html) { fs.writeFileSync(INDEX, next); console.log("build-mime: wrote index.html"); }
else console.log("build-mime: index.html already current");
