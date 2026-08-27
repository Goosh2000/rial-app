/* verify-live.mjs — load the deployed GitHub Pages URL in real headless Chrome
   and confirm it renders with no errors and the SW registers over HTTPS.
   Run: node verify-live.mjs [url] */
import fs from "node:fs";
import puppeteer from "puppeteer-core";

const URL = process.argv[2] || "https://Goosh2000.github.io/rial-app/";
const CHROME = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => fs.existsSync(p));

const b = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
const pg = await b.newPage();
await pg.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });

const errs = [], fails = [];
pg.on("console", (m) => { if (m.type() === "error" && !/favicon/.test(m.text())) errs.push(m.text()); });
pg.on("pageerror", (e) => errs.push("PAGEERROR " + e.message));
pg.on("response", (r) => { if (r.status() >= 400 && !/favicon/.test(r.url())) fails.push(r.url() + " " + r.status()); });

await pg.goto(URL, { waitUntil: "networkidle0", timeout: 30000 });
await new Promise((r) => setTimeout(r, 1500));

const s = await pg.evaluate(async () => {
  const onb = document.getElementById("onb");
  const reg = ("serviceWorker" in navigator) ? await navigator.serviceWorker.getRegistration() : null;
  const mid = document.elementFromPoint(innerWidth / 2, innerHeight * 0.4);
  return {
    title: document.title,
    crashOverlay: !!document.getElementById("__crash"),
    onbVisible: onb && getComputedStyle(onb).display !== "none",
    onbText: onb ? onb.innerText.slice(0, 40).replace(/\s+/g, " ") : null,
    swScope: reg ? reg.scope : null,
    centerEl: mid ? (mid.id || mid.className || mid.tagName) : null,
  };
});
await pg.screenshot({ path: "screenshot-live.png" });
await b.close();

console.log("URL           :", URL);
console.log("title         :", s.title);
console.log("crash overlay :", s.crashOverlay ? "PRESENT (bad)" : "none (good)");
console.log("onboarding    :", s.onbVisible ? `visible: "${s.onbText}"` : "hidden");
console.log("SW registered :", s.swScope || "NO");
console.log("centre element:", s.centerEl, "(should be onb/view/app, never __crash)");
console.log("console errors:", errs.length ? errs : "none");
console.log("failed reqs   :", fails.length ? fails : "none");

const good = s.title === "Rial" && !s.crashOverlay && s.swScope && errs.length === 0 && fails.length === 0;
console.log("\n" + (good ? "PASS - live site renders cleanly" : "PROBLEM - see above"));
process.exit(good ? 0 : 1);
