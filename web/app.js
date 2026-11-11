// CoinCropper — point the phone at slabbed coins, get CCE bids floating over each one.

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

async function lookup(code, extra = {}) {
  const coin = coins.get(code) || { code, overrides: {} };
  coins.set(code, coin);
  Object.assign(coin.overrides, extra);
  coin.status = "loading";
  coin.error = null;
  renderTags(); if (openCode === code) renderSheet();
  try {
    const r = await fetch("api/lookup", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, ...coin.overrides }),
    });
    if (!r.ok) throw new Error(`server ${r.status}`);
    coin.result = await r.json();
    coin.status = coin.result.bids.error ? "error" : "ok";
    coin.error = coin.result.bids.error;
  } catch (e) {
    coin.status = "error"; coin.error = e.message;
  }
  updateCase();
  if (openCode === code) renderSheet();
}

function coinTitle(coin) {
  const c = coin.result?.coin;
  if (!c) return coin.code;
  const head = [c.service, c.grade].filter(Boolean).join(" ");
  return [head, c.description || (c.cert && `#${c.cert}`)].filter(Boolean).join(" · ");
}

// ---------------------------------------------------------------- scanning

async function scanLoop() {
  while (stream) {
    const t0 = performance.now();
    if (!paused && video.readyState >= 2) {
      try {
        const found = await detector.detect(video);
        const now = performance.now();
        for (const f of found) {
          const code = f.rawValue?.trim();
          if (!code) continue;
          let t = tracks.get(code);
          if (!t) {
            t = { box: f.box, lastSeen: now, el: null };
            tracks.set(code, t);
            if (!coins.has(code)) lookup(code);
          } else {   // smooth jitter
            const a = 0.55;
            for (const k of ["x", "y", "w", "h"]) t.box[k] += (f.box[k] - t.box[k]) * a;
          }
          t.raw = { ...f.box };
          t.lastSeen = now;
        }
      } catch (e) { console.warn(e); }
    }
    await new Promise((r) => setTimeout(r, Math.max(0, SCAN_INTERVAL_MS - (performance.now() - t0))));
  }
}

function renderTags() {
  const now = performance.now();
  for (const [code, t] of tracks) {
    const age = now - t.lastSeen;
    if (!paused && age > TRACK_TTL_MS) { t.el?.remove(); tracks.delete(code); continue; }
    if (!t.el) {
      t.el = document.createElement("div");
      t.el.className = "tag";
      t.el.innerHTML = `<div class="box"></div><div class="card"><div class="t1"></div><div class="t2"></div></div>`;
      t.el.addEventListener("click", () => openSheet(code));
      overlay.appendChild(t.el);
    }
    const coin = coins.get(code) || {};
    const s = toScreen(t.box);
    const box = t.el.firstChild, card = t.el.lastChild;
    Object.assign(box.style, { left: s.x + "px", top: s.y + "px", width: s.w + "px", height: s.h + "px" });
    // Float the card above the barcode; flip below it near the top edge and keep
    // it inside the screen horizontally.
    const cw = card.offsetWidth || 140, chh = card.offsetHeight || 50;
    const below = s.y - 10 - chh < 56;
    const cx = Math.min(Math.max(s.x + s.w / 2, cw / 2 + 6), overlay.clientWidth - cw / 2 - 6);
    card.classList.toggle("below", below);
    Object.assign(card.style, { left: cx + "px", top: (below ? s.y + s.h + 10 : s.y - 10) + "px" });
    t.el.classList.toggle("stale", !paused && age > 400);
    t.el.classList.toggle("loading", coin.status === "loading");
    t.el.classList.toggle("error", coin.status === "error");
    const t1 = card.firstChild, t2 = card.lastChild;
    const high = coin.result?.bids?.high_bid;
    t1.textContent = coinTitle(coin);
    t2.classList.toggle("none", coin.status === "ok" && high == null);
    t2.textContent = coin.status === "loading" ? "Looking up…" :
      coin.status === "error" ? "Lookup failed" :
      high != null ? `Bid ${money(high)}` : "No bids";
  }
}

function frame() { renderTags(); requestAnimationFrame(frame); }

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
  $("dQuotes").innerHTML = quotes.map((q) => `<tr>
      <td class="${q.side}">${q.side === "bid" ? "Bid" : "Ask"}</td>
      <td class="${q.side}">${esc(money(q.price))}${q.cac ? " <small>CAC</small>" : ""}</td>
      <td>${esc(q.dealer || "")}</td><td>${esc([q.service, q.grade].filter(Boolean).join(" "))}</td></tr>`).join("")
    || `<tr><td colspan="4" class="muted">No quotes found.</td></tr>`;
  $("cceLink").href = res.cce_url || "https://www.certifiedcoinexchange.com";
  $("verifyLink").hidden = !res.verify_url;
  if (res.verify_url) $("verifyLink").href = res.verify_url;
  const notes = [...(c.notes || [])];
  if (b.source === "mock") notes.unshift("Demo prices — connect your CCE account on the server for live bids.");
  $("dNotes").textContent = notes.join(" · ");
}

function updateCase() {
  const list = [...coins.values()];
  const total = list.reduce((s, c) => s + (c.result?.bids?.high_bid || 0), 0);
  $("caseCount").textContent = list.length;
  $("caseTotal").textContent = money(total);
  $("caseSub").textContent = `${list.length} coins · total high bid ${money(total)}`;
  $("caseList").innerHTML = list.map((c) => `<li data-code="${esc(c.code)}">
      <span>${esc(coinTitle(c))}</span><span class="p">${esc(money(c.result?.bids?.high_bid))}</span></li>`).join("");
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
  paused ? video.pause() : video.play();
  $("pauseBtn").classList.toggle("on", paused);
  $("pauseBtn").textContent = paused ? "▶" : "❚❚";
};
let torchOn = false;
$("torchBtn").onclick = async () => {
  torchOn = !torchOn;
  try { await stream.getVideoTracks()[0].applyConstraints({ advanced: [{ torch: torchOn }] }); } catch {}
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
  updateCase();
};
$("exportBtn").onclick = async () => {
  const rows = [["service", "cert", "pcgs_no", "grade", "description", "high_bid", "low_ask"]];
  for (const c of coins.values()) {
    const k = c.result?.coin || {}, b = c.result?.bids || {};
    rows.push([k.service, k.cert, k.pcgs_no, k.grade, k.description, b.high_bid, b.low_ask]);
  }
  const csv = rows.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  try { await navigator.clipboard.writeText(csv); $("exportBtn").textContent = "Copied!"; }
  catch { $("exportBtn").textContent = "Copy failed"; }
  setTimeout(() => ($("exportBtn").textContent = "Copy as CSV"), 1500);
};

fetch("api/status").then((r) => r.json()).then((s) => {
  $("mode").textContent = s.cce_mode === "live" ? "CCE live" : "Demo prices";
  $("mode").className = "pill " + s.cce_mode;
}).catch(() => ($("mode").textContent = "offline"));

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
requestAnimationFrame(frame);
window.__coincropper = { tracks, coins, lookup };  // handy for debugging
