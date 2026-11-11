import httpx
import pytest

from server.cce import CCEClient, mock_bids, parse_money, parse_quotes
from server.labels import SlabInfo

HTML = """
<table><tr><td>menu</td></tr></table>
<table>
  <tr><th>Coin</th><th>Svc</th><th>Grade</th><th>CAC</th><th>High Bid</th><th>Low Ask</th><th>Dealer</th></tr>
  <tr><td>1881-S $1</td><td>PCGS</td><td>65</td><td>Y</td><td>$1,250.00</td><td>$1,400</td><td>ABC Coins</td></tr>
  <tr><td>1881-S $1</td><td>PCGS</td><td>65</td><td></td><td>$1,180</td><td></td><td>XYZ Rare</td></tr>
  <tr><td>1881-S $1</td><td>PCGS</td><td>64</td><td></td><td>$300</td><td></td><td>Other</td></tr>
</table>
"""


def test_parse_money():
    assert parse_money("$1,250.50") == 1250.5
    assert parse_money("--") is None


def test_parse_quotes_filters_grade():
    q = parse_quotes(HTML, want_grade=65)
    bids = [x for x in q if x.side == "bid"]
    asks = [x for x in q if x.side == "ask"]
    assert sorted(b.price for b in bids) == [1180, 1250]
    assert [a.price for a in asks] == [1400]
    assert bids[0].dealer == "ABC Coins" and bids[0].cac


def test_mock_is_deterministic():
    c = SlabInfo(service="PCGS", cert="1", grade="MS65", grade_num=65)
    a, b = mock_bids(c), mock_bids(c)
    assert a.high_bid == b.high_bid and a.high_bid > 0


LOGIN_PAGE = """<form action="/Account/Login" method="post">
<input name="userId" type="text"><input name="password" type="password">
<input name="__RequestVerificationToken" type="hidden" value="tok">
<input name="style" value="standard" type="hidden"></form>"""


@pytest.mark.asyncio
async def test_live_client_logs_in_and_parses():
    seen = {}

    def handler(req: httpx.Request):
        if req.url.path == "/Account/Login" and req.method == "GET":
            return httpx.Response(200, text=LOGIN_PAGE)
        if req.url.path == "/Account/Login":
            body = req.content.decode()
            seen["login"] = body
            return httpx.Response(200, text="<a href='/account/logout'>Logout</a>")
        seen["search"] = str(req.url)
        return httpx.Response(200, text=HTML)

    cli = CCEClient("https://cce.test", "me", "pw", "/members/search?p={pcgs_no}&g={grade_num}")
    cli._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    res = await cli.bids(SlabInfo(service="NGC", grade="MS65", grade_num=65))   # no PCGS#: template page
    assert "tok" in seen["login"] and "me" in seen["login"]
    assert seen["search"].endswith("/members/search?p=&g=65")
    assert res.high_bid == 1250 and res.low_ask == 1400


def test_build_url_with_full_barcode():
    from server.labels import parse_barcode
    cli = CCEClient("https://cce.test", "me", "pw", "/members/lookup?bc={barcode}&g={grade_num}")
    coin = parse_barcode("6521437-005")
    assert cli.build_url(coin) == "https://cce.test/members/lookup?bc=6521437-005&g="


GRID = """<div><span>1PE 07268 1900-O/CC $1</span></div>
<a href="/mkt/viewmarket?coinno=07268&range=high">High 60-70</a>
<table><tr><th>ALL</th><th colspan="4">63</th><th colspan="4">64</th></tr>
<tr><td></td><td colspan="3">View All</td><td>(+)</td><td colspan="3">View All</td><td>(+)</td></tr>
<tr><td>bid</td><td>235</td><td>1</td><td>P</td><td>G78</td><td>320</td><td>1</td><td>N</td><td>C12</td></tr>
<tr><td>bid</td><td></td><td></td><td></td><td></td><td>555s</td><td>5</td><td>P</td><td>E01</td></tr>
<tr><td>ask</td><td></td><td></td><td></td><td></td><td>700s</td><td>1</td><td>P</td><td>G78</td></tr>
</table>"""
HOME = '<a href="/account/logout">Log out</a><form action="/mkt/viewmarket" method="get">View coin# <input type="text" name="coinno"></form>'


def test_market_grid_parse():
    from server.cce import parse_market_grid, quotes_for_grade
    g = parse_market_grid(GRID)
    q = quotes_for_grade(g, 64, service="PCGS")
    assert [(x.side, x.price, x.service) for x in q] == [("bid", 555, "PCGS"), ("ask", 700, "PCGS"), ("bid", 320, "NGC")]
    assert q[0].sight_seen and q[0].qty == 5 and q[0].dealer == "E01"
    assert g["title"] == "1PE 07268 1900-O/CC $1" and g["tabs"][0]["hi"] == 70


@pytest.mark.asyncio
async def test_view_coin_by_pcgs_number():
    urls = []

    def handler(req: httpx.Request):
        urls.append(str(req.url))
        if req.url.path == "/Account/Login" and req.method == "GET":
            return httpx.Response(200, text=LOGIN_PAGE)
        if req.url.path == "/Account/Login":
            return httpx.Response(200, text="<a href='/account/logout'>Logout</a>")
        if req.url.path == "/":
            return httpx.Response(200, text=HOME)
        return httpx.Response(200, text=GRID)

    cli = CCEClient("https://cce.test", "me", "pw", "")
    cli._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    res = await cli.bids(SlabInfo(service="PCGS", pcgs_no="7268", grade="MS64", grade_num=64))
    assert any(u.endswith("/mkt/viewmarket?coinno=07268") for u in urls)
    assert res.high_bid == 555 and res.low_ask == 700 and res.market_title.startswith("1PE 07268")
