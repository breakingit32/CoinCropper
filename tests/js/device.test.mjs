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
  const HOME = `<div>User id: Z11 | <a href="/account/logout">Log out</a></div>
    <form action="/mkt/viewmarket" method="get">View coin# <input type="text" name="coinno"> <input type="submit" value="GO"></form>`;
  const cell = (p, q, s, d) => `<td>${p}</td><td>${q}</td><td>${s}</td><td>${d}</td>`;
  const grid = (coinNo, title, grades, rows) => `<div><span>${title}</span></div>
    <a href="/mkt/viewmarket?coinno=${coinNo}&range=active">°Active 60-67</a>
    <a href="/mkt/viewmarket?coinno=${coinNo}&range=low">Low 2-30</a>
    <a href="/mkt/viewmarket?coinno=${coinNo}&range=middle">°Middle 30-60</a>
    <a href="/mkt/viewmarket?coinno=${coinNo}&range=high">°High 60-70</a>
    <a href="/mkt/viewmarket?coinno=${coinNo}&range=activeplus">°Active+ 63-66+</a>
    <table><tr><th>ALL</th>${grades.map((g) => `<th colspan="4">${g}</th>`).join("")}</tr>
    <tr><td></td>${grades.map(() => `<td colspan="3">View All ...</td><td>(±)</td>`).join("")}</tr>
    ${rows.map(([side, cells]) => `<tr><td>${side}</td>${cells.map((c) => c ? cell(...c) : "<td></td><td></td><td></td><td></td>").join("")}</tr>`).join("")}
    <tr><td>(mkt)</td></tr></table>`;
  // Coin 7268 (1900-O/CC $1), grades 60..67; MS64 column from the tour screenshot.
  const G = [60, 61, 62, 63, 64, 65, 66, 67];
  const at = (i, c) => G.map((_, k) => (k === i ? c : null));
  const MARKET_7268 = grid("07268", "1PE 07268 1900-O/CC $1", G, [
    ["bid", at(4, ["300", "2", "A", "G78"])], ["bid", at(4, ["320", "1", "P", "G78"])],
    ["bid", at(4, ["320", "1", "N", "C12"])], ["bid", at(4, ["480", "3", "P", "C12"])],
    ["bid", at(4, ["540s", "4", "N", "E01"])], ["bid", at(4, ["555s", "5", "P", "E01"])],
    ["bid", at(5, ["1060", "1", "P", "G78"])], ["bid", at(6, ["580s", "10", "P", "typ"])],
    ["ask", at(4, ["700s", "1", "P", "G78"])], ["ask", at(4, ["650", "1", "N", "G78"])],
  ]);
  // Same coin, High 60-70 tab: grade 68.
  const HIGH_7268 = grid("07268", "1PE 07268 1900-O/CC $1", [68, 69, 70], [["bid", [["9000", "1", "P", "K36"], null, null]]]);
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
      if (u.host.includes("greysheet.com")) {
        if (o.headers["x-api-key"] !== "GSK") return { status: 403, data: { ResponseStatus: { Message: "Unauthorized" } }, headers: {} };
        return { status: 200, headers: {}, data: { PermitAccess: true, Data: [{ GsId: 9, Name: "1900-O/CC $1", PricingData: [
          { Grade: +u.searchParams.get("Grade"), GradeLabel: "MS" + u.searchParams.get("Grade"), IsCac: false, GreyVal: "1,450.00", CpgVal: "1,850.00" }] }] } };
      }
      if (u.pathname === "/Account/Login" && o.method === "GET") return { status: 200, data: LOGIN, headers: {} };
      if (u.pathname === "/Account/Login") {
        const f = Object.fromEntries((o.data || []).map((e) => [e.key, e.value]));
        session = f.userId === "me" && f.password === "pw" && f.__RequestVerificationToken === "tok123";
        return { status: 200, data: session ? "<a href='/account/logout'>Logout</a>" : LOGIN, headers: {} };
      }
      if (u.pathname === "/members/bids") return { status: 200, data: session ? BIDS : LOGIN, headers: {} };
      if (u.pathname === "/") return { status: 200, data: session ? HOME : LOGIN, headers: {} };
      if (u.pathname === "/mkt/viewmarket") {
        if (!session) return { status: 200, data: LOGIN, headers: {} };
        const no = u.searchParams.get("coinno"), range = u.searchParams.get("range");
        if (no !== "07268") return { status: 200, data: "<p>Coin not found</p>", headers: {} };
        return { status: 200, data: range === "high" ? HIGH_7268 : MARKET_7268, headers: {}, url: o.url };
      }
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

