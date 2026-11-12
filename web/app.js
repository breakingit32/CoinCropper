// CoinCropper — point the phone at slabbed coins, get CCE bids floating over each one.

import { makeDeviceBackend } from "./device.js";
import { readSlabs, slabFromBarcode } from "./slab.js";
import { greyValue, parseKeysFile } from "./grading.js";
import { SceneMap } from "./scene.js";

const ZXING_URL = "https://unpkg.com/@zxing/library@0.21.3/umd/index.min.js";
const TESSERACT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
const FORMATS = ["code_128", "qr_code", "code_39", "data_matrix", "pdf417", "itf", "ean_13"];
const TRACK_TTL_MS = 1500;   // hide a tag this long after its barcode leaves view
const SCAN_INTERVAL_MS = 120;

const $ = (id) => document.getElementById(id);
const video = $("video");
const overlay = $("overlay");
const work = $("work");

const tracks = new Map();   // code -> {box, raw, lastSeen, el}
const coins = new Map();    // code -> {code, status, result, overrides, error}
let detector = null;        // {detect(video) -> [{rawValue, box:{x,y,w,h}}]}
let paused = false;
let stream = null;
let openCode = null;
let nativeCam = false;      // Android app: Google ML Kit scanner draws the camera behind the page

// Website: lookups go to the CoinCropper server that served the page.
// Android app: lookups run on the phone (device.js signs in to CCE directly),
// unless a server address is set in Settings.
const NATIVE = !!window.Capacitor?.isNativePlatform?.();
const SETTING_KEYS = ["cceUser", "ccePass", "cceSearchUrl", "pcgsTokens", "cacgKey", "cacgToken", "gsKey", "gsToken", "ngcToken", "serverUrl"];
function store(k, v) {
  try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { return null; }
}
// Built-in settings (Android app only): mobile/secrets.local.json is written into
// the APK as builtin.local.js at build time. It is never committed or served by
// the website. Anything typed in Settings overrides it.
let BUILTIN = {};
if (NATIVE) {
  try { BUILTIN = (await import("./builtin.local.js")).default || {}; } catch { BUILTIN = {}; }
}
const setting = (k) => store(k) || BUILTIN[k] || "";
const settings = () => Object.fromEntries(SETTING_KEYS.map((k) => [k, setting(k)]));
function serverUrl() { return store("serverUrl") || ""; }
const onDevice = () => NATIVE && !serverUrl();
const device = makeDeviceBackend(settings);
function api(path) {
  const base = serverUrl();
  return base ? `${base}/api/${path}` : `api/${path}`;
}
async function backendLookup(req) {
  if (onDevice()) return device.lookup(req);
  const r = await fetch(api("lookup"), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req),
  });
  if (!r.ok) throw new Error(`server ${r.status}`);
  return r.json();
}
async function backendStatus() {
  if (onDevice()) return device.status();
  const r = await fetch(api("status"));
  return r.json();
}

// ---------------------------------------------------------------- utilities

const money = (v) => v == null ? "—" :
  "$" + Number(v).toLocaleString(undefined, { maximumFractionDigits: v >= 1000 ? 0 : 2 });
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src; s.onload = res; s.onerror = () => rej(new Error("failed to load " + src));
    document.head.appendChild(s);
  });
}

// Map a box in video-pixel space onto the screen (video uses object-fit: cover).
function toScreen(b) {
  if (nativeCam) return b;   // ML Kit boxes are already in screen (CSS) pixels
  const vw = video.videoWidth, vh = video.videoHeight;
  const cw = video.clientWidth, ch = video.clientHeight;
  const s = Math.max(cw / vw, ch / vh);
  const ox = (cw - vw * s) / 2, oy = (ch - vh * s) / 2;
  return { x: b.x * s + ox, y: b.y * s + oy, w: b.w * s, h: b.h * s };
}

// ---------------------------------------------------------------- detectors

async function makeNativeDetector() {
  if (!("BarcodeDetector" in window)) return null;
  try {
    const supported = await BarcodeDetector.getSupportedFormats();
    const formats = FORMATS.filter((f) => supported.includes(f));
    if (!formats.length) return null;
    const bd = new BarcodeDetector({ formats });
    return {
      name: "native",
      async detect(src) {
        const found = await bd.detect(src);
        return found.map((f) => ({
          rawValue: f.rawValue,
          box: { x: f.boundingBox.x, y: f.boundingBox.y, w: f.boundingBox.width, h: f.boundingBox.height },
        }));
      },
    };
  } catch { return null; }
}

// @zxing/library 0.21.x Code128Reader.findStartPattern shifts its counters with
// Int32Array.slice(2), which shrinks the array instead of shifting it, so a row
// fails unless the very first dark run is the start pattern.  On a slab case
// (dark gaps, label text beside the barcode) that is almost never true.  This is
// the same algorithm with the shift done in place, as in the Java original.
function patchCode128(Z) {
  const R = Z.Code128Reader;
  R.findStartPattern = function (row) {
    const width = row.getSize();
    const rowOffset = row.getNextSet(0);
    let counterPosition = 0;
    const counters = new Int32Array(6);
    let patternStart = rowOffset;
    let isWhite = false;
    for (let i = rowOffset; i < width; i++) {
      if (row.get(i) !== isWhite) {
        counters[counterPosition]++;
      } else {
        if (counterPosition === 5) {
          let bestVariance = R.MAX_AVG_VARIANCE, bestMatch = -1;
          for (let code = R.CODE_START_A; code <= R.CODE_START_C; code++) {
            const v = Z.OneDReader.patternMatchVariance(counters, R.CODE_PATTERNS[code], R.MAX_INDIVIDUAL_VARIANCE);
            if (v < bestVariance) { bestVariance = v; bestMatch = code; }
          }
          if (bestMatch >= 0 && row.isRange(Math.max(0, patternStart - (i - patternStart) / 2), patternStart, false)) {
            return Int32Array.from([patternStart, i, bestMatch]);
          }
          patternStart += counters[0] + counters[1];
          counters.copyWithin(0, 2);
          counters[4] = 0; counters[5] = 0;
          counterPosition--;
        } else {
          counterPosition++;
        }
        counters[counterPosition] = 1;
        isWhite = !isWhite;
      }
    }
    throw new Z.NotFoundException();
  };
}

