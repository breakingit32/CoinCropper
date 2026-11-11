"""Grading-service APIs (server side; mirrors web/grading.js).

PCGS public API: coin, grade, PCGS#, price guide, population, auctions.
CAC Grading API: CAC sticker (Green/Gold) on PCGS/NGC coins.
Results are cached in memory; several PCGS keys rotate when one is refused
or hits its daily limit.
"""

from __future__ import annotations

import datetime as dt
import re
import time
from typing import Optional
from urllib.parse import quote

import httpx

from .labels import SlabInfo, normalise_grade

PCGS = "https://api.pcgs.com/publicapi/coindetail"
CAC = "https://api.cacgrading.com"
CACHE_SECONDS = 7 * 86400


def cert_variants(cert: Optional[str]) -> list[str]:
    c = re.sub(r"\D", "", cert or "")
    if not c:
        return []
    out = [c]
    if len(c) < 8:
        out.append(c.zfill(8))
    if len(c) == 8 and c.startswith("0"):
        out.append(c.lstrip("0"))
    return out


def slim_pcgs(d: dict) -> dict:
    img = (d.get("Images") or [{}])[0] if d.get("Images") else {}
    link = d.get("CoinFactsLink")
    return {
        "service": "PCGS",
        "pcgs_no": str(d["PCGSNo"]) if d.get("PCGSNo") else None,
        "cert": str(d["CertNo"]) if d.get("CertNo") else None,
        "name": d.get("Name"),
        "year": str(d["Year"]) if d.get("Year") else None,
        "denomination": d.get("Denomination"),
        "mint_mark": d.get("MintMark") or None,
        "grade": " ".join(x for x in (d.get("Grade"), d.get("Designation")) if x) or None,
        "variety": ", ".join(x for x in (d.get("MajorVariety"), d.get("MinorVariety"), d.get("DieVariety")) if x) or None,
        "price_guide": d.get("PriceGuideValue") or None,
        "population": d.get("Population"),
        "pop_higher": d.get("PopHigher"),
        "coinfacts_url": ("https://" + re.sub(r"^https?://", "", link)) if link else None,
        "image": img.get("Thumbnail") or img.get("Fullsize"),
        "auctions": [
            {"date": a.get("Date"), "auctioneer": a.get("Auctioneer"), "sale": a.get("SaleName"),
             "price": a.get("Price"), "cac": bool(a.get("IsCAC")), "url": a.get("AuctionLotUrl")}
            for a in (d.get("AuctionList") or [])[:10]
        ],
    }


def coin_from_grading(g: dict) -> SlabInfo:
    c = SlabInfo(service=g.get("service"), cert=g.get("cert"), pcgs_no=g.get("pcgs_no"),
                 description=g.get("name"), year=g.get("year"), mint_mark=g.get("mint_mark"))
    if g.get("grade"):
        c.grade, c.grade_num = normalise_grade(g["grade"])
    return c


class Grading:
    def __init__(self, client: httpx.AsyncClient, pcgs_keys: list[str], cacg_key: str = "", cacg_token: str = ""):
        self.client = client
        self.pcgs_keys = pcgs_keys
        self.cacg_key, self.cacg_token = cacg_key, cacg_token
        self.cache: dict[str, tuple[float, object]] = {}
        self.spent: dict[str, str] = {}

    def _get(self, k: str):
        e = self.cache.get(k)
        return e[1] if e and time.time() - e[0] < CACHE_SECONDS else ...

    def _set(self, k: str, v) -> None:
        self.cache[k] = (time.time(), v)

    async def _pcgs_call(self, path: str) -> dict:
        today = dt.date.today().isoformat()
        for key in self.pcgs_keys:
            if self.spent.get(key) == today:
                continue
            r = await self.client.get(f"{PCGS}/{path}", timeout=15,
                                      headers={"Authorization": f"bearer {key}", "Accept": "application/json"})
            try:
                data = r.json()
            except ValueError:
                data = None
            msg = f"{(data or {}).get('Message', '')} {(data or {}).get('ServerMessage', '')}"
            if r.status_code in (401, 403, 429) or re.search(r"limit|quota|exceed|denied", msg, re.I):
                self.spent[key] = today
                continue
            if r.status_code != 200:
                return {"error": f"PCGS HTTP {r.status_code}"}
            if not data or data.get("IsValidRequest") is False or not data.get("PCGSNo"):
                return {"not_found": True}
            return {"data": data}
        return {"error": "all PCGS API keys are used up for today"}

    async def pcgs(self, cert: Optional[str], barcode: Optional[str]) -> Optional[dict]:
        tries = []
        if barcode and not re.match(r"https?:", barcode, re.I):
            tries.append(("b:" + barcode, f"GetCoinFactsByBarcode?barcode={quote(barcode)}&gradingService=PCGS"))
        tries += [("c:" + c, f"GetCoinFactsByCertNo/{quote(c)}") for c in cert_variants(cert)]
        for key, path in tries:
            hit = self._get("pcgs:" + key)
            if hit is None:
                continue
            if hit is not ...:
                return hit
            r = await self._pcgs_call(path)
            if "error" in r:
                raise RuntimeError(r["error"])
            if r.get("not_found"):
                self._set("pcgs:" + key, None)
                continue
            g = slim_pcgs(r["data"])
            self._set("pcgs:" + key, g)
            return g
        return None

    async def cac_sticker(self, service: Optional[str], cert: Optional[str]) -> Optional[str]:
        if not (self.cacg_key and self.cacg_token and cert and service in ("PCGS", "NGC")):
            return None
        k = f"cac:{service}:{cert}"
        hit = self._get(k)
        if hit is not ...:
            return hit
        status = None
        for c in (cert_variants(cert) if service == "PCGS" else [cert]):
            r = await self.client.get(f"{CAC}/stickered_certs", params={"certId": c, "gradingService": service},
                                      headers={"X-API-KEY": self.cacg_key, "X-API-TOKEN": self.cacg_token}, timeout=15)
            if r.status_code != 200:
                raise RuntimeError(f"CAC HTTP {r.status_code}")
            rows = r.json().get("data") or []
            if rows:
                status = rows[0].get("status") or "Green"
                break
        self._set(k, status)
        return status

    async def identify(self, coin: SlabInfo) -> tuple[Optional[dict], list[str]]:
        notes: list[str] = []
        g = None
        if self.pcgs_keys and (coin.service == "PCGS" or (not coin.service and coin.cert)):
            try:
                g = await self.pcgs(coin.cert, coin.raw)
            except (RuntimeError, httpx.HTTPError) as e:
                notes.append(f"PCGS lookup failed: {e}")
        service, cert = (g or {}).get("service") or coin.service, (g or {}).get("cert") or coin.cert
        try:
            cac = await self.cac_sticker(service, cert)
            if cac:
                g = g or {"service": service, "cert": cert, "auctions": []}
                g["cac"] = cac
        except (RuntimeError, httpx.HTTPError) as e:
            notes.append(f"CAC lookup failed: {e}")
        return g, notes


