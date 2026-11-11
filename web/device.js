// "No server" mode for the Android app: everything the server does, done on the
// phone.  CCE pages are fetched through Capacitor's native HTTP, which is not
// subject to browser CORS rules and shares the app's cookie store, so the CCE
// login session lives on the phone like it would in Chrome.

import { coinFromGrading, makeGrading } from "./grading.js";
import {
  buildSearchUrl, emptyCoin, merge, mockBids, normaliseGrade,
  parseBarcode, parseLabelText, parseQuotes, summarise, verifyUrl,
} from "./core.js";

export const CCE_BASE = "https://www.certifiedcoinexchange.com";
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

// Settings -> API keys. pcgsTokens holds one key per line.
export function gradingKeys(s) {
  const pcgs = String(s.pcgsTokens || "").split(/\s+/).concat(s.pcgsToken || "").map((x) => x.trim()).filter(Boolean);
  return { pcgs: [...new Set(pcgs)], cacgKey: s.cacgKey || "", cacgToken: s.cacgToken || "", ngcToken: s.ngcToken || "" };
}

export function makeDeviceBackend(getSettings) {
  let client = null, clientKey = "";
  const cache = new Map();
  const grading = makeGrading({ http, getKeys: () => gradingKeys(getSettings()) });

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
    // What the camera saw. The label's cert line beats a guessed barcode format.
    const fromBarcode = parseBarcode(req.code);
    const detected = req.ocr_text ? merge(parseLabelText(req.ocr_text), fromBarcode) : fromBarcode;
    detected.raw = fromBarcode.raw;
    // The grading service's own record wins over what the camera read;
    // your manual corrections win over everything.
    const lookupFor = { ...detected, service: manual.service || detected.service, cert: manual.cert || detected.cert };
    const { grading: g, notes } = await grading.identify(lookupFor);
    const coin = manual;
    if (g) {
      merge(coin, coinFromGrading(g));
      if (g.name) coin.notes.push(`identified by ${g.service} cert lookup`);
    }
    merge(coin, detected);
    coin.notes.push(...notes);
    return { coin, grading: g };
  }

  return {
    mode() { return cce() ? "live" : "mock"; },
    async status() { return { cce_mode: this.mode(), on_device: true }; },
    async testLogin() { const c = cce(); if (!c) throw new Error("Fill in all CCE settings first"); await c.login(); },
    async lookup(req) {
      const { coin, grading: g } = await identify(req);
      const c = cce();
      let bids;
      if (!c) bids = await mockBids(coin);
      else {
        const key = JSON.stringify([coin.raw, coin.service, coin.cert, coin.pcgs_no, coin.grade, coin.description]);
        const hit = cache.get(key);
        if (hit && Date.now() - hit.fetched_at * 1000 < CACHE_MS) bids = hit;
        else {
          try { bids = await c.bids(coin); cache.set(key, bids); }
          catch (e) { bids = summarise("cce", [], null, e.message || String(e)); }
        }
      }
      return { coin, bids, grading: g, verify_url: verifyUrl(coin), cce_url: bids.url || CCE_BASE };
    },
  };
}