// ZXing only decodes one code per call, so sweep overlapping tiles of the frame
// (whole frame, 2x2, 3x3) round-robin to pick up every slab in a case.
async function makeZXingDetector() {
  await loadScript(ZXING_URL);
  const Z = window.ZXing;
  patchCode128(Z);
  const hints = new Map();
  hints.set(Z.DecodeHintType.TRY_HARDER, true);
  hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [
    Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.QR_CODE, Z.BarcodeFormat.CODE_39,
    Z.BarcodeFormat.DATA_MATRIX, Z.BarcodeFormat.PDF_417, Z.BarcodeFormat.ITF,
  ]);
  const reader = new Z.MultiFormatReader();
  reader.setHints(hints);
  const regions = [];
  for (const n of [1, 2, 3]) {
    const size = n === 1 ? 1 : 1.5 / n;  // 50% overlap between tiles
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      const step = n === 1 ? 0 : (1 - size) / (n - 1);
      regions.push({ x: c * step, y: r * step, w: size, h: size });
    }
  }
  let i = 0;
  const ctx = work.getContext("2d", { willReadFrequently: true });
  return {
    name: "zxing",
    async detect(src) {
      const vw = src.videoWidth, vh = src.videoHeight;
      const out = [];
      // Two tiles per tick keeps the frame rate reasonable on older phones.
      for (let k = 0; k < 2; k++) {
        const g = regions[i++ % regions.length];
        const sx = g.x * vw, sy = g.y * vh, sw = g.w * vw, sh = g.h * vh;
        const scale = Math.min(1, 1100 / sw);
        work.width = Math.round(sw * scale); work.height = Math.round(sh * scale);
        ctx.drawImage(src, sx, sy, sw, sh, 0, 0, work.width, work.height);
        try {
          const bmp = new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(work)));
          const res = reader.decodeWithState(bmp);
          const pts = res.getResultPoints().map((p) => ({ x: sx + p.getX() / scale, y: sy + p.getY() / scale }));
          const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
          let x = Math.min(...xs), y = Math.min(...ys), w = Math.max(...xs) - x, h = Math.max(...ys) - y;
          if (h < w * 0.15) { const nh = Math.max(16, w * 0.3); y -= (nh - h) / 2; h = nh; } // 1-D codes
          out.push({ rawValue: res.getText(), box: { x, y, w, h } });
        } catch { /* nothing in this tile */ }
        reader.reset();
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------- lookups

// Coins are keyed by their track key: the barcode value, or the cert number when
// the slab was identified from its label text.  coin.code is the scanned barcode
// ("" when none has been read yet).
async function lookup(key, extra = {}) {
  const coin = coins.get(key) || { code: key, overrides: {} };
  coins.set(key, coin);
  Object.assign(coin.overrides, extra);
  coin.status = "loading";
  coin.error = null;
  const seq = (coin.seq = (coin.seq || 0) + 1);
  renderTags(); if (openCode === key) renderSheet();
  try {
    const result = await backendLookup({ ...coin.overrides, code: coin.code });
    if (seq !== coin.seq) return;           // a newer lookup for this coin is running
    coin.result = result;
    coin.status = "ok";                          // other prices may still be there
    coin.error = result.bids.error ? `CCE: ${result.bids.error}` : null;
    coin.at = Date.now();
  } catch (e) {
    if (seq !== coin.seq) return;
    coin.status = "error"; coin.error = e.message;
  }
  updateCase();
  if (openCode === key) renderSheet();
}

// "1807 50C · AU53": what the coin is first, then the grade.
function coinTitle(coin) {
  const c = coin.result?.coin;
  if (!c) return coin.code || "Reading…";
  const what = c.description || [c.year, c.mint_mark].filter(Boolean).join("-") || (c.cert && `${c.service || ""} #${c.cert}`.trim());
  return [what, c.grade].filter(Boolean).join(" · ");
}

// ---------------------------------------------------------------- scanning

// found: [{key, box | slab, code?, ocr?, complete?, rel?}]
//   box  = axis-aligned barcode box (website scanner)
//   slab = {cx, cy, w, h, angle} rectangle of the whole slab (Android app)
//   code = barcode value, ocr = label text, rel = slab geometry relative to its barcode
function ingest(found) {
  const now = performance.now();
  const a = 0.55;   // smoothing
  for (const f of found) {
    const key = f.key?.trim();
    if (!key) continue;
    let t = tracks.get(key);
    if (!t) {
      t = { key, lastSeen: now, el: null };
      if (f.box) t.box = { ...f.box };
      if (f.slab) t.slab = { ...f.slab };
      tracks.set(key, t);
    } else {
      if (f.box) {
        if (!t.box) t.box = { ...f.box };
        for (const k of ["x", "y", "w", "h"]) t.box[k] += (f.box[k] - t.box[k]) * a;
      }
      if (f.slab) {
        if (!t.slab) t.slab = { ...f.slab };
        for (const k of ["cx", "cy", "w", "h"]) t.slab[k] += (f.slab[k] - t.slab[k]) * a;
        let d = f.slab.angle - t.slab.angle;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        t.slab.angle += d * a;
      }
    }
    if (f.box) t.raw = { ...f.box };
    if (f.rel) t.rel = f.rel;
    t.lastSeen = now;
    updateCoin(key, f);
  }
}

// New information about a coin from the camera. Looks it up only when there is
// something new to look up with: a coin seen before (this session or a past
// one) is not looked up again.
const REFRESH_BIDS_MS = 12 * 3600 * 1000;
function updateCoin(key, f) {
  let coin = coins.get(key), changed = false;
  if (!coin) {
    coin = { code: f.code || "", overrides: {} };
    coins.set(key, coin);
    changed = true;
  }
  coin.lastSeen = Date.now();
  const identified = !!coin.result?.grading?.name;   // grading service already knows it
  if (f.code && !coin.code) { coin.code = f.code; changed = !identified || changed; }
  // Use the first label reading, and again once one has year + grade —
  // unless the grading service has already identified the coin.
  if (!identified && f.ocr && (!coin.overrides.ocr_text || (f.complete && !coin.ocrComplete))) {
    coin.overrides.ocr_text = f.ocr;
    coin.ocrComplete = !!f.complete;
    changed = true;
  }
  // Bids from an earlier session go stale: refresh once when seen again.
  if (!changed && coin.status === "ok" && coin.at && Date.now() - coin.at > REFRESH_BIDS_MS) changed = true;
  if (changed && coin.status !== "loading") lookup(key);
}

// Once label text ties a barcode to a cert number, the barcode's track and coin
// are re-keyed by the cert so barcode and text sightings land on one card.
const aliases = new Map();   // barcode value -> cert
function linkBarcode(raw, cert) {
  if (aliases.get(raw) === cert) return;
  aliases.set(raw, cert);
  scene.rename(raw, cert);
  if (rels.has(raw) && !rels.has(cert)) rels.set(cert, rels.get(raw));
  const oldT = tracks.get(raw), oldC = coins.get(raw);
  if (oldT) {
    if (!tracks.has(cert)) { oldT.key = cert; tracks.set(cert, oldT); } else oldT.el?.remove();
    tracks.delete(raw);
  }
  if (oldC) {
    const target = coins.get(cert);
    if (!target) coins.set(cert, oldC);
    else if (!target.code) { target.code = raw; lookup(cert); }
    coins.delete(raw);
    if (openCode === raw) openCode = cert;
  }
}

// ---------------------------------------------------------------- Android camera

// Android app: SlabScanner (mobile/android/.../SlabScannerPlugin.java) runs the
// camera natively and sends every frame's ML Kit barcode + text results.  The
// camera preview is a native view behind the (transparent) page.
// Some devices report ML Kit points in the raw (landscape) buffer orientation
// instead of upright. Decide from the label text: lines facing the user read
// horizontally on screen. The decision is sticky (votes over many frames).
const orient = { score: 3, buffer: true };   // starts as seen on a real phone: buffer orientation
function voteOrientation(ev) {
  const lines = (ev.lines || []).filter((l) => l.text && l.text.replace(/\s/g, "").length >= 4 && l.corners?.length >= 3);
  if (lines.length < 2 || !ev.rotation || ev.rotation % 180 === 0) return;
  let horiz = 0, vert = 0;
  for (const l of lines) {
    const [p0, p1, p2] = l.corners;
    const e1 = [p1[0] - p0[0], p1[1] - p0[1]], e2 = [p2[0] - p1[0], p2[1] - p1[1]];
    const e = Math.hypot(...e1) >= Math.hypot(...e2) ? e1 : e2;   // reading direction
    if (Math.abs(e[0]) > Math.abs(e[1]) * 1.5) horiz++; else if (Math.abs(e[1]) > Math.abs(e[0]) * 1.5) vert++;
  }
  // In raw coordinates: horizontal text = already upright; vertical = buffer orientation.
  if (horiz > vert * 2) orient.score = Math.max(-6, orient.score - 1);
  else if (vert > horiz * 2) orient.score = Math.min(6, orient.score + 1);
  orient.buffer = orient.score > 0;
}
function toUpright(ev) {
  if (!orient.buffer || !ev.rotation || !ev.bufferWidth) return (p) => p;
  const W = ev.bufferWidth, H = ev.bufferHeight;
  if (ev.rotation === 90) return ([x, y]) => [H - y, x];
  if (ev.rotation === 270) return ([x, y]) => [y, W - x];
  if (ev.rotation === 180) return ([x, y]) => [W - x, H - y];
  return (p) => p;
}

function frameMapper(ev) {
  voteOrientation(ev);
  const up = toUpright(ev);
  const v = ev.view, dpr = window.devicePixelRatio || 1;
  const vw = v.w || innerWidth * dpr, vh = v.h || innerHeight * dpr;
  const s = Math.max(vw / ev.width, vh / ev.height);
  const ox = (v.x || 0) + (vw - ev.width * s) / 2, oy = (v.y || 0) + (vh - ev.height * s) / 2;
  return (corners) => corners.map((p) => { const q = up(p); return [(q[0] * s + ox) / dpr, (q[1] * s + oy) / dpr]; });
}
// Remembered layout of the case (see scene.js) and, per slab, where the slab
// sits relative to its barcode (learned when label and barcode are seen together).
const scene = new SceneMap();
const rels = new Map();

export function handleFrame(ev) {
  if (paused || !ev?.width) return;
  const map = frameMapper(ev);
  let bars = (ev.barcodes || []).map((b) => ({ raw: String(b.raw).trim(), corners: map(b.corners) }));
  const dets = [];
  if (ev.lines) {
    const lines = ev.lines.map((l) => ({ text: l.text, corners: map(l.corners) }));
    const { slabs, loose } = readSlabs(lines, bars);
    for (const sl of slabs) {
      if (sl.code) linkBarcode(sl.code, sl.cert);
      if (sl.rel) rels.set(sl.cert, sl.rel);
      dets.push({ key: sl.cert, slab: sl.slab, sure: !!sl.code, code: sl.code, ocr: sl.ocr, complete: sl.complete });
    }
    bars = loose;
  }
  for (const b of bars) {
    const key = aliases.get(b.raw) || b.raw;
    dets.push({ key, slab: slabFromBarcode(b.corners, rels.get(key)), sure: true, code: b.raw });
  }

  const { visible, accepted } = scene.update(dets);
  for (const d of dets) {
    const key = scene.resolve(d.key);
    if (accepted.has(key)) updateCoin(key, d);
  }
  const now = performance.now(), W = innerWidth, H = innerHeight;
  for (const v of visible) {
    if (!coins.has(v.key)) continue;
    const sl = v.slab;
    if (sl.cx < -sl.w || sl.cx > W + sl.w || sl.cy < -sl.h || sl.cy > H + sl.h) continue;   // off screen
    let t = tracks.get(v.key);
    if (!t) { t = { key: v.key, el: null }; tracks.set(v.key, t); }
    if (v.live && t.slab && t.live) {   // steady live outlines a little between frames
      const a = 0.5;
      for (const k of ["cx", "cy", "w", "h"]) t.slab[k] += (sl[k] - t.slab[k]) * a;
      let d = sl.angle - t.slab.angle; d = Math.atan2(Math.sin(d), Math.cos(d));
      t.slab.angle += d * a;
    } else t.slab = { ...sl };
    t.live = v.live;
    t.lastSeen = now;
  }
}

async function startNativeScanner() {
  const cap = window.Capacitor;
  if (!NATIVE || !cap?.nativePromise || !cap.addListener) return false;
  cap.addListener("SlabScanner", "frame", handleFrame);
  document.documentElement.classList.add("native-cam");
  let res;
  try {
    res = await cap.nativePromise("SlabScanner", "start", { ocr: true });
  } catch (e) {
    document.documentElement.classList.remove("native-cam");
    if (/not implemented|UNIMPLEMENTED|not available/i.test(`${e.code} ${e.message}`)) return false;
    $("startErr").hidden = false;
    $("startErr").textContent = `Camera unavailable: ${e.message || e}`;
    throw e;
  }
  nativeCam = true;
  $("torchBtn").hidden = !res?.torch;
  $("ocrBtn").hidden = true;   // label text is read live in this mode
  return true;
}

async function scanLoop() {
  while (stream) {
    const t0 = performance.now();
    if (!paused && video.readyState >= 2) {
      try {
        ingest((await detector.detect(video)).map((f) => ({ key: f.rawValue, code: f.rawValue, box: f.box })));
      } catch (e) { console.warn(e); }
    }
    await new Promise((r) => setTimeout(r, Math.max(0, SCAN_INTERVAL_MS - (performance.now() - t0))));
  }
}

function renderTags() {
  const now = performance.now();
  for (const [code, t] of tracks) {
    const age = now - t.lastSeen;
    // Android: slabs not placed this frame go quickly rather than linger at a stale spot.
    const ttl = nativeCam ? 900 : TRACK_TTL_MS;
    if (!paused && age > ttl) { t.el?.remove(); tracks.delete(code); continue; }
    if (!t.el) {
      t.el = document.createElement("div");
      t.el.className = "tag";
      t.el.innerHTML = `<div class="box"></div><div class="card"><div class="t1"></div><div class="t2"></div></div>`;
      t.el.addEventListener("click", () => openSheet(t.key));
      overlay.appendChild(t.el);
    }
    const coin = coins.get(code) || {};
    const box = t.el.firstChild, card = t.el.lastChild;
    const cw = card.offsetWidth || 140, chh = card.offsetHeight || 50;
    if (t.slab) {
      // Outline the whole slab and put the card over the coin, below the label.
      const sl = t.slab, deg = sl.angle * 180 / Math.PI;
      box.classList.add("slab");
      Object.assign(box.style, { left: sl.cx - sl.w / 2 + "px", top: sl.cy - sl.h / 2 + "px",
        width: sl.w + "px", height: sl.h + "px", transform: `rotate(${deg}deg)` });
      const d = sl.h * 0.14;
      const px = sl.cx - Math.sin(sl.angle) * d, py = sl.cy + Math.cos(sl.angle) * d;
      card.classList.add("oncoin");
      // Card scales with the slab so neighbouring cards don't run into each other.
      const k = Math.max(0.55, Math.min(1, sl.w / 300));
      const left = Math.min(Math.max(px, (cw * k) / 2 + 6), overlay.clientWidth - (cw * k) / 2 - 6);
      const top = Math.min(Math.max(py, (chh * k) / 2 + 56), overlay.clientHeight - (chh * k) / 2 - 90);
      Object.assign(card.style, { left: left + "px", top: top + "px", maxWidth: Math.max(110, sl.w * 0.92 / k) + "px" });
      card.style.setProperty("--k", k.toFixed(3));
      t.cardRect = { x: left - (cw * k) / 2, y: top - (chh * k) / 2, w: cw * k, h: chh * k };
    } else {
      const s = toScreen(t.box);
      Object.assign(box.style, { left: s.x + "px", top: s.y + "px", width: s.w + "px", height: s.h + "px" });
      // Float the card above the barcode; flip below it near the top edge and keep
      // it inside the screen horizontally.
      const below = s.y - 10 - chh < 56;
      const cx = Math.min(Math.max(s.x + s.w / 2, cw / 2 + 6), overlay.clientWidth - cw / 2 - 6);
      card.classList.toggle("below", below);
      Object.assign(card.style, { left: cx + "px", top: (below ? s.y + s.h + 10 : s.y - 10) + "px" });
    }
    t.el.classList.toggle("stale", !paused && age > (nativeCam ? 350 : 400));   // fades out, no blink
    t.el.classList.toggle("remembered", t.live === false);
    t.el.classList.toggle("loading", coin.status === "loading");
    t.el.classList.toggle("error", coin.status === "error");
    const t1 = card.firstChild, t2 = card.lastChild;
    const high = coin.result?.bids?.high_bid, guide = coin.result?.grading?.price_guide;
    const grey = greyValue(coin.result?.greysheet);
    const cac = coin.result?.grading?.cac;
    t1.textContent = coinTitle(coin);
    t1.classList.toggle("cac-green", cac === "Green");
    t1.classList.toggle("cac-gold", cac === "Gold");
    // CCE bid first, then Greysheet, then the PCGS guide.
    const fallback = grey != null ? `Grey ${money(grey)}` : guide != null ? `Guide ${money(guide)}` : null;
    t2.classList.toggle("none", coin.status === "ok" && high == null && fallback == null);
    t2.classList.toggle("guide", high == null && fallback != null);
    const label = coin.status === "loading" ? "Looking up…" :
      coin.status === "error" ? (fallback || "Lookup failed") :
      high != null ? `Bid ${money(high)}` : fallback || noPriceReason(coin);
    const extra = coin.status !== "loading" && high != null && grey != null ? ` · Grey ${money(grey)}` : "";
    if (t2.dataset.v !== label + extra) {
      t2.dataset.v = label + extra;
      t2.innerHTML = esc(label) + (extra ? `<small class="sub">${esc(extra)}</small>` : "");
    }
  }
}

// Short reason on the card when there's no price at all, so one look says
// which step is missing.
function noPriceReason(coin) {
  const r = coin.result || {};
  const notes = (r.coin?.notes || []).join(" ");
  const gs = r.greysheet_status || "";
  if (/Not found in the Greysheet catalog/i.test(notes)) return "Not in Greysheet catalog";
  if (/catalog:.*(denied|refused|section not found|HTTP)/i.test(notes)) return "Catalog: " + (/section not found/.test(notes) ? "layout?" : "refused");
  if (/Add your Greysheet/i.test(gs)) return "No Greysheet key";
  if (/refused|denied/i.test(gs)) return "Greysheet key refused";
  if (/no price for grade/i.test(gs)) return "No Greysheet price for grade";
  if (/no listing/i.test(gs)) return "Not listed on Greysheet";
  if (/Needs the coin's/i.test(gs)) return "No PCGS # found";
  if (gs && gs !== "ok") return "Greysheet: " + gs.slice(0, 28);
  if (coin.error) return "No price · tap";
  return "No bids";
}

// Cards of slabs read in this frame win; a remembered card that would cover
// another card is hidden.
function declutter() {
  const placed = [];
  const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const list = [...tracks.values()].filter((t) => t.el && t.cardRect)
    .sort((p, q) => (q.live ? 1 : 0) - (p.live ? 1 : 0));
  for (const t of list) {
    const hide = !t.live && placed.some((r) => hit(r, t.cardRect));
    t.el.lastChild.style.visibility = hide ? "hidden" : "";
    if (!hide) placed.push(t.cardRect);
  }
}

function frame() { renderTags(); declutter(); requestAnimationFrame(frame); }

// ---------------------------------------------------------------- sheets

function openSheet(code) {
  openCode = code;
  $("caseSheet").hidden = true;
  $("sheet").hidden = false;
  const c = coins.get(code)?.result?.coin || {};
  const f = $("editForm");
  for (const k of ["service", "cert", "pcgs_no", "grade", "description"]) f.elements[k].value = c[k] || "";
  $("ocrStatus").hidden = true;
  renderSheet();
}

function renderSheet() {
  const coin = coins.get(openCode);
  if (!coin) return;
  const res = coin.result || {};
  const c = res.coin || {};
  const b = res.bids || { quotes: [] };
  $("dTitle").textContent = c.description || [c.year, c.mint_mark].filter(Boolean).join("-") || "Certified coin";
  $("dSub").textContent = [c.service, c.grade, c.cert && `Cert ${c.cert}`, c.pcgs_no && `PCGS# ${c.pcgs_no}`]
    .filter(Boolean).join(" · ") || coin.code;
  $("dBid").textContent = coin.status === "loading" ? "…" : money(b.high_bid);
  $("dAsk").textContent = coin.status === "loading" ? "…" : money(b.low_ask);
  $("dCount").textContent = b.bid_count ?? 0;
  $("dErr").hidden = !coin.error;
  $("dErr").textContent = coin.error || "";
  const quotes = [...(b.quotes || [])].sort((x, y) =>
    x.side === y.side ? (x.side === "bid" ? y.price - x.price : x.price - y.price) : x.side === "bid" ? -1 : 1);
  $("dNote").hidden = !(b.note || b.market_title);
  $("dNote").textContent = [b.market_title && `CCE market: ${b.market_title}`, b.note].filter(Boolean).join(" · ");
  $("dQuotes").innerHTML = quotes.map((q) => `<tr${q.type_coin || (b.for_service && q.service && q.service !== b.for_service) ? ' class="other"' : ""}>
      <td class="${q.side}">${q.side === "bid" ? "Bid" : "Ask"}</td>
      <td class="${q.side}">${esc(money(q.price))}${q.sight_seen ? " <small>sight-seen</small>" : ""}${q.cac ? " <small>CAC</small>" : ""}${q.type_coin ? " <small>type</small>" : ""}${q.qty > 1 ? ` <small>×${q.qty}</small>` : ""}</td>
      <td>${esc(q.dealer || "")}</td><td>${esc([q.service, q.grade].filter(Boolean).join(" "))}</td></tr>`).join("")
    || `<tr><td colspan="4" class="muted">No quotes found.</td></tr>`;
  $("cceLink").href = res.cce_url || "https://www.certifiedcoinexchange.com";
  $("verifyLink").hidden = !res.verify_url;
  if (res.verify_url) $("verifyLink").href = res.verify_url;
  renderGrading(res.grading);
  renderGreysheet(res.greysheet, res.greysheet_status);
  const notes = [...(c.notes || []), coin.code ? `Barcode: ${coin.code}` : "Read from label text"];
  if (b.source === "mock") notes.unshift(NATIVE ? "Demo prices — add your CCE account in Settings for live bids."
    : "Demo prices — connect your CCE account on the server for live bids.");
  $("dNotes").textContent = notes.join(" · ");
}

function renderGreysheet(g, status) {
  // Always shown once a lookup has run, so it's clear why there's no price.
  $("greyBox").hidden = !g && !status;
  $("gsStatus").hidden = !status || status === "ok";
  $("gsStatus").textContent = status && status !== "ok" ? status : "";
  if (!g) { for (const id of ["gsGrey", "gsGreyCac", "gsCpg"]) $(id).textContent = "—"; $("gsMeta").textContent = ""; return; }
  $("gsGrey").textContent = money(g.grey);
  $("gsGreyCac").textContent = money(g.grey_cac);
  $("gsCpg").textContent = money(g.cpg);
  $("gsMeta").textContent = g.none ? `No Greysheet price for grade ${g.grade}`
    : [g.name, g.grade_label, g.tier === "basic" && "retail only (basic API tier)", g.cac && g.grey_cac && "CAC price used"]
      .filter(Boolean).join(" · ");
}

function renderGrading(g) {
  $("gradingBox").hidden = !g;
  $("coinfactsLink").hidden = !g?.coinfacts_url;
  if (!g) return;
  if (g.coinfacts_url) $("coinfactsLink").href = g.coinfacts_url;
  $("gImg").hidden = !g.image;
  if (g.image) $("gImg").src = g.image;
  $("gTitle").textContent = [g.name, g.grade].filter(Boolean).join(" · ") || `${g.service} ${g.cert}`;
  $("gMeta").textContent = [`${g.service} cert ${g.cert}`, g.pcgs_no && `PCGS# ${g.pcgs_no}`, g.variety].filter(Boolean).join(" · ");
  $("gGuide").textContent = money(g.price_guide);
  $("gPop").textContent = g.population != null ? `${g.population} / ${g.pop_higher ?? "—"}` : "—";
  $("gCac").textContent = g.cac || "No";
  $("gCac").className = g.cac ? "cac-" + g.cac.toLowerCase() : "";
  const rows = (g.auctions || []).map((a) => `<tr><td>${esc(a.date || "")}</td>
      <td class="bid">${esc(money(a.price))}${a.cac ? " <small>CAC</small>" : ""}</td>
      <td>${a.url ? `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.auctioneer || "lot")}</a>` : esc(a.auctioneer || "")}</td></tr>`);
  $("gAuctions").hidden = !rows.length;
  $("gAuctions").tBodies[0].innerHTML = rows.join("");
}

