import numpy as np
import pytest
from fastapi.testclient import TestClient
from scipy import stats

from app import risk
from app.main import app

client = TestClient(app)
ALPHA = 0.99


def fake_returns(days=800, assets=3, seed=0):
    """Fat-tailed synthetic daily returns (no network needed)."""
    rng = np.random.default_rng(seed)
    return (stats.t.rvs(4, size=(days, assets), random_state=rng) * 0.008).tolist()


def body(**kw):
    b = {"weights": [0.5, 0.3, 0.2], "returns": fake_returns(), "window": 500}
    b.update(kw)
    return b


# ---------- maths ----------

def test_normal_var_matches_textbook():
    rng = np.random.default_rng(1)
    r = rng.normal(0, 0.01, 200_000)
    var, es = risk.normal(r, ALPHA)
    assert var == pytest.approx(0.01 * 2.3263, rel=0.01)   # z_0.99 * sigma
    assert es == pytest.approx(0.01 * 2.6652, rel=0.01)    # pdf(z)/(1-a) * sigma


def test_student_t_recovers_true_tails():
    true = stats.t(5, scale=0.01)
    r = true.rvs(20_000, random_state=np.random.default_rng(3))
    nu, _, _ = risk.fit_nu(r)
    assert 4 < nu < 6.5
    var, _ = risk.student_t(r, ALPHA)
    assert var == pytest.approx(true.ppf(ALPHA), rel=0.05)


def test_student_t_close_to_historical_on_mild_tails():
    """Regression: a free fit on 500 days gave nu~2.3 and VaR 80% above historical."""
    X = np.asarray(fake_returns(seed=1))[-500:] @ np.array([0.5, 0.3, 0.2])
    t_var, _ = risk.student_t(X, ALPHA)
    h_var, _ = risk.historical(X, ALPHA)
    assert t_var == pytest.approx(h_var, rel=0.25)


def test_es_is_at_least_var_for_every_method():
    X = np.asarray(fake_returns())
    w = np.array([0.5, 0.3, 0.2])
    for m in risk.METHODS:
        var, es = risk.estimate(m, X @ w, X, w, ALPHA)
        assert var > 0 and es >= var, m


# ---------- endpoints ----------

def test_health():
    assert client.get("/health").json() == {"status": "ok"}


def test_var_endpoint_returns_all_methods():
    r = client.post("/var", json=body())
    assert r.status_code == 200
    out = r.json()
    assert set(out["results"]) == set(risk.METHODS)
    assert out["observations"] == 500
    hist = out["results"]["historical"]
    assert hist["var_usd"] == pytest.approx(hist["var_pct"] * 1_000_000, abs=1)


def test_var_endpoint_single_method():
    r = client.post("/var", json=body(methods=["normal"]))
    assert list(r.json()["results"]) == ["normal"]


@pytest.mark.parametrize("bad, msg", [
    ({"weights": [0.5, 0.5, 0.5]}, "sum to 1"),
    ({"weights": [0.5, 0.5]}, "weights but"),
    ({"alpha": 1.2}, None),
    ({"tickers": ["SPY", "TLT", "GLD"]}, "exactly one"),
])
def test_bad_input_is_rejected(bad, msg):
    r = client.post("/var", json=body(**bad))
    assert r.status_code == 422
    if msg:
        assert msg in r.text


def test_too_little_data():
    r = client.post("/var", json=body(returns=fake_returns(days=50)))
    assert r.status_code == 422


# ---------- web page inputs: dollar values, horizon ----------

def test_values_give_same_risk_as_weights():
    by_weight = client.post("/var", json=body(portfolio_value=2_000_000)).json()
    by_value = client.post("/var", json=body(
        weights=None, values=[1_000_000, 600_000, 400_000])).json()
    assert by_value["portfolio_value"] == 2_000_000
    for m in risk.METHODS:
        assert by_value["results"][m]["var_usd"] == \
            pytest.approx(by_weight["results"][m]["var_usd"], abs=0.01), m


def test_horizon_scales_by_square_root_of_time():
    one = client.post("/var", json=body(methods=["historical"])).json()
    ten = client.post("/var", json=body(methods=["historical"], horizon_days=10)).json()
    assert ten["horizon_days"] == 10
    assert ten["results"]["historical"]["var_usd"] == \
        pytest.approx(one["results"]["historical"]["var_usd"] * np.sqrt(10), rel=1e-4)


def test_var_response_has_page_data():
    out = client.post("/var", json=body()).json()
    assert [a["name"] for a in out["assets"]] == ["Asset 1", "Asset 2", "Asset 3"]
    assert sum(out["pnl_histogram"]["counts"]) == out["observations"]
    assert out["results"]["student_t"]["details"]["degrees_of_freedom"] >= 3


def test_page_is_served():
    r = client.get("/")
    assert r.status_code == 200 and "Calculate risk" in r.text
    assert client.get("/static/app.js").status_code == 200


@pytest.mark.parametrize("bad, msg", [
    ({"values": [1, 2, 3]}, "exactly one of `values` or `weights`"),
    ({"weights": None, "values": [100, -5, 50]}, "greater than 0"),
    ({"horizon_days": 0}, None),
    ({"returns": None, "tickers": ["SPY", "spy", "TLT"]}, "only once"),
])
def test_bad_page_input_is_rejected(bad, msg):
    r = client.post("/var", json=body(**bad))
    assert r.status_code == 422
    if msg:
        assert msg in r.text


def test_unknown_ticker_gives_clear_message(monkeypatch):
    from app import main

    def no_prices(tickers, start):
        raise main.NoPrices(["NOTATICKER"])
    monkeypatch.setattr(main, "_download", no_prices)
    r = client.post("/var", json={"tickers": ["NOTATICKER"], "values": [1000]})
    assert r.status_code == 422
    assert "No prices found for NOTATICKER" in r.text
