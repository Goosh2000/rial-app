/* build-parser.js — inline parser.js into index.html.
 *   node build-parser.js          # write
 *   node build-parser.js --check  # exit 1 if index.html is stale (CI / tests)
 * parser.js is the single source of truth; test-parser.mjs tests it directly. */
"use strict";
const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const SRC = path.join(DIR, "parser.js");
const INDEX = path.join(DIR, "index.html");
const START = "/* PARSER:START */";
const END = "/* PARSER:END */";

let body = fs.readFileSync(SRC, "utf8")
  .replace(/^\/\*[\s\S]*?\*\/\s*/, "")                              // drop the leading doc block
  .replace(/\n?if \(typeof module[\s\S]*$/, "")                     // drop the CJS export tail
  .replace(/^"use strict";\s*/m, "")                               // already strict inside the page
  .trim();
body = "/* SMS parser — generated from parser.js by build-parser.js. Edit parser.js, then: node build-parser.js */\n" + body;

const html = fs.readFileSync(INDEX, "utf8");
const s = html.indexOf(START), e = html.indexOf(END);
if (s === -1 || e === -1 || e < s) {
  console.error("build-parser: index.html is missing the " + START + " … " + END + " markers");
  process.exit(1);
}
const next = html.slice(0, s + START.length) + "\n" + body + "\n" + html.slice(e);

if (process.argv.includes("--check")) {
  if (next !== html) { console.error("build-parser: index.html is out of sync with parser.js — run: node build-parser.js"); process.exit(1); }
  console.log("build-parser: index.html is in sync with parser.js");
  process.exit(0);
}
if (next !== html) { fs.writeFileSync(INDEX, next); console.log("build-parser: wrote index.html"); }
else console.log("build-parser: index.html already current");