// Value used for the case total: the CCE high bid, else the PCGS price guide.
const coinValue = (c) => c.result?.bids?.high_bid ?? null;
const greyOf = (c) => greyValue(c.result?.greysheet);
const guideValue = (c) => c.result?.grading?.price_guide ?? null;

// Past scans are kept on the phone so coins aren't looked up again next time.
const SAVED_KEY = "coins:v1", SAVED_MAX = 500;
let saveTimer = null;
function saveCoins() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const done = [...coins.entries()].filter(([, c]) => c.status === "ok" && c.result)
      .sort((a, b) => (b[1].lastSeen || 0) - (a[1].lastSeen || 0)).slice(0, SAVED_MAX)
      .map(([k, c]) => [k, { code: c.code, overrides: c.overrides, result: c.result, at: c.at, lastSeen: c.lastSeen }]);
    try { localStorage.setItem(SAVED_KEY, JSON.stringify({ coins: done, aliases: [...aliases] })); } catch { /* full */ }
  }, 500);
}
function loadCoins() {
  try {
    const saved = JSON.parse(localStorage.getItem(SAVED_KEY) || "null");
    for (const [k, c] of saved?.coins || []) coins.set(k, { ...c, status: "ok", saved: true });
    for (const [a, b] of saved?.aliases || []) aliases.set(a, b);
  } catch { /* nothing saved */ }
}