# ------------------------------------------------------------- Greysheet (CDN Public API)

GREYSHEET = "https://cpgpublicapiv2.greysheet.com/api"


def _gs_money(v) -> Optional[float]:
    m = re.search(r"[0-9][0-9,]*(?:\.\d+)?", str(v or ""))
    n = float(m.group(0).replace(",", "")) if m else 0
    return n if n > 0 else None


def greysheet_from_response(data: dict, grade_num: int, cac: Optional[str]) -> Optional[dict]:
    sets = (data or {}).get("Data") or []
    if not sets:
        return None
    s = sets[0]
    rows = [r for r in s.get("PricingData") or [] if int(r.get("Grade") or 0) == int(grade_num)]
    if not rows:
        return {"gsid": s.get("GsId"), "name": s.get("Name"), "grade": grade_num, "none": True}
    plain = next((r for r in rows if not r.get("IsCac")), rows[0])
    with_cac = next((r for r in rows if r.get("IsCac")), None)
    return {
        "gsid": s.get("GsId"), "name": s.get("Name"), "grade": grade_num, "grade_label": plain.get("GradeLabel"),
        "grey": _gs_money(plain.get("GreyVal")), "cpg": _gs_money(plain.get("CpgVal")),
        "pcgs": _gs_money(plain.get("PcgsVal")), "ngc": _gs_money(plain.get("NgcVal")),
        "bluebook": _gs_money(plain.get("BlueBookVal")),
        "grey_cac": _gs_money(with_cac.get("GreyVal")) if with_cac else None,
        "cpg_cac": _gs_money(with_cac.get("CpgVal")) if with_cac else None,
        "cac": bool(cac),
    }


class Greysheet:
    def __init__(self, client: httpx.AsyncClient, key: str, token: str):
        self.client, self.key, self.token = client, key, token
        self.cache: dict[str, tuple[float, Optional[dict]]] = {}

    async def _call(self, params: dict, advanced: bool):
        p = dict(params, **({"ApiLevel": "advanced"} if advanced else {}))
        r = await self.client.get(f"{GREYSHEET}/GetPricingRequest", params=p, timeout=15,
                                  headers={"x-api-token": self.token, "x-api-key": self.key, "Accept": "application/json"})
        try:
            data = r.json()
        except ValueError:
            data = None
        if r.status_code in (401, 403) or (data or {}).get("PermitAccess") is False:
            return None, (data or {}).get("AccessDeniedMessage") or f"HTTP {r.status_code}"
        if r.status_code != 200:
            raise RuntimeError(f"Greysheet HTTP {r.status_code}")
        if (data or {}).get("ErrorText"):
            raise RuntimeError(f"Greysheet: {data['ErrorText']}")
        return data, None

    async def price(self, pcgs_no: Optional[str], grade_num: Optional[int], cac: Optional[str]) -> Optional[dict]:
        if not (self.key and self.token and pcgs_no and grade_num):
            return None
        k = f"{pcgs_no}:{grade_num}"
        hit = self.cache.get(k)
        if hit and time.time() - hit[0] < 86400:
            return dict(hit[1], cac=bool(cac)) if hit[1] else None
        params = {"PcgsNumber": str(pcgs_no), "Grade": str(grade_num)}
        data, denied = await self._call(params, True)
        tier = "advanced"
        if denied:
            data, denied = await self._call(params, False)
            tier = "basic"
        if denied:
            raise RuntimeError(f"Greysheet refused the key: {denied}")
        g = greysheet_from_response(data, grade_num, cac)
        if g:
            g["tier"] = tier
        self.cache[k] = (time.time(), g)
        return g
