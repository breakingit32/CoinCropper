// "No server" mode for the Android app: everything the server does, done on the
// phone.  CCE pages are fetched through Capacitor's native HTTP, which is not
// subject to browser CORS rules and shares the app's cookie store, so the CCE
// login session lives on the phone like it would in Chrome.

import { coinFromGrading, makeGrading, makeGreysheet } from "./grading.js";
import { makeCatalog } from "./catalog.js";
import {
  buildSearchUrl, emptyCoin, merge, mockBids, normaliseGrade,
  parseBarcode, parseLabelText, parseMarketGrid, parseQuotes, quotesForGrade, summarise,
  tabForGrade, verifyUrl,
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

  // Fetch a member page, signing in (again) if CCE shows the login form.
  async get(url) {
    if (Date.now() - this.loggedInAt > RELOGIN_MS) await this.login();
    let r = await http({ url, method: "GET" });
    if (looksLoggedOut(String(r.data || ""))) { await this.login(); r = await http({ url, method: "GET" }); }
    if (r.status >= 400) throw new Error(`CCE returned HTTP ${r.status} for ${url}`);
    this.remember(r.url || url, r.data);
    return { url: r.url || url, html: String(r.data || "") };
  }

  remember(url, html) {
    this.lastPage = { url, html: String(html || "").slice(0, 500000), when: new Date().toISOString() };
  }

  abs(href, from) {
    try { return new URL(href, from || this.base + "/").toString(); } catch { return href; }
  }

  // Open CCE's market screen for a PCGS coin number through the "View coin#"
  // box that sits on every member page.
  async viewCoin(pcgsNo) {
    const coinNo = String(pcgsNo).padStart(5, "0");
    const home = await this.get(`${this.base}/`);
    const doc = new DOMParser().parseFromString(home.html, "text/html");
    const forms = [...doc.querySelectorAll("form")];
    const form = forms.find((f) => [...f.querySelectorAll("input")].some((i) => /coin/i.test(i.name || i.id || "")))
      || forms.find((f) => /coin\s*#/i.test(f.textContent || "") && f.querySelector("input[type=text], input:not([type])"));
    if (!form) throw new Error("CCE 'View coin#' box not found on the member home page");
    const input = [...form.querySelectorAll("input")].find((i) => /coin/i.test(i.name || i.id || ""))
      || form.querySelector("input[type=text], input:not([type])");
    const fields = {};
    for (const i of form.querySelectorAll("input")) {
      const t = (i.getAttribute("type") || "text").toLowerCase();
      if (i.name && (t === "hidden" || i === input)) fields[i.name] = i === input ? coinNo : i.getAttribute("value") || "";
    }
    const action = this.abs(form.getAttribute("action") || home.url, home.url);
    if ((form.getAttribute("method") || "get").toLowerCase() === "post") {
      if (Date.now() - this.loggedInAt > RELOGIN_MS) await this.login();
      const r = await http({ url: action, method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" }, data: fields });
      this.remember(r.url || action, r.data);
      if (r.status >= 400) throw new Error(`CCE returned HTTP ${r.status}`);
      return { url: r.url || action, html: String(r.data || "") };
    }
    const u = new URL(action);
    for (const [k, v] of Object.entries(fields)) u.searchParams.set(k, v);
    return this.get(u.toString());
  }

  async bids(coin) {
    const plus = /\+/.test(coin.grade || "");
    const svc = coin.service || null;
    // Market screen by PCGS number (PCGS lookup supplies it); otherwise the
    // bid page address from Settings, if any.
    if (coin.pcgs_no && coin.grade_num) {
      let page = await this.viewCoin(coin.pcgs_no);
      let grid = parseMarketGrid(page.html);
      let quotes = quotesForGrade(grid, coin.grade_num, plus, svc);
      if (!quotes.length) {
        const tab = tabForGrade(grid.tabs, coin.grade_num, plus);
        if (tab) {
          page = await this.get(this.abs(tab.href, page.url));
          grid = parseMarketGrid(page.html);
          quotes = quotesForGrade(grid, coin.grade_num, plus, svc);
        }
      }
      if (!Object.keys(grid.grades).length && !quotes.length) {
        // Not a market grid: fall back to any bid/ask table on the page.
        quotes = parseQuotes(page.html, coin.grade_num);
      }
      const res = summarise("cce", quotes, page.url);
      res.market_title = grid.title;
      res.for_service = svc;
      if (!quotes.length) res.note = `No ${svc || ""} bids for ${coin.grade || coin.grade_num} on CCE`;
      return withServiceHigh(res, svc);
    }
    if (!this.searchUrl) {
      const res = summarise("cce", []);
      res.note = "CCE: no PCGS # for this coin yet, so it can't be opened on CCE";
      return res;
    }
    const page = await this.get(buildSearchUrl(this.searchUrl, this.base, coin));
    const grid = parseMarketGrid(page.html);
    const quotes = Object.keys(grid.grades).length && coin.grade_num
      ? quotesForGrade(grid, coin.grade_num, plus, svc) : parseQuotes(page.html, coin.grade_num);
    return withServiceHigh(summarise("cce", quotes, page.url), svc);
  }
}

// Settings -> API keys. pcgsTokens holds one key per line.
export function gradingKeys(s) {
  const pcgs = String(s.pcgsTokens || "").split(/\s+/).concat(s.pcgsToken || "").map((x) => x.trim()).filter(Boolean);
  return { pcgs: [...new Set(pcgs)], cacgKey: s.cacgKey || "", cacgToken: s.cacgToken || "", ngcToken: s.ngcToken || "",
    gsKey: s.gsKey || "", gsToken: s.gsToken || "" };
}

// High bid for the coin's own grading service (and not a type-coin bid) when there is one.
function withServiceHigh(res, svc) {
  const own = res.quotes.filter((q) => q.side === "bid" && !q.type_coin && (!svc || !q.service || q.service === svc));
  if (own.length) res.high_bid = Math.max(...own.map((q) => q.price));
  const asks = res.quotes.filter((q) => q.side === "ask" && (!svc || !q.service || q.service === svc));
  if (asks.length) res.low_ask = Math.min(...asks.map((q) => q.price));
  return res;
}

export function makeDeviceBackend(getSettings) {
  let client = null, clientKey = "";
  const cache = new Map();
  const grading = makeGrading({ http, getKeys: () => gradingKeys(getSettings()) });
  const greysheet = makeGreysheet({ http, getKeys: () => gradingKeys(getSettings()) });
  const catalog = makeCatalog({ http, getKeys: () => gradingKeys(getSettings()) });

  function cce() {
    const s = getSettings();
    if (!(s.cceUser && s.ccePass)) return null;
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
    // No PCGS number (NGC and other slabs): find it in the Greysheet catalog
    // from the label (year, mint, denomination, variety, strike, designation).
    let match = null;
    if (!coin.pcgs_no && coin.year && catalog.configured()) {
      try {
        match = await catalog.lookup({ year: coin.year, mint_mark: coin.mint_mark, description: detected.description || coin.description, grade: coin.grade });
        if (match?.pcgs_no) {
          coin.pcgs_no = match.pcgs_no;
          coin.notes.push(`PCGS #${match.pcgs_no} from the Greysheet catalog (${match.name})`);
        } else if (match) coin.notes.push(`Greysheet catalog: ${match.name} (no PCGS #)`);
        else coin.notes.push("Not found in the Greysheet catalog");
      } catch (e) { coin.notes.push(e.message); }
    }
    return { coin, grading: g, match };
  }

  return {
    mode() { return cce() ? "live" : "mock"; },
    async status() { return { cce_mode: this.mode(), on_device: true }; },
    async testLogin() { const c = cce(); if (!c) throw new Error("Fill in your CCE user id and password first"); await c.login(); },
    lastCcePage() { return client?.lastPage || null; },
    async lookup(req) {
      const { coin, grading: g, match } = await identify(req);
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
      let grey = null, greyStatus;
      if (!greysheet.configured()) greyStatus = "Add your Greysheet API key and token in Settings (⚙ → Grading APIs).";
      else if (!(coin.pcgs_no || match?.gsid) || !coin.grade_num) greyStatus = `Needs the coin's ${!coin.grade_num ? "grade" : "PCGS # (not found in the catalog from its label)"} to look it up.`;
      else {
        try {
          grey = await greysheet.price({ pcgs_no: coin.pcgs_no, gsid: coin.pcgs_no ? null : match?.gsid, grade_num: coin.grade_num, cac: g?.cac });
          greyStatus = !grey ? `Greysheet has no listing for PCGS #${coin.pcgs_no}.` : grey.none ? `Greysheet has no price for grade ${coin.grade_num}.` : "ok";
        } catch (e) { greyStatus = e.message; }
      }
      return { coin, bids, grading: g, greysheet: grey, greysheet_status: greyStatus, verify_url: verifyUrl(coin), cce_url: bids.url || CCE_BASE };
    },
  };
}