function updateCase() {
  saveCoins();
  // The case = coins seen since the app opened; earlier scans stay remembered
  // (so they're not looked up again) but aren't counted.
  const all = [...coins.entries()];
  const list = all.filter(([, c]) => !c.saved || (c.lastSeen && c.lastSeen >= startedAt));
  const remembered = all.length - list.length;
  const total = list.reduce((s, [, c]) => s + (coinValue(c) || 0), 0);
  const guide = list.reduce((s, [, c]) => s + (guideValue(c) || 0), 0);
  const greyT = list.reduce((s, [, c]) => s + (greyOf(c) || 0), 0);
  $("caseCount").textContent = list.length;
  // Headline: each coin's best value (CCE bid, else Greysheet, else PCGS guide).
  const best = list.reduce((s, [, c]) => s + (coinValue(c) ?? greyOf(c) ?? guideValue(c) ?? 0), 0);
  $("caseTotal").textContent = money(best);
  $("caseSub").textContent = `${list.length} coins this session · CCE bids ${money(total)}` +
    (greyT ? ` · Greysheet ${money(greyT)}` : "") + (guide ? ` · PCGS guide ${money(guide)}` : "") +
    (remembered ? ` · ${remembered} more remembered from earlier` : "");
  $("caseList").innerHTML = list.map(([key, c]) => `<li data-code="${esc(key)}">
      <span>${esc(coinTitle(c))}${c.result?.grading?.cac ? ` <small class="cac-${esc(c.result.grading.cac.toLowerCase())}">CAC</small>` : ""}</span>
      <span class="p">${esc(coinValue(c) != null ? money(coinValue(c)) : greyOf(c) != null ? "Grey " + money(greyOf(c))
        : guideValue(c) != null ? "Guide " + money(guideValue(c)) : "—")}</span></li>`).join("");
}