// 4a. CCE market grid, opened by PCGS # through the "View coin#" box.
r = await page.evaluate(() => window.__coincropper.lookup("02401136", { service: "PCGS", pcgs_no: "7268", grade: "MS64", cert: "02401136" })
  .then(() => window.__coincropper.coins.get("02401136").result));
check(r.bids.source === "cce" && r.bids.high_bid === 555 && r.bids.low_ask === 700,
  `market grid: PCGS MS64 high bid ${r.bids.high_bid}, ask ${r.bids.low_ask}`);
check(r.bids.quotes.length === 8 && r.bids.quotes[0].service === "PCGS" && r.bids.quotes.find((q) => q.price === 555).sight_seen,
  "all MS64 quotes kept, PCGS first, sight-seen marked");
check(r.bids.url.includes("/mkt/viewmarket?coinno=07268"), `coin opened by padded PCGS # (${r.bids.url})`);
check(r.bids.market_title === "1PE 07268 1900-O/CC $1", "market title read");
check(/Add your Greysheet API key/.test(r.greysheet_status || ""), "no Greysheet key: says so instead of hiding it");
await page.evaluate(() => { localStorage.setItem("gsKey", "GSK"); localStorage.setItem("gsToken", "GST"); });
r = await page.evaluate(() => window.__coincropper.lookup("02401136").then(() => window.__coincropper.coins.get("02401136").result));
check(r.greysheet?.grey === 1450 && r.greysheet_status === "ok", `with a key: Greysheet ${r.greysheet?.grey}`);
await page.evaluate(() => window.__coincropper.tracks.set("02401136", { key: "02401136", el: null, slab: { cx: 200, cy: 400, w: 150, h: 210, angle: 0 }, lastSeen: performance.now() + 60000 }));
await page.waitForFunction(() => window.__coincropper.tracks.get("02401136")?.el?.textContent.includes("Grey"));
const cardText = await page.evaluate(() => window.__coincropper.tracks.get("02401136").el.textContent);
check(/Bid \$555.*Grey \$1,450/.test(cardText), `card shows bid and Greysheet (${cardText.trim()})`);
await page.evaluate(() => { window.__coincropper.tracks.get("02401136").el.click(); });
await page.waitForFunction(() => !document.getElementById("sheet").hidden);
check(await page.textContent("#gsGrey") === "$1,450" && await page.isHidden("#gsStatus"), "detail sheet shows the Greysheet price");
await page.evaluate(() => { document.querySelector("[data-close=sheet]").click(); });
await page.evaluate(() => { localStorage.removeItem("gsKey"); localStorage.removeItem("gsToken"); window.__coincropper.tracks.get("02401136")?.el?.remove(); window.__coincropper.tracks.delete("02401136"); });
r = await page.evaluate(() => window.__coincropper.lookup("X68", { service: "PCGS", pcgs_no: "7268", grade: "MS68", cert: "11111111" })
  .then(() => window.__coincropper.coins.get("X68").result));
check(r.bids.high_bid === 9000 && r.bids.url.includes("range=high"), "grade outside the first tab: follows the High 60-70 tab");
r = await page.evaluate(() => window.__coincropper.lookup("X66", { service: "PCGS", pcgs_no: "7268", grade: "MS66", cert: "22222222" })
  .then(() => window.__coincropper.coins.get("X66").result));
check(r.bids.high_bid === 580 && r.bids.quotes[0].type_coin, "type-coin bid used only when there is nothing else");

// 4b. No PCGS #: falls back to the bid page address from Settings.
r = await page.evaluate(() => window.__coincropper.lookup("45678912", { grade: "MS65", service: "NGC" })
  .then(() => window.__coincropper.coins.get("45678912").result));
check(r.bids.source === "cce" && r.bids.high_bid === 1250 && r.bids.low_ask === 1400 && r.bids.bid_count === 2,
  `live bids parsed (high ${r.bids.high_bid}, ask ${r.bids.low_ask}, ${r.bids.bid_count} bids)`);
check(r.bids.url === "https://www.certifiedcoinexchange.com/members/bids?pcgs=&g=65", "search URL filled in");

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
await page.waitForFunction(() => window.__coincropper.tracks.get("6521437-005")?.el);
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

