"""Certified Coin Exchange (CCE) bid lookup.

CCE (certifiedcoinexchange.com) only shows numismatic bids to logged-in
members, and it has no public API, so this module signs in with *your*
member account (server-side, the credentials never reach the phone) and
reads the bid table from the member page you point it at with
``CCE_SEARCH_URL``.

The login form fields (``userId``, ``password`` plus an anti-forgery token)
match the public login page.  The member-area page layout cannot be seen
without an account, so the table parser is deliberately generic: it looks
for any HTML table whose header has a "Bid" (or "Ask") column and maps the
other columns by name.
"""

from __future__ import annotations

import hashlib
import re
import time
from dataclasses import asdict, dataclass, field
from typing import Optional
from urllib.parse import quote_plus

import httpx
from bs4 import BeautifulSoup

from .labels import SlabInfo, normalise_grade

UA = (
    "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/130.0 Mobile Safari/537.36"
)


@dataclass
class Quote:
    side: str  # "bid" or "ask"
    price: float
    dealer: Optional[str] = None
    grade: Optional[str] = None
    service: Optional[str] = None
    description: Optional[str] = None
    cac: bool = False
    when: Optional[str] = None


@dataclass
class BidResult:
    source: str  # "cce", "mock"
    url: Optional[str] = None
    quotes: list[Quote] = field(default_factory=list)
    error: Optional[str] = None
    fetched_at: float = field(default_factory=time.time)

    @property
    def high_bid(self) -> Optional[float]:
        bids = [q.price for q in self.quotes if q.side == "bid"]
        return max(bids) if bids else None

    @property
    def low_ask(self) -> Optional[float]:
        asks = [q.price for q in self.quotes if q.side == "ask"]
        return min(asks) if asks else None

    def to_dict(self) -> dict:
        d = asdict(self)
        d["high_bid"] = self.high_bid
        d["low_ask"] = self.low_ask
        d["bid_count"] = sum(1 for q in self.quotes if q.side == "bid")
        return d


# --------------------------------------------------------------------------
# HTML parsing
# --------------------------------------------------------------------------

_COLS = {
    "bid": re.compile(r"\b(high\s*)?bid\b", re.I),
    "ask": re.compile(r"\b(low\s*)?ask\b", re.I),
    "grade": re.compile(r"\bgrade\b|\bgr\b", re.I),
    "service": re.compile(r"\bservice\b|\bsvc\b|\bgrader\b|\bcert\.?\s*svc", re.I),
    "dealer": re.compile(r"dealer|member|buyer|seller|firm|company", re.I),
    "description": re.compile(r"desc|coin|item|title", re.I),
    "cac": re.compile(r"\bcac\b", re.I),
    "when": re.compile(r"time|date|posted|updated", re.I),
}
_MONEY = re.compile(r"\$?\s*([0-9][0-9,]*(?:\.\d{1,2})?)")


def parse_money(text: str) -> Optional[float]:
    m = _MONEY.search(text or "")
    if not m:
        return None
    try:
        v = float(m.group(1).replace(",", ""))
    except ValueError:
        return None
    return v if v > 0 else None


def _cells(tr) -> list[str]:
    return [c.get_text(" ", strip=True) for c in tr.find_all(["th", "td"])]


def _map_header(header: list[str]) -> dict[str, int]:
    cols: dict[str, int] = {}
    for i, h in enumerate(header):
        for key, rx in _COLS.items():
            if key not in cols and rx.search(h):
                cols[key] = i
                break
    return cols


def parse_quotes(html: str, want_grade: Optional[int] = None) -> list[Quote]:
    soup = BeautifulSoup(html, "html.parser")
    quotes: list[Quote] = []
    for table in soup.find_all("table"):
        rows = table.find_all("tr")
        if len(rows) < 2:
            continue
        header_idx, cols = None, {}
        for i, tr in enumerate(rows[:5]):
            cols = _map_header(_cells(tr))
            if "bid" in cols or "ask" in cols:
                header_idx = i
                break
        if header_idx is None:
            continue
        for tr in rows[header_idx + 1:]:
            cells = _cells(tr)
            if len(cells) < 2:
                continue

            def cell(key: str) -> Optional[str]:
                i = cols.get(key)
                return cells[i] if i is not None and i < len(cells) and cells[i] else None

            grade_txt = cell("grade")
            if want_grade and grade_txt:
                _, gnum = normalise_grade(grade_txt if re.search(r"[A-Z]", grade_txt, re.I)
                                          else f"MS{grade_txt}")
                if gnum and gnum != want_grade:
                    continue
            common = dict(
                dealer=cell("dealer"),
                grade=grade_txt,
                service=cell("service"),
                description=cell("description"),
                cac=bool(cell("cac") and re.search(r"y|yes|cac|✓|x", cell("cac") or "", re.I)),
                when=cell("when"),
            )
            for side in ("bid", "ask"):
                price = parse_money(cell(side) or "")
                if price:
                    quotes.append(Quote(side=side, price=price, **common))
    return quotes