// ---------------------------------------------------------------- OCR

async function ocrLabel() {
  const status = $("ocrStatus");
  status.hidden = false; status.textContent = "Reading label…";
  try {
    if (!window.Tesseract) await loadScript(TESSERACT_URL);
    const t = tracks.get(openCode);
    const vw = video.videoWidth, vh = video.videoHeight;
    // Label text sits beside / above the barcode; grab a generous area around it.
    let r = { x: 0, y: 0, w: vw, h: vh };
    if (t?.raw) {
      const b = t.raw;
      r = { x: b.x - b.w * 1.2, y: b.y - b.h * 3, w: b.w * 3.4, h: b.h * 6 };
      r.x = Math.max(0, r.x); r.y = Math.max(0, r.y);
      r.w = Math.min(vw - r.x, r.w); r.h = Math.min(vh - r.y, r.h);
    }
    const scale = Math.min(3, 1600 / r.w);
    const c = document.createElement("canvas");
    c.width = r.w * scale; c.height = r.h * scale;
    const ctx = c.getContext("2d");
    ctx.filter = "grayscale(1) contrast(1.4)";
    ctx.drawImage(video, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
    const { data } = await Tesseract.recognize(c, "eng");
    const text = (data.text || "").trim();
    status.textContent = text ? `Read: ${text.replace(/\s+/g, " ").slice(0, 140)}` : "No text found — try pausing on the slab.";
    if (text) await lookup(openCode, { ocr_text: text });
    openSheet(openCode);
    $("editBox").open = true;
    status.hidden = false;
    status.textContent = text ? `Read: ${text.replace(/\s+/g, " ").slice(0, 140)}` : status.textContent;
  } catch (e) {
    status.textContent = "OCR failed: " + e.message;
  }
}

// ---------------------------------------------------------------- startup

async function start() {
  $("startErr").hidden = true;
  try {
    if (await startNativeScanner()) {
      console.info("barcode engine: mlkit");
      $("start").hidden = true;
      $("controls").hidden = false;
      return;
    }
  } catch { return; }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
  } catch (e) {
    $("startErr").hidden = false;
    $("startErr").textContent = window.isSecureContext
      ? `Camera unavailable: ${e.message}`
      : "Camera needs HTTPS. Open this app through an https:// address (see README).";
    return;
  }
  video.srcObject = stream;
  await video.play();
  const track = stream.getVideoTracks()[0];
  try {
    const caps = track.getCapabilities?.() || {};
    if (caps.focusMode?.includes("continuous"))
      await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
    if (caps.torch) $("torchBtn").hidden = false;
  } catch { /* optional */ }

  detector = (await makeNativeDetector()) || (await makeZXingDetector());
  console.info("barcode engine:", detector.name);
  $("start").hidden = true;
  $("controls").hidden = false;
  scanLoop();
}

