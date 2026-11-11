// Grading-service APIs: identify a slab from its cert number / barcode.
//
//   PCGS  api.pcgs.com/publicapi       coin, grade, PCGS#, price guide, pop, auctions
//   CAC   api.cacgrading.com           CAC sticker (Green/Gold) on PCGS/NGC coins,
//                                      and CACG's own certs
//
// Results are cached on the phone (certs don't change; prices are refreshed
// weekly) so a case of coins costs each API call once.  Several PCGS keys can
// be given; when one is refused or hits its daily limit the next is used.

import { emptyCoin, normaliseGrade } from "./core.js";

const PCGS = "https://api.pcgs.com/publicapi/coindetail";
const CAC = "https://api.cacgrading.com";
const CACHE_DAYS = 7;

const today = () => new Date().toISOString().slice(0, 10);

function memo(storage) {
  const get = (k) => { try { return JSON.parse(storage?.getItem(k) || "null"); } catch { return null; } };
  const set = (k, v) => { try { storage?.setItem(k, JSON.stringify(v)); } catch { /* full or blocked */ } };
  return {
    get(k) {
      const e = get("g:" + k);
      return e && Date.now() - e.t < CACHE_DAYS * 864e5 ? e.v : undefined;
    },
    set(k, v) { set("g:" + k, { t: Date.now(), v }); },
    spent: () => get("pcgsSpent") || {},
    setSpent: (v) => set("pcgsSpent", v),
  };
}

