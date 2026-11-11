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
      if (plugin === "SlabScanner") {
        window.__scan.calls.push({ method, o });
        if (method === "start") return { torch: true };
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

// 6. Camera: native SlabScanner (ML Kit barcodes + text) path.
await page.click("[data-close=settingsSheet]");
await page.click("#startBtn");
await page.waitForFunction(() => document.documentElement.classList.contains("native-cam"));
const start = await page.evaluate(() => window.__scan.calls.find((c) => c.method === "start"));
check(start && start.o.ocr === true, "starts native scanner with OCR");
check(await page.isVisible("#controls") && !(await page.isVisible("#start")), "camera controls shown");
check(await page.isVisible("#torchBtn"), "flashlight button shown");
// Image = preview size in device px (824x1830 at DPR 2) so CSS = image px / 2.
const frame = (barcodes, lines) => page.evaluate(([barcodes, lines]) => {
  const l = window.__scan.listeners.find((x) => x.plugin === "SlabScanner" && x.event === "frame");
  l.cb({ width: 824, height: 1830, view: { x: 0, y: 0, w: 824, h: 1830 }, barcodes, ...(lines ? { lines } : {}) });
}, [barcodes, lines]);
const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const waitCoin = (k) => page.waitForFunction((k) => window.__coincropper.coins.get(k)?.status === "ok" ||
  window.__coincropper.coins.get(k)?.status === "error", k);

// a) Barcode only.
await frame([{ raw: "6521437-005", corners: rect(100, 600, 400, 80) }]);
await waitCoin("6521437-005");
const sl = await page.evaluate(() => window.__coincropper.tracks.get("6521437-005").slab);
// Barcode is CSS 50..250 x 300..340: the slab must be wider, contain it near its top, and extend down.
check(sl && sl.cx > 140 && sl.cx < 160 && sl.w > 300 && sl.cy - sl.h / 2 < 300 && sl.cy + sl.h / 2 > 600,
  `slab outline estimated from barcode (${sl && [sl.cx, sl.cy, sl.w, sl.h].map(Math.round)})`);
const cls = await page.evaluate(() => window.__coincropper.tracks.get("6521437-005").el.querySelector(".box").className);
check(cls.includes("slab"), "slab outline drawn");
const ngc = await page.evaluate(() => window.__coincropper.coins.get("6521437-005").result?.coin);
check(ngc?.service === "NGC" && ngc?.cert === "6521437-005", "NGC cert recognised from barcode");

// b) Barcode first, then the label text above it in a later frame: one coin, keyed by cert.
const pcgsLines = [
  { text: "PCGS", block: 0, corners: rect(300, 1000, 120, 30) },
  { text: "1900-O/CC S$1", block: 1, corners: rect(150, 1040, 400, 40) },
  { text: "MS64", block: 1, corners: rect(300, 1085, 120, 40) },
  { text: "7268.64/2401136", block: 2, corners: rect(200, 1140, 420, 40) },
];
await frame([{ raw: "72686402401136", corners: rect(200, 1190, 420, 50) }]);
await waitCoin("72686402401136");
await frame([{ raw: "72686402401136", corners: rect(200, 1190, 420, 50) }], pcgsLines);
await waitCoin("2401136");
let st = await page.evaluate(() => ({ keys: [...window.__coincropper.coins.keys()], c: window.__coincropper.coins.get("2401136") }));
check(!st.keys.includes("72686402401136") && st.keys.includes("2401136"), "barcode + label text merged into one coin");
check(st.c.code === "72686402401136", "merged coin keeps the scanned barcode");
check(st.c.result.coin.pcgs_no === "7268" && st.c.result.coin.grade === "MS64" &&
  st.c.result.coin.description === "1900-O/CC S$1", `label text identified coin (${st.c.result.coin.description} ${st.c.result.coin.grade} #${st.c.result.coin.pcgs_no})`);
await frame([{ raw: "72686402401136", corners: rect(200, 1190, 420, 50) }]);   // barcode-only frame again
st = await page.evaluate(() => [...window.__coincropper.tracks.keys()]);
check(!st.includes("72686402401136"), "later barcode-only frames stay on the same card");

// c) Label text but no readable barcode.
await frame([], [
  { text: "1903-O", block: 5, corners: rect(60, 200, 150, 30) },
  { text: "PCGS MS67", block: 5, corners: rect(60, 235, 200, 30) },
  { text: "7286.67/47966447", block: 6, corners: rect(60, 270, 260, 30) },
]);
await waitCoin("47966447");
const oc = await page.evaluate(() => window.__coincropper.coins.get("47966447"));
check(oc.code === "" && oc.result.coin.grade === "MS67" && oc.result.coin.pcgs_no === "7286", "slab identified from label text alone");
check(await page.evaluate(() => window.__coincropper.tracks.has("47966447")), "card shown for text-only slab");
check(await page.evaluate(() => window.__coincropper.coins.size) === 4, "no duplicate coins (4 total incl. demo lookup)");

// 8. Label layout model on a real label (positions from a phone screenshot, CSS px).
const lab = await page.evaluate(async () => {
  const { readSlabs } = await import("./slab.js");
  const R = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const lines = [
    // slab above (only its lower part visible)
    { text: "1899-S", corners: R(300, 150, 390, 180) }, { text: "PCGS MS64", corners: R(390, 185, 555, 215) },
    { text: "7262.64/81628472", corners: R(365, 265, 575, 290) },
    // our slab
    { text: "PCGS", corners: R(420, 740, 530, 762) }, { text: "1900-0/CC", corners: R(235, 765, 455, 802) },
    { text: "S$1", corners: R(645, 770, 715, 805) }, { text: "MS64", corners: R(428, 808, 525, 845) },
    { text: "7268.64/2401136", corners: R(275, 885, 655, 925) },
  ];
  const bars = [{ raw: "BAR1", corners: R(285, 932, 670, 970) }];
  return readSlabs(lines, bars);
});
const s1 = lab.slabs.find((x) => x.cert === "2401136"), s0 = lab.slabs.find((x) => x.cert === "81628472");
check(lab.slabs.length === 2 && s1 && s0, "two slabs found");
check(s1.fields.year === "1900-O/CC" && s1.fields.denomination === "S$1" && s1.fields.grade === "MS64",
  `fields by position: ${JSON.stringify(s1.fields)}`);
check(s1.code === "BAR1" && !lab.loose.length, "barcode under the cert line belongs to the label");
check(s0.fields.year === "1899-S" && s0.fields.grade === "MS64", "slab above keeps its own label lines");
const b1 = s1.slab;   // true slab in the screenshot: x 80..865, y 645..1590, coin centre ~(472, 1290)
check(b1.cx - b1.w / 2 < 240 && b1.cx + b1.w / 2 > 710 && b1.cy - b1.h / 2 < 735 && b1.cy + b1.h / 2 > 1400 &&
  Math.abs(b1.cx - 472) < 40, `slab rectangle covers label and coin (${[b1.cx, b1.cy, b1.w, b1.h].map(Math.round)})`);
check(s1.ocr.startsWith("1900-O/CC S$1\nPCGS MS64\n7268.64/2401136"), "canonical label text");
const rot = await page.evaluate(async () => {
  const { readSlabs } = await import("./slab.js");
  const a = 0.2, c = Math.cos(a), s = Math.sin(a);
  const T = (pts) => pts.map(([x, y]) => [500 + (x - 500) * c - (y - 900) * s, 900 + (x - 500) * s + (y - 900) * c]);
  const R = (x0, y0, x1, y1) => T([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
  return readSlabs([{ text: "1900-0/CC", corners: R(235, 765, 455, 802) }, { text: "S$1", corners: R(645, 770, 715, 805) },
    { text: "MS64", corners: R(428, 808, 525, 845) }, { text: "7268.64/2401136", corners: R(275, 885, 655, 925) }], []);
});
check(Math.abs(rot.slabs[0].slab.angle - 0.2) < 0.01 && rot.slabs[0].fields.denomination === "S$1", "tilted slab: angle and fields");

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
