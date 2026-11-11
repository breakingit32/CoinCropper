"""Cert-number lookup through the PCGS public API (optional)."""

from __future__ import annotations

import httpx

from .labels import SlabInfo, normalise_grade

API = "https://api.pcgs.com/publicapi/coindetail/GetCoinFactsByCertNo/{cert}"


def coin_from_pcgs_json(data: dict, cert: str) -> SlabInfo:
    info = SlabInfo(service="PCGS", cert=cert)
    pcgs_no = data.get("PCGSNo") or data.get("PCGSNumber")
    if pcgs_no:
        info.pcgs_no = str(pcgs_no)
    info.description = data.get("Name") or None
    if data.get("Year"):
        info.year = str(data["Year"])
    info.mint_mark = data.get("MintMark") or None
    grade_text = " ".join(
        str(x) for x in (data.get("Grade"), data.get("Designation")) if x
    )
    if grade_text:
        info.grade, info.grade_num = normalise_grade(grade_text)
        if not info.grade:
            info.notes.append(f"PCGS grade '{grade_text}' not understood")
    return info


async def lookup_cert(client: httpx.AsyncClient, token: str, cert: str) -> SlabInfo | None:
    if not token or not cert:
        return None
    r = await client.get(
        API.format(cert=cert),
        headers={"Authorization": f"bearer {token}", "Accept": "application/json"},
        timeout=15,
    )
    if r.status_code != 200:
        return None
    data = r.json()
    if not data or data.get("IsValidRequest") is False:
        return None
    return coin_from_pcgs_json(data, cert)
