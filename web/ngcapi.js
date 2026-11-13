// NGC dealer API (Certified Collectibles Group): cert -> NGC coin ID (and PCGS #
// when the answer has one).
//
// Token: the dealer API uses Auth0 at login.collectiblesgroup.com. With the
// NGC dealer email + password in Settings the app logs in itself and renews
// the token; otherwise a pasted token is used until it expires (30 days).
// Cert lookup address: from NGC's API documentation, with {cert} and {grade}.

const AUTH = "https://login.collectiblesgroup.com/oauth/token";
const AUDIENCE = "https://dealer-api.collectiblesgroup.com";
const CLIENT_ID = "riTrPXPdfY6hxkd5vXqs3KZsEqV6h60J";   // public client id of NGC's dealer app (from its tokens)

export function jwtExp(token) {
  try {
    const p = JSON.parse(atob(String(token).split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return { exp: p.exp ? p.exp * 1000 : 0, azp: p.azp || null };
  } catch { return { exp: 0, azp: null }; }
}

// Find the coin ID / PCGS # anywhere in an API answer.
export function idsFromAnswer(data) {
  let ngc = null, pcgs = null, desc = null;
  const walk = (o, depth = 0) => {
    if (!o || typeof o !== "object" || depth > 6) return;
    for (const [k, v] of Object.entries(o)) {
      const key = k.toLowerCase().replace(/[^a-z]/g, "");
      if (v && typeof v === "object") { walk(v, depth + 1); continue; }
      if (!ngc && /^(ngc)?coinid$|^ngccoinnumber$|^coinnumber$/.test(key) && /^\d{4,7}$/.test(String(v))) ngc = String(v);
      if (!pcgs && /^pcgs(coin)?(id|no|number|num)$/.test(key) && /^\d{1,7}$/.test(String(v))) pcgs = String(v);
      if (!desc && /^(description|coindescription|name|title)$/.test(key) && typeof v === "string") desc = v;
    }
  };
  walk(data);
  return ngc || pcgs ? { ngc_id: ngc, pcgs_no: pcgs, description: desc } : null;
}

export function makeNgcApi({ http, getSettings, storage = globalThis.localStorage }) {
  let mem = null;   // {token, exp}
  const load = () => { try { return JSON.parse(storage?.getItem("ngcApiToken") || "null"); } catch { return null; } };
  const save = (v) => { try { storage?.setItem("ngcApiToken", JSON.stringify(v)); } catch { /* ignore */ } };

  async function token() {
    const s = getSettings();
    const now = Date.now();
    mem = mem || load();
    if (mem?.token && mem.exp - now > 5 * 60e3 && mem.user === (s.ngcUser || "")) return mem.token;
    if (s.ngcUser && s.ngcPass) {
      const clientId = jwtExp(s.ngcToken).azp || CLIENT_ID;
      const r = await http({ url: AUTH, method: "POST", headers: { "Content-Type": "application/json" }, responseType: "json",
        data: { grant_type: "password", username: s.ngcUser, password: s.ngcPass, audience: AUDIENCE, client_id: clientId, scope: "openid profile email" } });
      const d = typeof r.data === "string" ? JSON.parse(r.data || "null") : r.data;
      if (r.status !== 200 || !d?.access_token) throw new Error(`NGC login refused: ${d?.error_description || d?.error || "HTTP " + r.status}`);
      mem = { token: d.access_token, exp: now + (d.expires_in || 3600) * 1000, user: s.ngcUser };
      save(mem);
      return mem.token;
    }
    if (s.ngcToken) {
      const { exp } = jwtExp(s.ngcToken);
      if (exp && exp < now) throw new Error("NGC token expired: add your NGC login in Settings, or paste a new token");
      return s.ngcToken;
    }
    return null;
  }

  return {
    configured() { const s = getSettings(); return !!(s.ngcCertUrl && (s.ngcToken || (s.ngcUser && s.ngcPass))); },
    // -> {ngc_id, pcgs_no, description} or null; throws with a readable reason
    async lookup(cert, gradeNum) {
      const s = getSettings();
      if (!s.ngcCertUrl) return null;
      const t = await token();
      if (!t) return null;
      const url = s.ngcCertUrl.replaceAll("{cert}", encodeURIComponent(cert)).replaceAll("{grade}", gradeNum ? String(gradeNum) : "");
      const r = await http({ url, method: "GET", responseType: "json", headers: { Authorization: `Bearer ${t}`, Accept: "application/json" } });
      const d = typeof r.data === "string" ? (() => { try { return JSON.parse(r.data); } catch { return null; } })() : r.data;
      if (r.status === 401 || r.status === 403) { mem = null; save(null); throw new Error(`NGC API refused (HTTP ${r.status}): ${d?.message || ""}`.trim()); }
      if (r.status !== 200) throw new Error(`NGC API HTTP ${r.status}${d?.message ? ": " + d.message : ""}`);
      return idsFromAnswer(d);
    },
  };
}