// c) Label text but no readable barcode: needs two matching reads.
const textOnly = [
  { text: "1903-O", block: 5, corners: rect(60, 200, 150, 30) },
  { text: "PCGS MS67", block: 5, corners: rect(60, 235, 200, 30) },
  { text: "7286.67/47966447", block: 6, corners: rect(60, 270, 260, 30) },
];
await frame([], textOnly);
check(!(await page.evaluate(() => window.__coincropper.coins.has("47966447"))), "one text-only read is not trusted yet");
await frame([], textOnly);
await waitCoin("47966447");
const oc = await page.evaluate(() => window.__coincropper.coins.get("47966447"));
check(oc.code === "" && oc.result.coin.grade === "MS67" && oc.result.coin.pcgs_no === "7286", "slab identified from label text alone");
check(await page.evaluate(() => window.__coincropper.tracks.has("47966447")), "card shown for text-only slab");
check(await page.evaluate(() => window.__coincropper.coins.size) === 7, "no duplicate coins (7 total incl. earlier lookups)");

// d) Memory: camera pans; only the NGC barcode is read, the others keep their cards.
const seqBefore = await page.evaluate(() => Object.fromEntries([...window.__coincropper.coins].map(([k, c]) => [k, c.seq || 0])));
// All three in one view once (so the app learns how they sit relative to each other)...
await frame([{ raw: "6521437-005", corners: rect(100, 600, 400, 80) },
             { raw: "72686402401136", corners: rect(200, 1190, 420, 50) }], [...pcgsLines, ...textOnly]);
// ...then only the two barcodes are readable (no label text): the text-only
// slab is placed from memory and follows the camera.
const twoBars = (dx, dy) => [{ raw: "6521437-005", corners: rect(100 + dx, 600 + dy, 400, 80) },
                             { raw: "72686402401136", corners: rect(200 + dx, 1190 + dy, 420, 50) }];
await frame(twoBars(0, 0));
await page.waitForFunction(() => window.__coincropper.tracks.get("47966447")?.live === false);
const textBefore = await page.evaluate(() => ({ ...window.__coincropper.tracks.get("47966447").slab }));
for (let i = 0; i < 6; i++)   // camera moved: +60,-80 px = +30,-40 CSS (smoothing settles over a few frames)
  await frame(twoBars(60, -80));
const mem = await page.evaluate(() => {
  const t = window.__coincropper.tracks;
  return { pcgs: t.get("2401136"), text: t.get("47966447"), ngc: t.get("6521437-005") };
});
check(mem.text && mem.text.live === false && mem.ngc.live === true && mem.pcgs.live === true, "unread slab keeps its card from the remembered layout");
const dx = mem.text.slab.cx - textBefore.cx, dy = mem.text.slab.cy - textBefore.cy;
check(Math.abs(dx - 30) < 2 && Math.abs(dy + 40) < 2, `remembered card moves with the camera (${dx.toFixed(1)}, ${dy.toFixed(1)})`);
await frame([{ raw: "6521437-005", corners: rect(100, 600, 400, 80) }]);   // one slab alone...
await page.waitForTimeout(50);
check(await page.evaluate(() => window.__coincropper.tracks.get("47966447")?.lastSeen < performance.now() - 30), "...doesn't place the others (too rough a guess)");
// e) Seen again: no new lookups.
await frame([{ raw: "72686402401136", corners: rect(260, 1110, 420, 50) }], pcgsLines.map((l) => ({ ...l, corners: l.corners.map(([x, y]) => [x + 60, y - 80]) })));
await frame([], textOnly);
await page.waitForTimeout(300);
const seqAfter = await page.evaluate(() => Object.fromEntries([...window.__coincropper.coins].map(([k, c]) => [k, c.seq || 0])));
check(JSON.stringify(seqAfter) === JSON.stringify(seqBefore), "coins already scanned are not looked up again");
check(await page.evaluate(() => window.__coincropper.coins.size) === 7, "still 7 coins after rescanning");

