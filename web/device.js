// "No server" mode for the Android app: everything the server does, done on the
// phone.  CCE pages are fetched through Capacitor's native HTTP, which is not
// subject to browser CORS rules and shares the app's cookie store, so the CCE
// login session lives on the phone like it would in Chrome.

import {
  buildSearchUrl, emptyCoin, fromPcgsJson, merge, mockBids, normaliseGrade,
  parseBarcode, parseLabelText, parseQuotes, summarise, verifyUrl,
} from "./core.js";

export const CCE_BASE = "https://www.certifiedcoinexchange.com";
const PCGS_API = "https://api.pcgs.com/publicapi/coindetail/GetCoinFactsByCertNo/";
const RELOGIN_MS = 30 * 60 * 1000;
const CACHE_MS = 10 * 60 * 1000;

let httpImpl = (opts) => {
  const cap = window.Capacitor;
  if (cap?.nativePromise) return cap.nativePromise("CapacitorHttp", "request", opts);
  if (cap?.Plugins?.CapacitorHttp) return cap.Plugins.CapacitorHttp.request(opts);
  throw new Error("native HTTP not available (only works inside the Android app)");
};
export function setHttp(fn) { httpImpl = fn; }   // for tests
const http = (opts) => httpImpl({ connectTimeout: 20000, readTimeout: 20000, responseType: "text", ...opts });

const looksLoggedOut = (html) => /name="password"/i.test(html) && /name="userId"/i.test(html);

export class CCEDirect {
  constructor({ userId, password, searchUrl, base = CCE_BASE }) {
    Object.assign(this, { userId, password, searchUrl, base });
    this.loggedInAt = 0;
  }

  async login() {
    if (!this.userId || !this.password) throw new Error("Enter your CCE user id and password in Settings");
    const page = await http({ url: `${this.base}/Account/Login`, method: "GET" });
    const doc = new DOMParser().parseFromString(String(page.data || ""), "text/html");
    const form = [...doc.querySelectorAll("form")].find((f) => /login/i.test(f.getAttribute("action") || ""));
    if (!form) throw new Error("CCE login form not found (site changed?)");
    const fields = {};
    for (const i of form.querySelectorAll("input")) {
      const t = (i.getAttribute("type") || "").toLowerCase();
      if (i.name && (t === "hidden" || t === "")) fields[i.name] = i.getAttribute("value") || "";
    }
    Object.assign(fields, { userId: this.userId, password: this.password, submit: "Login to CCE" });
    const r = await http({
      url: `${this.base}/Account/Login`, method: "POST",
      headers: { "Content-Type": "multipart/form-data" }, dataType: "formData",
      data: Object.entries(fields).map(([key, value]) => ({ key, value, type: "string" })),
    });
    if (r.status >= 400) throw new Error(`CCE login failed (HTTP ${r.status})`);
    if (looksLoggedOut(String(r.data || ""))) throw new Error("CCE login failed: check user id / password");
    this.loggedInAt = Date.now();
  }

  async bids(coin) {
    if (!this.searchUrl) throw new Error("Set the CCE bid page address in Settings");
    const url = buildSearchUrl(this.searchUrl, this.base, coin);
    if (Date.now() - this.loggedInAt > RELOGIN_MS) await this.login();
    let r = await http({ url, method: "GET" });
    if (looksLoggedOut(String(r.data || ""))) { await this.login(); r = await http({ url, method: "GET" }); }
    if (r.status >= 400) throw new Error(`CCE returned HTTP ${r.status}`);
    return summarise("cce", parseQuotes(String(r.data || ""), coin.grade_num), url);
  }
}

async function pcgsLookup(token, cert) {
  const r = await http({
    url: PCGS_API + encodeURIComponent(cert), method: "GET", responseType: "json",
    headers: { Authorization: `bearer ${token}`, Accept: "application/json" },
  });
  if (r.status !== 200) return null;
  const data = typeof r.data === "string" ? JSON.parse(r.data || "null") : r.data;
  if (!data || data.IsValidRequest === false) return null;
  return fromPcgsJson(data, cert);
}

export function makeDeviceBackend(getSettings) {
  let client = null, clientKey = "";
  const cache = new Map();

  function cce() {
    const s = getSettings();
    if (!(s.cceUser && s.ccePass && s.cceSearchUrl)) return null;
    const key = [s.cceUser, s.ccePass, s.cceSearchUrl].join("\u0000");
    if (!client || key !== clientKey) {
      client = new CCEDirect({ userId: s.cceUser, password: s.ccePass, searchUrl: s.cceSearchUrl });
      clientKey = key; cache.clear();
    }
    return client;
  }

  async function identify(req) {
    const manual = emptyCoin();
    Object.assign(manual, {
      service: req.service || null, cert: req.cert || null,
      pcgs_no: req.pcgs_no || null, description: req.description || null,
    });
    if (req.grade) {
      [manual.grade, manual.grade_num] = normaliseGrade(req.grade);
      if (!manual.grade) manual.notes.push(`grade '${req.grade}' not understood`);
    }
    const coin = merge(manual, parseBarcode(req.code));
    if (req.ocr_text) merge(coin, parseLabelText(req.ocr_text));
    const token = getSettings().pcgsToken;
    if (coin.service === "PCGS" && coin.cert && token) {
      try {
        const found = await pcgsLookup(token, coin.cert);
        if (found) { merge(coin, found); coin.notes.push("identified via PCGS cert lookup"); }
      } catch (e) { coin.notes.push(`PCGS lookup failed: ${e.message}`); }
    }
    return coin;
  }

  return {
    mode() { return cce() ? "live" : "mock"; },
    async status() { return { cce_mode: this.mode(), on_device: true }; },
    async testLogin() { const c = cce(); if (!c) throw new Error("Fill in all CCE settings first"); await c.login(); },
    async lookup(req) {
      const coin = await identify(req);
      const c = cce();
      let bids;
      if (!c) bids = await mockBids(coin);
      else {
        const key = JSON.stringify([coin.service, coin.cert, coin.pcgs_no, coin.grade, coin.description]);
        const hit = cache.get(key);
        if (hit && Date.now() - hit.fetched_at * 1000 < CACHE_MS) bids = hit;
        else {
          try { bids = await c.bids(coin); cache.set(key, bids); }
          catch (e) { bids = summarise("cce", [], null, e.message || String(e)); }
        }
      }
      return { coin, bids, verify_url: verifyUrl(coin), cce_url: bids.url || CCE_BASE };
    },
  };
}
