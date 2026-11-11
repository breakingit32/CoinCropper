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
const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 412, height: 915 } });
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
  window.__scan = { listeners: [], calls: [] };
  window.Capacitor = {
    isNativePlatform: () => true,
    addListener: (plugin, event, cb) => { window.__scan.listeners.push({ plugin, event, cb }); return { remove() {} }; },
    nativePromise: async (plugin, method, o) => {
      if (plugin === "BarcodeScanner") {
        window.__scan.calls.push({ method, o });
        if (method === "isSupported") return { supported: true };
        if (method === "isTorchAvailable") return { available: true };
        return {};
      }
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

// 6. Camera: ML Kit scanner path (Android app).
await page.click("[data-close=settingsSheet]");
await page.click("#startBtn");
await page.waitForFunction(() => document.documentElement.classList.contains("native-cam"));
const start = await page.evaluate(() => window.__scan.calls.find((c) => c.method === "startScan"));
check(start && start.o.formats.includes("CODE_128") && start.o.resolution === 2, "starts ML Kit scan (Code 128, 1080p)");
check(await page.isVisible("#controls") && !(await page.isVisible("#start")), "camera controls shown");
check(await page.isVisible("#torchBtn"), "flashlight button shown");
// Barcode in physical pixels; page has devicePixelRatio 2 -> CSS box 50,300 200x40.
await page.evaluate(() => {
  const l = window.__scan.listeners.find((x) => x.event === "barcodesScanned");
  l.cb({ barcodes: [{ rawValue: "6521437-005", cornerPoints: [[100, 600], [500, 600], [500, 680], [100, 680]] }] });
});
await page.waitForFunction(() => window.__coincropper.coins.get("6521437-005")?.status);
const tag = await page.evaluate(() => {
  const b = window.__coincropper.tracks.get("6521437-005").el.querySelector(".box").style;
  return { left: b.left, top: b.top, width: b.width, height: b.height };
});
check(tag.left === "50px" && tag.top === "300px" && tag.width === "200px" && tag.height === "40px",
  `AR box placed from ML Kit corners (${JSON.stringify(tag)})`);
const ngc = await page.evaluate(() => window.__coincropper.coins.get("6521437-005").result?.coin);
check(ngc?.service === "NGC" && ngc?.cert === "6521437-005", "NGC cert recognised from scan");

// 7. {barcode} placeholder sends the full scanned value.
const urls = await page.evaluate(async () => {
  const { buildSearchUrl, parseBarcode } = await import("./core.js");
  const base = "https://www.certifiedcoinexchange.com";
  return [buildSearchUrl("/m/lookup?bc={barcode}", base, parseBarcode("6521437-005")),
          buildSearchUrl("/m/lookup?bc={barcode}", base, parseBarcode("https://www.pcgs.com/cert/45678912"))];
});
check(urls[0] === "https://www.certifiedcoinexchange.com/m/lookup?bc=6521437-005", `{barcode} NGC → ${urls[0]}`);
check(urls[1] === "https://www.certifiedcoinexchange.com/m/lookup?bc=https%3A%2F%2Fwww.pcgs.com%2Fcert%2F45678912", "{barcode} QR URL is encoded");

await browser.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