# --------------------------------------------------------------------------
# Live client
# --------------------------------------------------------------------------

class CCEError(RuntimeError):
    pass


class CCEClient:
    def __init__(self, base_url: str, user_id: str, password: str, search_url: str):
        self.base_url = base_url.rstrip("/")
        self.user_id = user_id
        self.password = password
        self.search_url = search_url
        self._client = httpx.AsyncClient(
            headers={"User-Agent": UA}, follow_redirects=True, timeout=20
        )
        self._logged_in_at = 0.0

    async def aclose(self) -> None:
        await self._client.aclose()

    @staticmethod
    def _looks_logged_out(html: str) -> bool:
        return 'name="password"' in html and 'name="userId"' in html

    async def login(self) -> None:
        if not (self.user_id and self.password):
            raise CCEError("CCE_USER_ID / CCE_PASSWORD are not set")
        r = await self._client.get(f"{self.base_url}/Account/Login")
        soup = BeautifulSoup(r.text, "html.parser")
        form = soup.find("form", action=re.compile("login", re.I))
        if not form:
            raise CCEError("CCE login form not found (site layout changed?)")
        data = {
            i.get("name"): i.get("value", "")
            for i in form.find_all("input")
            if i.get("name") and i.get("type") in ("hidden", None)
        }
        data.update(userId=self.user_id, password=self.password, submit="Login to CCE")
        r = await self._client.post(
            f"{self.base_url}/Account/Login",
            files={k: (None, v) for k, v in data.items()},  # form is multipart
        )
        if self._looks_logged_out(r.text):
            raise CCEError("CCE login failed: check CCE_USER_ID / CCE_PASSWORD")
        self._logged_in_at = time.time()

    def build_url(self, coin: SlabInfo) -> str:
        if not self.search_url:
            raise CCEError(
                "CCE_SEARCH_URL is not set; see README 'Connecting to CCE'"
            )
        query = " ".join(x for x in (coin.description, coin.grade) if x)
        url = self.search_url.format(
            pcgs_no=quote_plus(coin.pcgs_no or ""),
            grade=quote_plus(coin.grade or ""),
            grade_num=coin.grade_num or "",
            service=quote_plus(coin.service or ""),
            cert=quote_plus(coin.cert or ""),
            query=quote_plus(query),
        )
        if url.startswith("/"):
            url = self.base_url + url
        return url

    async def bids(self, coin: SlabInfo) -> BidResult:
        url = self.build_url(coin)
        # Sessions on CCE expire; re-login every 30 minutes or when bounced.
        if time.time() - self._logged_in_at > 1800:
            await self.login()
        r = await self._client.get(url)
        if self._looks_logged_out(r.text):
            await self.login()
            r = await self._client.get(url)
        r.raise_for_status()
        return BidResult(source="cce", url=url, quotes=parse_quotes(r.text, coin.grade_num))


# --------------------------------------------------------------------------
# Mock data so the app can be demoed without a CCE membership
# --------------------------------------------------------------------------

_DEALERS = ["Dealer A", "Dealer B", "Dealer C", "Dealer D", "Dealer E", "Dealer F"]


def mock_bids(coin: SlabInfo) -> BidResult:
    key = f"{coin.service}|{coin.cert}|{coin.pcgs_no}|{coin.grade}".encode()
    h = hashlib.sha256(key).digest()
    grade = coin.grade_num or 63
    base = (50 + h[0] * 7) * (1.12 ** max(0, grade - 60))
    quotes = []
    for i in range(2 + h[1] % 4):
        quotes.append(Quote(
            side="bid",
            price=round(base * (1 - 0.04 * i - h[2 + i] / 4000), 2),
            dealer=_DEALERS[(h[6 + i]) % len(_DEALERS)],
            grade=coin.grade,
            service=coin.service,
            cac=bool(h[10 + i] % 5 == 0),
        ))
    for i in range(1 + h[14] % 3):
        quotes.append(Quote(
            side="ask",
            price=round(base * (1.08 + 0.05 * i + h[15 + i] / 4000), 2),
            dealer=_DEALERS[(h[18 + i]) % len(_DEALERS)],
            grade=coin.grade,
            service=coin.service,
        ))
    return BidResult(source="mock", quotes=quotes)