// f) Restart: past scans come back from the phone, without new lookups.
await page.waitForTimeout(700);   // let the save run
await page.reload();
await page.waitForFunction(() => window.__coincropper?.coins);
const back = await page.evaluate(() => ({ n: window.__coincropper.coins.size, c: window.__coincropper.coins.get("2401136") }));
check(back.n >= 5 && back.c?.result?.coin?.pcgs_no === "7268", `past scans restored after restart (${back.n})`);
await page.click("#startBtn");
await page.waitForFunction(() => document.documentElement.classList.contains("native-cam"));
await frame([{ raw: "72686402401136", corners: rect(200, 1190, 420, 50) }]);
await page.waitForTimeout(300);
const again = await page.evaluate(() => window.__coincropper.coins.get("2401136"));
check(!again.seq && again.status === "ok", "restored coin seen again: no lookup");

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

// 9. Grading APIs: PCGS (key rotation, cert padding, caching) and CAC stickers.
const fixture = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/pcgs_cert_02401136.json"), "utf8"));
const gr = await page.evaluate(async (fixture) => {
  const { makeGrading, parseKeysFile } = await import("./grading.js");
  const calls = [];
  const http = async (o) => {
    calls.push(o.url.replace(/^https:\/\/[^/]+/, "") + " " + (o.headers.Authorization || o.headers["X-API-KEY"] || "").slice(-6));
    if (o.url.includes("pcgs.com")) {
      if (o.headers.Authorization === "bearer BADKEY_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")
        return { status: 401, data: { Message: "Authorization has been denied for this request." } };
      if (o.url.endsWith("/GetCoinFactsByCertNo/02401136")) return { status: 200, data: fixture };
      return { status: 200, data: { IsValidRequest: true, ServerMessage: "No data found" } };
    }
    if (o.url.includes("stickered_certs?certId=02401136")) return { status: 200, data: { data: [{ certId: "02401136", status: "Gold" }] } };
    if (o.url.includes("stickered_certs")) return { status: 200, data: { data: [] } };
    return { status: 404, data: {} };
  };
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const keys = { pcgs: ["BADKEY_" + "x".repeat(58), "GOODKEY_" + "y".repeat(57)], cacgKey: "K", cacgToken: "T" };
  const g = makeGrading({ http, getKeys: () => keys, storage });
  const r1 = await g.identify({ service: "PCGS", cert: "2401136", raw: "" });
  const n1 = calls.length;
  const r2 = await g.identify({ service: "PCGS", cert: "2401136", raw: "" });
  const kf = parseKeysFile(JSON.stringify({ pcgs: ["a".repeat(70), "b".repeat(70)], cacg_key: "k1", cacg_token: "t1", ngc_token: "n1" }));
  return { r1, r2, calls, n1, n2: calls.length, kf };
}, fixture);
check(gr.r1.grading?.name === "1900-O/CC $1" && gr.r1.grading.grade === "MS64" && gr.r1.grading.pcgs_no === "7268",
  `PCGS identifies cert 2401136 (${gr.r1.grading?.name} ${gr.r1.grading?.grade})`);
check(gr.r1.grading.price_guide === 1750 && gr.r1.grading.auctions[0].price === 1380, "price guide and auction history");
check(gr.r1.grading.cac === "Gold", "CAC sticker added");
check(gr.calls.some((c) => c.includes("02401136")), "7-digit cert padded to 8 digits");
check(gr.calls.filter((c) => c.includes("pcgs") || c.includes("Coin")).some((c) => c.endsWith("yyyyyy")), "bad PCGS key skipped, next key used");
check(gr.n2 === gr.n1 && gr.r2.grading.name === gr.r1.grading.name, "second lookup served from the phone's cache");
check(gr.kf.pcgs.length === 2 && gr.kf.cacgKey === "k1" && gr.kf.cacgToken === "t1" && gr.kf.ngcToken === "n1", "keys file import");