$("startBtn").onclick = start;
$("pauseBtn").onclick = () => {
  paused = !paused;
  if (!nativeCam) paused ? video.pause() : video.play();
  $("pauseBtn").classList.toggle("on", paused);
  $("pauseBtn").textContent = paused ? "▶" : "❚❚";
};
let torchOn = false;
$("torchBtn").onclick = async () => {
  torchOn = !torchOn;
  try {
    if (nativeCam) await window.Capacitor.nativePromise("SlabScanner", "setTorch", { on: torchOn });
    else await stream.getVideoTracks()[0].applyConstraints({ advanced: [{ torch: torchOn }] });
  } catch {}
  $("torchBtn").classList.toggle("on", torchOn);
};
$("caseBtn").onclick = () => { $("sheet").hidden = true; openCode = null; updateCase(); $("caseSheet").hidden = false; };
$("caseList").onclick = (e) => { const li = e.target.closest("li"); if (li) openSheet(li.dataset.code); };
document.querySelectorAll("[data-close]").forEach((b) => b.onclick = () => {
  $(b.dataset.close).hidden = true; if (b.dataset.close === "sheet") openCode = null;
});
$("editForm").onsubmit = (e) => {
  e.preventDefault();
  const f = e.target.elements;
  lookup(openCode, Object.fromEntries(["service", "cert", "pcgs_no", "grade", "description"]
    .map((k) => [k, f[k].value.trim() || null])));
};
$("ocrBtn").onclick = ocrLabel;
$("clearBtn").onclick = () => {
  coins.clear(); for (const t of tracks.values()) t.el?.remove(); tracks.clear();
  scene.forget(); rels.clear(); aliases.clear();
  try { localStorage.removeItem(SAVED_KEY); } catch { /* ignore */ }
  updateCase();
};
$("exportBtn").onclick = async () => {
  const rows = [["service", "cert", "pcgs_no", "grade", "description", "cac", "high_bid", "low_ask", "greysheet", "cpg_retail", "pcgs_guide"]];
  for (const c of [...coins.values()].filter((c) => !c.saved || (c.lastSeen && c.lastSeen >= startedAt))) {
    const k = c.result?.coin || {}, b = c.result?.bids || {}, g = c.result?.grading || {}, gs = c.result?.greysheet || {};
    rows.push([k.service, k.cert, k.pcgs_no, k.grade, k.description, g.cac, b.high_bid, b.low_ask, greyValue(gs), gs.cpg, g.price_guide]);
  }
  const csv = rows.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  try { await navigator.clipboard.writeText(csv); $("exportBtn").textContent = "Copied!"; }
  catch { $("exportBtn").textContent = "Copy failed"; }
  setTimeout(() => ($("exportBtn").textContent = "Copy as CSV"), 1500);
};

