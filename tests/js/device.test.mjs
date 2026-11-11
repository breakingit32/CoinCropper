// Browser test for the on-device (no server) mode: node tests/js/device.test.mjs
// Needs Playwright + Chromium.  Serves web/ from https://localhost (as the
// Android app does) and fakes Capacitor's native HTTP with a fake CCE site.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
const TYPES = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json" };

let failed = 0;
const check = (ok, msg) => { console.log((ok ? "ok   " : "FAIL ") + msg); if (!ok) failed++; };

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", (e) => { console.log("pageerror", e.message); failed++; });
await page.addInitScript(() => {
  // Fake CCE: login form, session cookie, a member bid page.
  const LOGIN = `<form action="/Account/Login" method="post" enctype="multipart/form-data">
    <input name="userId" type="text"><input name="password" type="password">
    <input name="__RequestVerificationToken" type="hidden" value="tok123">
    <input name="encodedreferer" value="x" type="hidden"></form>`;
  const BIDS = `<table><tr><th>Coin</th><th>Grade</th><th>CAC</th><th>High Bid</th><th>Low Ask</th><th>Dealer</th></tr>
    <tr><td>1881-S $1</td><td>MS65</td><td>Y</td><td>$1,250.00</td><td>$1,400</td><td>ABC Coins</td></tr>
    <tr><td>1881-S $1</td><td>MS65</td><td></td><td>$1,180</td><td></td><td>XYZ Rare</td></tr>
    <tr><td>1881-S $1</td><td>MS64</td><td></td><td>$300</td><td></td><td>Other</td></tr></table>`;
  const log = (window.__cceLog = []);
  let session = false;
  window.__cceExpire = () => { session = false; };
  window.Capacitor = {
    isNativePlatform: () => true,
    nativePromise: async (plugin, method, o) => {
      log.push({ plugin, method: o.method, url: o.url, data: o.data, dataType: o.dataType });
      const u = new URL(o.url);
      if (u.pathname === "/Account/Login" && o.method === "GET") return { status: 200, data: LOGIN, headers: {} };
      if (u.pathname === "/Account/Login") {
        const f = Object.fromEntries((o.data || []).map((e) => [e.key, e.value]));
        session = f.userId === "me" && f.password === "pw" && f.__RequestVerificationToken === "tok123";
        return { status: 200, data: session ? "<a href='/account/logout'>Logout</a>" : LOGIN, headers: {} };
      }
      if (u.pathname === "/members/bids") return { status: 200, data: session ? BIDS : LOGIN, headers: {} };
      return { status: 404, data: "", headers: {} };
    },
  };
});
await page.route("https://localhost/**", (r) => {
  let f = new URL(r.request().url()).pathname; if (f === "/") f = "/index.html";
  const fp = path.join(WEB, f);
  if (!fs.existsSync(fp)) return r.fulfill({ status: 404, body: "" });
  r.fulfill({ body: fs.readFileSync(fp), contentType: TYPES[path.extname(fp)] || "application/octet-stream" });
});
await page.goto("https://localhost/");

// 1. Not configured: demo prices, no network.
await page.waitForFunction(() => document.getElementById("mode").textContent !== "…");
check(await page.textContent("#mode") === "Demo prices", "unconfigured app shows demo prices");
check(await page.isVisible("#settingsBtn"), "settings button shown in app");
let r = await page.evaluate(() => window.__coincropper.lookup("45678912").then(() => window.__coincropper.coins.get("45678912")));
check(r.result.bids.source === "mock" && r.result.bids.high_bid > 0, "demo lookup works on device");

// 2. Wrong password -> test login reports failure.
await page.click("#settingsBtn");
await page.fill("[name=cceUser]", "me");
await page.fill("[name=ccePass]", "bad");
await page.fill("[name=cceSearchUrl]", "https://www.certifiedcoinexchange.com/members/bids?pcgs={pcgs_no}&g={grade_num}");
await page.click("#testLogin");
await page.waitForFunction(() => /✓|✗/.test(document.getElementById("settingsStatus").textContent));
check((await page.textContent("#settingsStatus")).includes("✗"), "bad password is reported");

// 3. Right password -> login sends the form's hidden token as multipart.
await page.fill("[name=ccePass]", "pw");
await page.click("#testLogin");
await page.waitForFunction(() => /✓|✗/.test(document.getElementById("settingsStatus").textContent) &&
  !document.getElementById("settingsStatus").textContent.includes("bad"));
check((await page.textContent("#settingsStatus")).includes("✓"), "good password signs in");
const post = await page.evaluate(() => window.__cceLog.filter((l) => l.method === "POST").pop());
check(post.dataType === "formData" && post.data.some((e) => e.key === "__RequestVerificationToken"), "login posts multipart with anti-forgery token");
check(await page.inputValue("[name=cceSearchUrl]") !== "" , "bid page saved");
check(await page.evaluate(() => localStorage.getItem("cceSearchUrl")) === "/members/bids?pcgs={pcgs_no}&g={grade_num}", "full CCE address shortened to a path");
await page.waitForFunction(() => document.getElementById("mode").textContent === "CCE live");
check(true, "pill switches to CCE live");

// 4. Live lookup reads bids for the right grade.
r = await page.evaluate(() => window.__coincropper.lookup("45678912", { pcgs_no: "7144", grade: "MS65" })
  .then(() => window.__coincropper.coins.get("45678912").result));
check(r.bids.source === "cce" && r.bids.high_bid === 1250 && r.bids.low_ask === 1400 && r.bids.bid_count === 2,
  `live bids parsed (high ${r.bids.high_bid}, ask ${r.bids.low_ask}, ${r.bids.bid_count} bids)`);
check(r.bids.url === "https://www.certifiedcoinexchange.com/members/bids?pcgs=7144&g=65", "search URL filled in");

// 5. Expired session -> logs in again automatically.
const before = await page.evaluate(() => window.__cceLog.filter((l) => l.method === "POST").length);
r = await page.evaluate(async () => {
  const { CCEDirect } = await import("./device.js");
  const c = new CCEDirect({ userId: "me", password: "pw", searchUrl: "/members/bids?g={grade_num}" });
  c.loggedInAt = Date.now();              // we think we're signed in...
  window.__cceExpire();                   // ...but CCE ended the session
  return c.bids({ grade: "MS65", grade_num: 65 });
}).catch((e) => ({ error: e.message }));
const after = await page.evaluate(() => window.__cceLog.filter((l) => l.method === "POST").length);
check(r.high_bid === 1250 && after === before + 1, "re-login when CCE says signed out");

await browser.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
