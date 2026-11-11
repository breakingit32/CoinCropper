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
