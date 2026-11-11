from fastapi.testclient import TestClient

from server.main import app


def test_lookup_mock():
    with TestClient(app) as c:
        assert c.get("/api/status").json()["cce_mode"] == "mock"
        r = c.post("/api/lookup", json={"code": "45678912", "grade": "ms 66"}).json()
        assert r["coin"]["service"] == "PCGS"
        assert r["coin"]["grade"] == "MS66"
        assert r["bids"]["source"] == "mock"
        assert r["bids"]["high_bid"] > 0
        assert r["verify_url"] == "https://www.pcgs.com/cert/45678912"
        assert c.get("/").status_code == 200
        assert c.get("/app.js").status_code == 200


def test_cors_for_android_app():
    with TestClient(app) as c:
        r = c.options("/api/lookup", headers={
            "Origin": "https://localhost", "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type"})
        assert r.headers["access-control-allow-origin"] == "https://localhost"


def test_grading_pcgs_and_cac(monkeypatch):
    import asyncio, json, pathlib
    import httpx
    from server.grading import Grading
    fixture = json.loads((pathlib.Path(__file__).parent / "fixtures/pcgs_cert_02401136.json").read_text())

    def handler(req: httpx.Request):
        if "pcgs.com" in req.url.host:
            if req.headers["authorization"] == "bearer BAD":
                return httpx.Response(401, json={"Message": "Authorization has been denied for this request."})
            if req.url.path.endswith("/GetCoinFactsByCertNo/02401136"):
                return httpx.Response(200, json=fixture)
            return httpx.Response(200, json={"IsValidRequest": True, "ServerMessage": "No data found"})
        if req.url.params.get("certId") == "02401136":
            return httpx.Response(200, json={"data": [{"status": "Green"}]})
        return httpx.Response(200, json={"data": []})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as cli:
            g = Grading(cli, ["BAD", "GOOD"], "k", "t")
            from server.labels import SlabInfo
            return await g.identify(SlabInfo(service="PCGS", cert="2401136"))

    info, notes = asyncio.run(run())
    assert info["name"] == "1900-O/CC $1" and info["grade"] == "MS64" and info["pcgs_no"] == "7268"
    assert info["price_guide"] == 1750 and info["auctions"][0]["price"] == 1380
    assert info["cac"] == "Green" and notes == []


def test_greysheet_price():
    import asyncio
    import httpx
    from server.grading import Greysheet

    def handler(req: httpx.Request):
        assert req.headers["x-api-key"] == "K" and req.headers["x-api-token"] == "T"
        assert req.url.params["PcgsNumber"] == "7268" and req.url.params["Grade"] == "64"
        return httpx.Response(200, json={"PermitAccess": True, "Data": [{"GsId": 1, "Name": "1900-O/CC $1", "PricingData": [
            {"Grade": 64, "GradeLabel": "MS64", "IsCac": False, "GreyVal": "1,450.00", "CpgVal": "1,850"},
            {"Grade": 64, "GradeLabel": "MS64", "IsCac": True, "GreyVal": "1,725.00"}]}]})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as cli:
            return await Greysheet(cli, "K", "T").price("7268", 64, "Green")

    g = asyncio.run(run())
    assert g["grey"] == 1450 and g["grey_cac"] == 1725 and g["cpg"] == 1850 and g["tier"] == "advanced"
