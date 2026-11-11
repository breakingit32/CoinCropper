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
    res = await cli.bids(SlabInfo(service="PCGS", pcgs_no="7144", grade="MS65", grade_num=65))
    assert "tok" in seen["login"] and "me" in seen["login"]
    assert seen["search"].endswith("/members/search?p=7144&g=65")
    assert res.high_bid == 1250 and res.low_ask == 1400


def test_build_url_with_full_barcode():
    from server.labels import parse_barcode
    cli = CCEClient("https://cce.test", "me", "pw", "/members/lookup?bc={barcode}&g={grade_num}")
    coin = parse_barcode("6521437-005")
    assert cli.build_url(coin) == "https://cce.test/members/lookup?bc=6521437-005&g="