// PCGS JSON -> what the app uses.
export function slimPcgs(d) {
  const img = (d.Images || [])[0];
  return {
    service: "PCGS",
    pcgs_no: d.PCGSNo ? String(d.PCGSNo) : null,
    cert: d.CertNo ? String(d.CertNo) : null,
    name: d.Name || null,
    year: d.Year ? String(d.Year) : null,
    denomination: d.Denomination || null,
    mint_mark: d.MintMark || null,
    grade: [d.Grade, d.Designation].filter(Boolean).join(" ") || null,
    variety: [d.MajorVariety, d.MinorVariety, d.DieVariety].filter(Boolean).join(", ") || null,
    price_guide: d.PriceGuideValue || null,
    population: d.Population ?? null,
    pop_higher: d.PopHigher ?? null,
    coinfacts_url: d.CoinFactsLink ? "https://" + String(d.CoinFactsLink).replace(/^https?:\/\//, "") : null,
    image: img?.Thumbnail || img?.Fullsize || null,
    auctions: (d.AuctionList || []).slice(0, 10).map((a) => ({
      date: a.Date, auctioneer: a.Auctioneer, sale: a.SaleName, price: a.Price,
      cac: !!a.IsCAC, url: a.AuctionLotUrl || null,
    })),
  };
}

// Grading info -> coin fields (for merge()).
export function coinFromGrading(g) {
  const c = emptyCoin();
  c.service = g.service; c.cert = g.cert; c.pcgs_no = g.pcgs_no;
  c.description = g.name || null; c.year = g.year; c.mint_mark = g.mint_mark;
  if (g.grade) [c.grade, c.grade_num] = normaliseGrade(g.grade);
  return c;
}

// Cert numbers to try: PCGS stores old 7-digit certs with a leading zero.
export function certVariants(cert) {
  const c = String(cert || "").replace(/\D/g, "");
  if (!c) return [];
  const out = [c];
  if (c.length < 8) out.push(c.padStart(8, "0"));
  if (c.length === 8 && c.startsWith("0")) out.push(c.replace(/^0+/, ""));
  return out;
}

export function makeGrading({ http, getKeys, storage = globalThis.localStorage }) {
  const cache = memo(storage);

  async function pcgsCall(path) {
    const keys = getKeys().pcgs || [];
    if (!keys.length) return { skipped: true };
    let spent = cache.spent();
    for (let i = 0; i < keys.length; i++) {
      const id = keys[i].slice(-12);
      if (spent[id] === today()) continue;
      const r = await http({
        url: `${PCGS}/${path}`, method: "GET", responseType: "json",
        headers: { Authorization: `bearer ${keys[i]}`, Accept: "application/json" },
      });
      const data = typeof r.data === "string" ? JSON.parse(r.data || "null") : r.data;
      const msg = `${data?.Message || ""} ${data?.ServerMessage || ""}`;
      if (r.status === 401 || r.status === 403 || r.status === 429 || /limit|quota|exceed|denied/i.test(msg)) {
        spent = { ...cache.spent(), [id]: today() };
        cache.setSpent(spent);
        continue;
      }
      if (r.status !== 200) return { error: `PCGS HTTP ${r.status}` };
      if (!data || data.IsValidRequest === false || !data.PCGSNo) return { notFound: true };
      return { data };
    }
    return { error: "all PCGS API keys are used up for today" };
  }

  async function pcgs({ cert, barcode }) {
    const tries = [];
    if (barcode && !/^https?:/i.test(barcode)) tries.push(["b:" + barcode, `GetCoinFactsByBarcode?barcode=${encodeURIComponent(barcode)}&gradingService=PCGS`]);
    for (const c of certVariants(cert)) tries.push(["c:" + c, `GetCoinFactsByCertNo/${encodeURIComponent(c)}`]);
    let lastErr = null;
    for (const [key, path] of tries) {
      const hit = cache.get("pcgs:" + key);
      if (hit) return hit;
      if (hit === null) continue;             // known miss
      const r = await pcgsCall(path);
      if (r.skipped) return null;
      if (r.error) { lastErr = r.error; break; }
      if (r.notFound) { cache.set("pcgs:" + key, null); continue; }
      const g = slimPcgs(r.data);
      cache.set("pcgs:" + key, g);
      if (g.cert) cache.set("pcgs:c:" + g.cert, g);
      return g;
    }
    if (lastErr) throw new Error(lastErr);
    return null;
  }

  async function cacCall(path) {
    const { cacgKey, cacgToken } = getKeys();
    if (!cacgKey || !cacgToken) return null;
    const r = await http({
      url: `${CAC}${path}`, method: "GET", responseType: "json",
      headers: { "X-API-KEY": cacgKey, "X-API-TOKEN": cacgToken, Accept: "application/json" },
    });
    const data = typeof r.data === "string" ? JSON.parse(r.data || "null") : r.data;
    if (r.status === 404) return { data: null };
    if (r.status !== 200) throw new Error(`CAC HTTP ${r.status}${data?.error ? ": " + data.error : ""}`);
    return data;
  }

  // "Green" | "Gold" | null
  async function cacSticker(service, cert) {
    if (!cert || !["PCGS", "NGC"].includes(service)) return null;
    const key = `cac:${service}:${cert}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const variants = service === "PCGS" ? certVariants(cert) : [cert];
    let status = null;
    for (const c of variants) {
      const r = await cacCall(`/stickered_certs?certId=${encodeURIComponent(c)}&gradingService=${service}`);
      if (!r) return null;                    // no CAC keys
      if (r.data?.length) { status = r.data[0].status || "Green"; break; }
    }
    cache.set(key, status);
    return status;
  }

  async function cacgCert(cert) {
    const key = `cacg:${cert}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const r = await cacCall(`/certs/${encodeURIComponent(cert)}`);
    if (!r) return null;
    const d = r.data;
    const e = d?.entryData || {};
    const g = d ? {
      service: "CACG", cert: String(d.certId), pcgs_no: e.pcgsNumber ? String(e.pcgsNumber) : null,
      name: e.description || e.name || e.title || null, year: e.year ? String(e.year) : null,
      denomination: e.denomination || null, mint_mark: e.mintMark || null,
      grade: d.grade && d.grade !== "0" ? (/^\d/.test(d.grade) ? `MS${d.grade}` : d.grade) : null,
      image: d.images?.[0]?.url || null, auctions: [],
    } : null;
    cache.set(key, g);
    return g;
  }

  return {
    configured() { const k = getKeys(); return !!(k.pcgs?.length || (k.cacgKey && k.cacgToken)); },
    // Look a slab up with whatever services apply. Returns grading info or null.
    async identify(coin) {
      const notes = [];
      let g = null;
      try {
        if (coin.service === "PCGS" || (!coin.service && coin.cert)) g = await pcgs({ cert: coin.cert, barcode: coin.raw });
        else if (coin.service === "CACG") g = await cacgCert(coin.cert);
      } catch (e) { notes.push(`${coin.service || "PCGS"} lookup failed: ${e.message}`); }
      const service = g?.service || coin.service;
      const cert = g?.cert || coin.cert;
      try {
        const cac = await cacSticker(service, cert);
        if (cac) (g = g || { service, cert, auctions: [] }).cac = cac;
      } catch (e) { notes.push(`CAC lookup failed: ${e.message}`); }
      return { grading: g, notes };
    },
  };
}

// Keys file: JSON {pcgs:[..], cacg_key, cacg_token, ngc_token} or plain text with
// labelled sections.  Returns {pcgs, cacgKey, cacgToken, ngcToken} (missing = undefined).
export function parseKeysFile(text) {
  const t = String(text || "").trim();
  try {
    const j = JSON.parse(t);
    const pcgs = [].concat(j.pcgs || j.pcgs_tokens || j.PCGS || []).map(String).map((s) => s.trim()).filter(Boolean);
    return { pcgs: pcgs.length ? pcgs : undefined, cacgKey: j.cacg_key || j.cacgKey,
      cacgToken: j.cacg_token || j.cacgToken || j.cac_token, ngcToken: j.ngc_token || j.ngcToken };
  } catch { /* plain text: one PCGS key per line */ }
  const pcgs = t.split(/\s+/).filter((s) => s.length > 60);
  return { pcgs: pcgs.length ? pcgs : undefined };
}