function checkServer() {
  $("mode").textContent = "…";
  backendStatus().then((st) => {
    const live = st.cce_mode === "live";
    $("mode").textContent = live ? "CCE live" : "Demo prices";
    $("mode").className = "pill " + st.cce_mode;
    $("startHint").hidden = !(NATIVE && !live);
  }).catch(() => { $("mode").textContent = "offline"; $("mode").className = "pill"; });
}

// ---------------------------------------------------------------- settings (app)

function openSettings() {
  const f = $("settingsForm").elements;
  for (const k of SETTING_KEYS) {
    f[k].value = store(k) || "";
    f[k].dataset.ph ??= f[k].placeholder || "";
    f[k].placeholder = BUILTIN[k] ? "built into this app" : f[k].dataset.ph;
  }
  if (!f.pcgsTokens.value && store("pcgsToken")) f.pcgsTokens.value = store("pcgsToken");   // older setting
  $("settingsStatus").textContent = "";
  $("sheet").hidden = true; $("caseSheet").hidden = true; openCode = null;
  $("settingsSheet").hidden = false;
}
function saveSettings() {
  const f = $("settingsForm").elements;
  for (const k of SETTING_KEYS) {
    let v = f[k].value.trim();
    if (k === "serverUrl" && v) {
      v = v.replace(/\/+$/, "");
      if (!/^https?:\/\//i.test(v)) v = "https://" + v;
      f[k].value = v;
    }
    if (k === "cceSearchUrl" && v.startsWith(CCE_HOST)) v = v.slice(CCE_HOST.length);
    if (k === "pcgsTokens") { v = v.split(/\s+/).filter(Boolean).join("\n"); f[k].value = v; }
    store(k, v);
  }
  // Prices may change with the new settings: look everything up again.
  for (const code of coins.keys()) lookup(code);
  checkServer();
}
const CCE_HOST = "https://www.certifiedcoinexchange.com";
$("settingsBtn").hidden = !NATIVE;
$("startSettings").hidden = !NATIVE;
$("settingsBtn").onclick = openSettings;
$("importKeys").onclick = () => $("keysFile").click();
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back */ }
  const ta = document.createElement("textarea");
  ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  ta.remove();
  return ok;
}
$("copyCcePage").onclick = async () => {
  const st = $("settingsStatus");
  const p = device.lastCcePage?.();
  if (!p) { st.textContent = "No CCE page fetched yet — scan a coin first."; return; }
  const text = `URL: ${p.url}\nWhen: ${p.when}\n\n${p.html}`;
  const ok = await copyText(text);
  st.textContent = ok ? `✓ Copied ${Math.round(text.length / 1024)} KB from ${p.url}. Paste it in a message or file to send.`
    : "✗ Could not copy to the clipboard.";
};
$("keysFile").onchange = async (e) => {
  const st = $("settingsStatus"), f = $("settingsForm").elements;
  try {
    const k = parseKeysFile(await e.target.files[0].text());
    let n = 0;
    if (k.pcgs) { f.pcgsTokens.value = k.pcgs.join("\n"); n += k.pcgs.length; }
    if (k.cacgKey) { f.cacgKey.value = k.cacgKey; n++; }
    if (k.cacgToken) { f.cacgToken.value = k.cacgToken; n++; }
    if (k.ngcToken) { f.ngcToken.value = k.ngcToken; n++; }
    if (k.gsKey) { f.gsKey.value = k.gsKey; n++; }
    if (k.gsToken) { f.gsToken.value = k.gsToken; n++; }
    if (!n) throw new Error("no keys found in that file");
    saveSettings();
    st.textContent = `✓ Imported ${n} key${n > 1 ? "s" : ""} and saved.`;
  } catch (err) { st.textContent = "✗ " + err.message; }
  e.target.value = "";
};
$("startSettings").onclick = openSettings;
$("settingsForm").onsubmit = (e) => {
  e.preventDefault(); saveSettings();
  $("settingsStatus").textContent = "Saved.";
};
$("testLogin").onclick = async () => {
  saveSettings();
  const st = $("settingsStatus");
  if (!onDevice()) { st.textContent = "Using a server: its own CCE login is used."; return; }
  st.textContent = "Signing in to CCE…";
  try { await device.testLogin(); st.textContent = "✓ Signed in to CCE."; }
  catch (e) { st.textContent = "✗ " + (e.message || e); }
};
const startedAt = Date.now();
loadCoins();
updateCase();
checkServer();

if (!NATIVE && "serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
requestAnimationFrame(frame);
window.__coincropper = { tracks, coins, lookup, handleFrame, aliases, scene, orient };  // handy for debugging