// 9b. Greysheet (CDN Public API).
const gsr = await page.evaluate(async () => {
  const { makeGreysheet, greyValue } = await import("./grading.js");
  const calls = [];
  const resp = (grey) => ({ Data: [{ GsId: 123, Name: "1900-O/CC $1", PricingData: [
    { Grade: 63, GradeLabel: "MS63", IsCac: false, GreyVal: "1,100.00", CpgVal: "1,400" },
    { Grade: 64, GradeLabel: "MS64", IsCac: false, GreyVal: grey, CpgVal: "1,850.00", PcgsVal: "1,750" },
    { Grade: 64, GradeLabel: "MS64", IsCac: true, GreyVal: "1,725.00", CpgVal: "2,100" },
  ] }], PermitAccess: true });
  const mk = (advancedOk) => makeGreysheet({
    getKeys: () => ({ gsKey: "K", gsToken: "T" }),
    storage: (() => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; })(),
    http: async (o) => {
      calls.push(o.url + " " + o.headers["x-api-key"] + o.headers["x-api-token"]);
      if (o.url.includes("ApiLevel=advanced") && !advancedOk) return { status: 200, data: { PermitAccess: false, AccessDeniedMessage: "Advanced API requires Dealer+" } };
      return { status: 200, data: resp(o.url.includes("ApiLevel=advanced") ? "1,450.00" : "") };
    },
  });
  const g1 = mk(true);
  const a = await g1.price({ pcgs_no: "7268", grade_num: 64, cac: null });
  const b = await g1.price({ pcgs_no: "7268", grade_num: 64, cac: "Green" });   // cached; CAC coin
  const n = calls.length;
  const c = await mk(false).price({ pcgs_no: "7268", grade_num: 64, cac: null });
  return { a, b, c, n, first: calls[0], grey: greyValue(a), greyCac: greyValue(b) };
});
check(gsr.first.includes("/GetPricingRequest?PcgsNumber=7268&Grade=64&ApiLevel=advanced") && gsr.first.endsWith(" KT"),
  "Greysheet asked by PCGS # and grade, advanced tier, with key + token");
check(gsr.grey === 1450 && gsr.a.cpg === 1850 && gsr.a.grey_cac === 1725, `Greysheet MS64: grey ${gsr.grey}, CAC grey ${gsr.a.grey_cac}, CPG ${gsr.a.cpg}`);
check(gsr.greyCac === 1725 && gsr.n === 1, "CAC coin uses the CAC price; second lookup cached");
check(gsr.c.tier === "basic" && gsr.c.cpg === 1850 && gsr.c.grey == null, "no advanced access: falls back to basic (retail)");

// 7. {barcode} placeholder sends the full scanned value.
const urls = await page.evaluate(async () => {
  const { buildSearchUrl, parseBarcode } = await import("./core.js");
  const base = "https://www.certifiedcoinexchange.com";
  return [buildSearchUrl("/m/lookup?bc={barcode}", base, parseBarcode("6521437-005")),
          buildSearchUrl("/m/lookup?bc={barcode}", base, parseBarcode("https://www.pcgs.com/cert/45678912"))];
});
check(urls[0] === "https://www.certifiedcoinexchange.com/m/lookup?bc=6521437-005", `{barcode} NGC → ${urls[0]}`);
check(urls[1] === "https://www.certifiedcoinexchange.com/m/lookup?bc=https%3A%2F%2Fwww.pcgs.com%2Fcert%2F45678912", "{barcode} QR URL is encoded");

// 10. Built-in settings (baked into the APK as builtin.local.js).
{
  const p2 = await browser.newPage();
  p2.on("pageerror", (e) => { console.log("pageerror", e.message); failed++; });
  await p2.addInitScript(() => { window.Capacitor = { isNativePlatform: () => true, nativePromise: async () => ({ status: 200, data: "" }), addListener: () => ({}) }; });
  await p2.route("https://localhost/**", (r) => {
    let f = new URL(r.request().url()).pathname; if (f === "/") f = "/index.html";
    if (f === "/builtin.local.js") return r.fulfill({ contentType: "text/javascript",
      body: 'export default {"cceUser":"me","ccePass":"pw","pcgsTokens":"k1\\nk2","cacgKey":"ck","cacgToken":"ct"};' });
    const fp = path.join(WEB, f);
    if (!fs.existsSync(fp)) return r.fulfill({ status: 404, body: "" });
    r.fulfill({ body: fs.readFileSync(fp), contentType: TYPES[path.extname(fp)] || "application/octet-stream" });
  });
  await p2.goto("https://localhost/");
  await p2.waitForFunction(() => document.getElementById("mode").textContent !== "…");
  check(await p2.textContent("#mode") === "CCE live", "built-in CCE login used without typing it in");
  await p2.click("#settingsBtn");
  check(await p2.inputValue("[name=ccePass]") === "" && await p2.getAttribute("[name=ccePass]", "placeholder") === "built into this app",
    "Settings doesn't show built-in values");
  await p2.fill("[name=cceUser]", "other"); await p2.click("#settingsForm button[type=submit]");
  check(await p2.evaluate(() => localStorage.getItem("cceUser")) === "other", "typed value overrides the built-in one");
  await p2.close();
}

await browser.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
