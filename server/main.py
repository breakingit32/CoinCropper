"""CoinCropper API + static web app.

Run:  uvicorn server.main:app --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import pcgs
from .cce import BidResult, CCEClient, CCEError, mock_bids
from .config import settings
from .labels import SlabInfo, normalise_grade, parse_barcode, parse_label_text

WEB = Path(__file__).resolve().parent.parent / "web"

state: dict = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    state["http"] = httpx.AsyncClient()
    state["cce"] = CCEClient(
        settings.cce_base_url, settings.cce_user_id, settings.cce_password,
        settings.cce_search_url,
    ) if settings.cce_mode == "live" else None
    state["cache"] = {}
    yield
    await state["http"].aclose()
    if state["cce"]:
        await state["cce"].aclose()


app = FastAPI(title="CoinCropper", lifespan=lifespan)

# The Android/iOS app (Capacitor) loads its pages from https://localhost or
# capacitor://localhost and calls this server cross-origin.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://localhost", "http://localhost", "capacitor://localhost"],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


class LookupRequest(BaseModel):
    code: str = ""
    ocr_text: Optional[str] = None
    # Manual corrections from the phone; these win over anything detected.
    service: Optional[str] = None
    cert: Optional[str] = None
    pcgs_no: Optional[str] = None
    grade: Optional[str] = None
    description: Optional[str] = None


async def identify(req: LookupRequest) -> SlabInfo:
    manual = SlabInfo(
        service=req.service or None, cert=req.cert or None,
        pcgs_no=req.pcgs_no or None, description=req.description or None,
    )
    if req.grade:
        manual.grade, manual.grade_num = normalise_grade(req.grade)
        if not manual.grade:
            manual.notes.append(f"grade '{req.grade}' not understood")

    coin = manual.merge(parse_barcode(req.code))
    if req.ocr_text:
        coin.merge(parse_label_text(req.ocr_text))

    if coin.service == "PCGS" and coin.cert and settings.pcgs_api_token:
        try:
            found = await pcgs.lookup_cert(state["http"], settings.pcgs_api_token, coin.cert)
        except httpx.HTTPError as e:
            found = None
            coin.notes.append(f"PCGS lookup failed: {e.__class__.__name__}")
        if found:
            coin.merge(found)
            coin.notes.append("identified via PCGS cert lookup")
    return coin


async def get_bids(coin: SlabInfo) -> BidResult:
    if not state.get("cce"):
        return mock_bids(coin)
    key = (coin.service, coin.cert, coin.pcgs_no, coin.grade, coin.description)
    hit = state["cache"].get(key)
    if hit and time.time() - hit.fetched_at < settings.cache_seconds:
        return hit
    try:
        res = await state["cce"].bids(coin)
    except (CCEError, httpx.HTTPError) as e:
        return BidResult(source="cce", error=str(e) or e.__class__.__name__)
    state["cache"][key] = res
    return res


def verify_url(coin: SlabInfo) -> Optional[str]:
    if not coin.cert:
        return None
    if coin.service == "PCGS":
        return f"https://www.pcgs.com/cert/{coin.cert}"
    if coin.service == "NGC":
        return f"https://www.ngccoin.com/certlookup/{coin.cert}/"
    return None


@app.post("/api/lookup")
async def lookup(req: LookupRequest) -> dict:
    coin = await identify(req)
    bids = await get_bids(coin)
    return {
        "coin": coin.to_dict(),
        "bids": bids.to_dict(),
        "verify_url": verify_url(coin),
        "cce_url": bids.url or settings.cce_base_url,
    }


@app.get("/api/status")
async def status() -> dict:
    return {
        "cce_mode": "live" if state.get("cce") else "mock",
        "cce_configured": bool(settings.cce_user_id and settings.cce_search_url),
        "pcgs_api": bool(settings.pcgs_api_token),
    }


@app.get("/")
async def index():
    return FileResponse(WEB / "index.html")


app.mount("/", StaticFiles(directory=WEB), name="web")
