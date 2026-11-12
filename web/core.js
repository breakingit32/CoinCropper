// On-device version of the server's coin logic (server/labels.py, server/cce.py)
// so the Android app can work with no server.  Keep the two in step.

export const SERVICES = ["PCGS", "NGC", "CACG", "ANACS", "ICG"];

const PREFIXES = ["MS", "PR", "PF", "SP", "AU", "XF", "EF", "VF", "VG", "AG", "FR", "PO", "F", "G"];
const DESIGS = ["ULTRA CAMEO", "CAMEO", "DMPL", "DCAM", "UCAM", "CAM", "DPL", "PL", "RD", "RB", "BN", "FBL", "FB", "FS", "FH", "FT"];
const DESIG_CANON = { "ULTRA CAMEO": "UCAM", CAMEO: "CAM" };   // NGC wording -> PCGS-style
const GRADE_RE = new RegExp(
  `(?<![A-Z])(${PREFIXES.join("|")})\\s?-?\\s?(\\d{1,2})(\\+)?(?:\\s?(${DESIGS.join("|")}))?(?![A-Z0-9])`);
// Mint mark after a dash (PCGS "1916-D") or a space (NGC "1916 D").
const YEAR_RE = /\b(1[6-9]\d{2}|20\d{2})(?:\/\d{1,2})?(?:[-\s]?(CC|[PDSOWC])\b)?/;
const NGC_CERT_RE = /^(\d{6,8})-(\d{3})$/;
const DIGITS_RE = /^\d{6,20}$/;
const CERT_IN_TEXT_RE = /\b(\d{7,8}(?:-\d{3})?)\b/;
const PCGS_NO_IN_TEXT_RE = /\b(?:PCGS\s*#?|#)\s*(\d{3,6})\b/i;
// The line under the grade on PCGS labels: "<PCGS#>.<grade>/<cert>", e.g. 7268.64/2401136
const PCGS_LINE_RE = /\b(\d{3,6})\s?\.\s?(\d{2})(\+)?\s?\/\s?(\d{7,9})\b/;
const NGC_CERT_IN_TEXT_RE = /\b(\d{6,8}-\d{3})\b/;

export function gradeFromNumber(num, proof = false) {
  if (num >= 60) return `${proof ? "PR" : "MS"}${num}`;
  for (const [low, p] of [[50, "AU"], [40, "XF"], [20, "VF"], [12, "F"], [8, "VG"], [4, "G"], [3, "AG"], [2, "FR"]])
    if (num >= low) return `${p}${num}`;
  return `PO${num}`;
}

// If an OCR line identifies a slab (PCGS#.grade/cert or an NGC cert), say so.
export function labelAnchor(line) {
  let m = PCGS_LINE_RE.exec(String(line || "").toUpperCase());
  if (m) return { service: "PCGS", pcgs_no: m[1], grade_num: +m[2], plus: !!m[3], cert: m[4] };
  m = NGC_CERT_IN_TEXT_RE.exec(String(line || ""));
  if (m) return { service: "NGC", cert: m[1] };
  return null;
}

export function emptyCoin(raw = "") {
  return { raw, service: null, cert: null, pcgs_no: null, grade: null, grade_num: null,
    year: null, mint_mark: null, description: null, notes: [] };
}

// Fill blanks in a from b (a wins on conflicts).
export function merge(a, b) {
  for (const [k, v] of Object.entries(b)) {
    if (k === "notes") { for (const n of v) if (!a.notes.includes(n)) a.notes.push(n); }
    else if ((a[k] == null || a[k] === "") && v != null && v !== "") a[k] = v;
  }
  return a;
}

export function normaliseGrade(text) {
  const m = GRADE_RE.exec(String(text || "").toUpperCase());
  if (!m) return [null, null];
  let prefix = m[1];
  if (prefix === "PF") prefix = "PR";
  if (prefix === "EF") prefix = "XF";
  const num = parseInt(m[2], 10);
  if (num < 1 || num > 70) return [null, null];
  let grade = `${prefix}${num}${m[3] || ""}`;
  if (m[4]) grade += " " + (DESIG_CANON[m[4]] || m[4]);
  return [grade, num];
}

export function parseBarcode(raw) {
  const value = String(raw || "").trim();
  const info = emptyCoin(value);
  if (!value) return info;

  if (/^(https?:\/\/|www\.)/i.test(value)) {
    let url;
    try { url = new URL(value.includes("://") ? value : "https://" + value); } catch { return info; }
    const host = url.host.toLowerCase();
    for (const [svc, needle] of [["PCGS", "pcgs"], ["NGC", "ngc"], ["CACG", "cacg"], ["ANACS", "anacs"], ["ICG", "icgcoin"]]) {
      if (host.includes(needle)) { info.service = svc; break; }
    }
    for (const p of url.pathname.split("/").filter(Boolean).map(decodeURIComponent)) {
      if (NGC_CERT_RE.test(p) || DIGITS_RE.test(p)) { info.cert = p; break; }
    }
    if (!info.cert) {
      const m = CERT_IN_TEXT_RE.exec(url.pathname + "?" + url.search);
      if (m) info.cert = m[1];
    }
    return info;
  }

  const compact = value.replace(/ /g, "");
  if (NGC_CERT_RE.test(compact)) { info.service = "NGC"; info.cert = compact; return info; }
  for (const svc of SERVICES) {
    if (compact.toUpperCase().startsWith(svc)) {
      info.service = svc;
      info.cert = compact.slice(svc.length).replace(/^[:#-]+/, "") || null;
      return info;
    }
  }
  if (DIGITS_RE.test(compact)) {
    info.cert = compact;
    if (compact.length === 7 || compact.length === 8) {
      info.service = "PCGS";
      info.notes.push("service guessed from barcode format");
    } else if (compact.length > 8) {
      info.service = "PCGS";
      info.cert = compact.slice(-8);
      info.notes.push("long PCGS barcode: using last 8 digits as cert");
    }
    return info;
  }
  info.notes.push("unrecognised barcode format");
  return info;
}

export function parseLabelText(text) {
  const info = emptyCoin();
  if (!text) return info;
  const upper = text.toUpperCase();
  for (const svc of SERVICES) if (new RegExp(`\\b${svc}\\b`).test(upper)) { info.service = svc; break; }
  [info.grade, info.grade_num] = normaliseGrade(upper);
  const line = PCGS_LINE_RE.exec(upper);
  if (line) {
    info.service = "PCGS"; info.pcgs_no = line[1]; info.cert = line[4];
    const num = +line[2];
    if (info.grade_num !== num) {
      info.grade = gradeFromNumber(num, /\b(PR|PF|PROOF)\b/.test(upper)) + (line[3] ? "+" : "");
      info.grade_num = num;
    }
  } else {
    let m = CERT_IN_TEXT_RE.exec(upper); if (m) info.cert = m[1];
    m = PCGS_NO_IN_TEXT_RE.exec(upper); if (m) info.pcgs_no = m[1];
  }
  for (const ln of upper.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const y = YEAR_RE.exec(ln);
    if (y) {
      info.year = y[1]; info.mint_mark = y[2] || null;
      info.description = ln.replace(/\s+/g, " ").replace(/^[ .,-]+|[ .,-]+$/g, "");
      break;
    }
  }
  return info;
}

export function fromPcgsJson(data, cert) {
  const info = emptyCoin();
  info.service = "PCGS"; info.cert = cert;
  const no = data.PCGSNo || data.PCGSNumber;
  if (no) info.pcgs_no = String(no);
  info.description = data.Name || null;
  if (data.Year) info.year = String(data.Year);
  info.mint_mark = data.MintMark || null;
  const gt = [data.Grade, data.Designation].filter(Boolean).join(" ");
  if (gt) {
    [info.grade, info.grade_num] = normaliseGrade(gt);
    if (!info.grade) info.notes.push(`PCGS grade '${gt}' not understood`);
  }
  return info;
}

export function verifyUrl(c) {
  if (!c.cert) return null;
  if (c.service === "PCGS") return `https://www.pcgs.com/cert/${c.cert}`;
  if (c.service === "NGC") return `https://www.ngccoin.com/certlookup/${c.cert}/`;
  return null;
}

// ------------------------------------------------------------- bid tables

const COLS = {
  bid: /\b(high\s*)?bid\b/i,
  ask: /\b(low\s*)?ask\b/i,
  grade: /\bgrade\b|\bgr\b/i,
  service: /\bservice\b|\bsvc\b|\bgrader\b|\bcert\.?\s*svc/i,
  dealer: /dealer|member|buyer|seller|firm|company/i,
  description: /desc|coin|item|title/i,
  cac: /\bcac\b/i,
  when: /time|date|posted|updated/i,
};

export function parseMoney(text) {
  const m = /\$?\s*([0-9][0-9,]*(?:\.\d{1,2})?)/.exec(text || "");
  if (!m) return null;
  const v = parseFloat(m[1].replace(/,/g, ""));
  return v > 0 ? v : null;
}

const cellsOf = (tr) => [...tr.querySelectorAll("th, td")]
  .filter((c) => c.closest("tr") === tr)
  .map((c) => c.textContent.replace(/\s+/g, " ").trim());

function mapHeader(header) {
  const cols = {};
  header.forEach((h, i) => {
    for (const [k, rx] of Object.entries(COLS)) {
      if (!(k in cols) && rx.test(h)) { cols[k] = i; break; }
    }
  });
  return cols;
}

export function parseQuotes(html, wantGrade = null) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const quotes = [];
  for (const table of doc.querySelectorAll("table")) {
    const rows = [...table.querySelectorAll("tr")];
    if (rows.length < 2) continue;
    let headerIdx = -1, cols = {};
    for (let i = 0; i < Math.min(5, rows.length); i++) {
      cols = mapHeader(cellsOf(rows[i]));
      if ("bid" in cols || "ask" in cols) { headerIdx = i; break; }
    }
    if (headerIdx < 0) continue;
    for (const tr of rows.slice(headerIdx + 1)) {
      const cells = cellsOf(tr);
      if (cells.length < 2) continue;
      const cell = (k) => (cols[k] != null && cells[cols[k]]) || null;
      const gradeTxt = cell("grade");
      if (wantGrade && gradeTxt) {
        const [, g] = normaliseGrade(/[A-Z]/i.test(gradeTxt) ? gradeTxt : `MS${gradeTxt}`);
        if (g && g !== wantGrade) continue;
      }
      const cacTxt = cell("cac");
      const common = {
        dealer: cell("dealer"), grade: gradeTxt, service: cell("service"),
        description: cell("description"), cac: !!(cacTxt && /y|yes|cac|✓|x/i.test(cacTxt)),
        when: cell("when"),
      };
      for (const side of ["bid", "ask"]) {
        const price = parseMoney(cell(side) || "");
        if (price) quotes.push({ side, price, ...common });
      }
    }
  }
  return quotes;
}

export function summarise(source, quotes, url = null, error = null) {
  const bids = quotes.filter((q) => q.side === "bid").map((q) => q.price);
  const asks = quotes.filter((q) => q.side === "ask").map((q) => q.price);
  return { source, url, quotes, error, fetched_at: Date.now() / 1000,
    high_bid: bids.length ? Math.max(...bids) : null,
    low_ask: asks.length ? Math.min(...asks) : null,
    bid_count: bids.length };
}

export function buildSearchUrl(template, base, c) {
  const enc = (v) => encodeURIComponent(v || "").replace(/%20/g, "+");
  const query = [c.description, c.grade].filter(Boolean).join(" ");
  let url = template
    .replaceAll("{pcgs_no}", enc(c.pcgs_no)).replaceAll("{grade}", enc(c.grade))
    .replaceAll("{grade_num}", c.grade_num ?? "").replaceAll("{service}", enc(c.service))
    .replaceAll("{cert}", enc(c.cert)).replaceAll("{barcode}", enc(c.raw || c.cert)).replaceAll("{query}", enc(query));
  if (url.startsWith("/")) url = base.replace(/\/+$/, "") + url;
  return url;
}

// Demo prices (not the same numbers as the server's mock, just plausible).
async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return new Uint8Array(buf);
}
const DEALERS = ["Dealer A", "Dealer B", "Dealer C", "Dealer D", "Dealer E", "Dealer F"];
export async function mockBids(c) {
  const h = await sha256(`${c.service}|${c.cert}|${c.pcgs_no}|${c.grade}`);
  const base = (50 + h[0] * 7) * 1.12 ** Math.max(0, (c.grade_num || 63) - 60);
  const quotes = [];
  for (let i = 0; i < 2 + (h[1] % 4); i++) quotes.push({ side: "bid",
    price: Math.round(base * (1 - 0.04 * i - h[2 + i] / 4000) * 100) / 100,
    dealer: DEALERS[h[6 + i] % 6], grade: c.grade, service: c.service, cac: h[10 + i] % 5 === 0 });
  for (let i = 0; i < 1 + (h[14] % 3); i++) quotes.push({ side: "ask",
    price: Math.round(base * (1.08 + 0.05 * i + h[15 + i] / 4000) * 100) / 100,
    dealer: DEALERS[h[18 + i] % 6], grade: c.grade, service: c.service, cac: false });
  return summarise("mock", quotes);
}

// ------------------------------------------------------------- CCE View Market grid
//
// CCE's market screen for one coin (PCGS#) is a grid: one column group per
// grade (60, 61, ...), each with  price | qty | service | dealer  cells, and rows
// labelled "bid" / "ask".  A price ending in "s" is sight-seen; dealer "typ"
// marks a bid for the type coin.  Tabs (Low 2-30, Middle 30-60, High 60-70,
// "+" markets...) switch the grade range.

const SVC_LETTERS = { P: "PCGS", N: "NGC", A: "ANACS", I: "ICG", C: "CACG" };

function expandRow(tr) {
  const out = [];
  for (const c of tr.querySelectorAll(":scope > th, :scope > td")) {
    const span = Math.max(1, parseInt(c.getAttribute("colspan") || "1", 10) || 1);
    const text = c.textContent.replace(/\s+/g, " ").trim();
    for (let i = 0; i < span; i++) out.push({ text, el: c, first: i === 0 });
  }
  return out;
}

export function parseMarketGrid(html) {
  const doc = typeof html === "string" ? new DOMParser().parseFromString(html, "text/html") : html;
  const grades = {};
  let title = null;
  for (const table of doc.querySelectorAll("table")) {
    const rows = [...table.querySelectorAll(":scope > tbody > tr, :scope > thead > tr, :scope > tr")];
    if (!rows.some((r) => /^(bid|ask)$/i.test(expandRow(r)[0]?.text || ""))) continue;
    // Header: the row before the first bid row whose cells are mostly grade numbers.
    const firstBid = rows.findIndex((r) => /^(bid|ask)$/i.test(expandRow(r)[0]?.text || ""));
    let colGrade = null;
    for (let i = firstBid - 1; i >= 0 && !colGrade; i--) {
      const cells = expandRow(rows[i]);
      const nums = cells.filter((c) => c.first && /^\d{1,2}\+?$/.test(c.text));
      if (nums.length >= 2) colGrade = cells.map((c) => (/^\d{1,2}\+?$/.test(c.text) ? c.text : null));
    }
    if (!colGrade) continue;
    for (const r of rows.slice(firstBid)) {
      const cells = expandRow(r);
      const label = (cells[0]?.text || "").toLowerCase();
      if (label !== "bid" && label !== "ask") continue;
      const byGrade = {};
      cells.forEach((c, i) => { const g = colGrade[i]; if (g && i > 0 && c.first) (byGrade[g] ||= []).push(c.text); });
      for (const [g, parts] of Object.entries(byGrade)) {
        const priceTxt = parts.find((p) => /^\$?[\d,]+(\.\d+)?s?$/i.test(p));
        if (!priceTxt) continue;
        const price = parseMoney(priceTxt);
        if (!price) continue;
        const rest = parts.slice(parts.indexOf(priceTxt) + 1);
        const qty = rest.find((p) => /^\d+$/.test(p));
        const svc = rest.find((p) => /^[A-Z]$/.test(p));
        const dealer = rest.find((p) => p !== qty && p !== svc && /^[A-Za-z0-9]{2,5}$/.test(p));
        (grades[g] ||= []).push({
          side: label, price, qty: qty ? +qty : null, service: svc ? SVC_LETTERS[svc] || svc : null,
          dealer: dealer || null, sight_seen: /s$/i.test(priceTxt), type_coin: /^typ$/i.test(dealer || ""),
          grade: g,
        });
      }
    }
  }
  // Coin title, e.g. "1PE 07356 1921 S$1 PEACE"
  const t = [...doc.querySelectorAll("td, th, div, span, h1, h2, h3")].map((e) => e.textContent.replace(/\s+/g, " ").trim())
    .find((s) => /^\S+\s+\d{4,6}\s+\d{4}.{2,60}$/.test(s) && s.length < 80);
  if (t) title = t;
  // Grade-range tabs
  const tabs = [...doc.querySelectorAll("a[href]")].map((a) => {
    const text = a.textContent.replace(/\s+/g, " ").trim();
    const m = /(\d{1,2})\+?\s*-\s*(\d{1,2})\+?/.exec(text);
    return m ? { text, href: a.getAttribute("href"), lo: +m[1], hi: +m[2], plus: /\+|plus/i.test(text) } : null;
  }).filter(Boolean);
  return { title, grades, tabs };
}

// Quotes for one coin from a parsed grid. Same-service quotes first.
export function quotesForGrade(grid, gradeNum, plus = false, service = null) {
  const key = `${gradeNum}${plus ? "+" : ""}`;
  const qs = (grid.grades[key] || []).slice();
  const rank = (q) => (service && q.service === service ? 0 : 1) + (q.type_coin ? 2 : 0);
  return qs.sort((a, b) => rank(a) - rank(b) || (a.side === "bid" ? b.price - a.price : a.price - b.price));
}

// Which tab shows this grade (prefers the narrowest range, "+" tabs for + grades).
export function tabForGrade(tabs, gradeNum, plus = false) {
  return tabs.filter((t) => t.plus === plus && gradeNum >= t.lo && gradeNum <= t.hi)
    .sort((a, b) => (a.hi - a.lo) - (b.hi - b.lo))[0] || null;
}
