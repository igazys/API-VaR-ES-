"""VaR / ES Risk API with a local web page.

Two ways to describe the holdings:
  * `values`: dollar amount in each instrument (the web page uses this)
  * `weights`: fractions that sum to 1, plus `portfolio_value`

Two ways to supply the data:
  * `tickers`: symbols downloaded from Yahoo Finance on the server
  * `returns`: your own daily asset returns (rows = days, columns = assets)
"""
from datetime import date
from functools import lru_cache
from pathlib import Path
from typing import Literal

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, model_validator

from . import risk

STATIC = Path(__file__).parent / "static"

app = FastAPI(
    title="VaR / ES Risk API",
    version="1.1.0",
    description="Value-at-Risk and Expected Shortfall for multi-asset portfolios, "
                "calculated with five different methods.",
)
app.mount("/static", StaticFiles(directory=STATIC), name="static")

Method = Literal["historical", "normal", "student_t", "monte_carlo", "filtered_historical"]


class Portfolio(BaseModel):
    values: list[float] | None = Field(
        None, description="Dollar amount held in each asset. Alternative to `weights`.",
        examples=[[400_000, 200_000, 250_000, 150_000]])
    weights: list[float] | None = Field(
        None, description="Fractions of the portfolio that sum to 1. Alternative to `values`.")
    returns: list[list[float]] | None = Field(
        None, description="Daily simple returns, one row per day, one column per asset.")
    tickers: list[str] | None = Field(None, examples=[["SPY", "QQQ", "TLT", "GLD"]])
    start: date = date(2018, 1, 1)
    portfolio_value: float = Field(1_000_000, gt=0,
                                   description="Ignored when `values` is sent.")
    alpha: float = Field(0.99, gt=0.5, lt=1, description="Confidence level, e.g. 0.99")
    horizon_days: int = Field(1, ge=1, le=250,
                              description="Holding period in trading days (square-root-of-time).")
    window: int = Field(500, ge=100, le=5000, description="Lookback days")

    @model_validator(mode="after")
    def check(self):
        if (self.returns is None) == (self.tickers is None):
            raise ValueError("Send exactly one of `returns` or `tickers`.")
        if (self.values is None) == (self.weights is None):
            raise ValueError("Send exactly one of `values` or `weights`.")
        if self.values is not None:
            if any(v <= 0 for v in self.values):
                raise ValueError("Every value must be greater than 0.")
            total = float(sum(self.values))
            self.portfolio_value = total
            self.weights = [v / total for v in self.values]
        elif not np.isclose(sum(self.weights), 1.0, atol=1e-6):
            raise ValueError("Weights must sum to 1.")
        n = len(self.tickers) if self.tickers else len(self.returns[0])
        if n > 50:
            raise ValueError("Use at most 50 instruments.")
        if len(self.weights) != n:
            raise ValueError(f"{len(self.weights)} weights but {n} assets.")
        if self.tickers and len({t.strip().upper() for t in self.tickers}) != n:
            raise ValueError("Each ticker can appear only once.")
        return self


class VarRequest(Portfolio):
    methods: list[Method] = list(risk.METHODS)


class NoPrices(Exception):
    pass


@lru_cache(maxsize=64)
def _download(tickers: tuple, start: str):
    """Daily returns for `tickers`, aligned on common dates. Returns (dates, X)."""
    import yfinance as yf
    px = yf.download(list(tickers), start=start, auto_adjust=True, progress=False)["Close"]
    missing = [t for t in tickers if t not in px.columns or px[t].isna().all()]
    if missing:
        raise NoPrices(missing)
    px = px[list(tickers)].dropna()
    ret = px.pct_change().dropna()
    return tuple(str(d.date()) for d in ret.index), ret.to_numpy()


def _asset_returns(p: Portfolio):
    """(asset returns, dates). Dates are None for uploaded returns."""
    dates = None
    if p.returns is not None:
        X = np.asarray(p.returns, dtype=float)
    else:
        tickers = tuple(t.strip().upper() for t in p.tickers)
        try:
            dates, X = _download(tickers, p.start.isoformat())
        except NoPrices as e:
            names = ", ".join(e.args[0])
            raise HTTPException(422, f"No prices found for {names}. Check the symbol on "
                                     "finance.yahoo.com and your internet connection.")
        except Exception as e:
            raise HTTPException(502, f"Price download failed: {e}")
    if X.ndim != 2 or len(X) < 100:
        raise HTTPException(422, f"Need at least 100 days of returns, got {len(X)}. "
                                 "Pick an earlier start date.")
    if not np.isfinite(X).all():
        raise HTTPException(422, "Returns contain NaN or infinite values.")
    return X, dates


def _details(method, port):
    """Extra numbers shown next to each method's explanation."""
    if method == "student_t":
        nu, _, _ = risk.fit_nu(port)
        return {"degrees_of_freedom": round(nu, 2)}
    if method == "filtered_historical":
        _, sig_next = risk.ewma_vol(port)
        return {"current_daily_vol": round(float(sig_next), 6),
                "average_daily_vol": round(float(port.std(ddof=1)), 6)}
    if method == "monte_carlo":
        return {"scenarios": 10_000, "degrees_of_freedom": 5}
    return {}


def _histogram(pnl, bins=60):
    counts, edges = np.histogram(pnl, bins=bins)
    return {"edges": [round(float(e), 2) for e in edges], "counts": counts.tolist()}


@app.get("/", include_in_schema=False)
def page():
    return FileResponse(STATIC / "index.html")


@app.get("/api")
def info():
    return {"name": app.title, "docs": "/docs", "methods": risk.METHODS}


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/var")
def compute_var(req: VarRequest):
    """VaR and ES over `horizon_days`, using the most recent `window` days."""
    X, dates = _asset_returns(req)
    X = X[-req.window:]
    used = dates[-req.window:] if dates else None
    w = np.asarray(req.weights)
    port = X @ w
    scale = np.sqrt(req.horizon_days)
    out = {}
    for m in req.methods:
        var, es = risk.estimate(m, port, X, w, req.alpha)
        var, es = var * scale, es * scale
        out[m] = {
            "var_pct": round(float(var), 6),
            "es_pct": round(float(es), 6),
            "var_usd": round(float(var) * req.portfolio_value, 2),
            "es_usd": round(float(es) * req.portfolio_value, 2),
            "es_to_var": round(float(es / var), 3) if var > 0 else None,
            "details": _details(m, port),
        }
    names = [t.strip().upper() for t in req.tickers] if req.tickers \
        else [f"Asset {i + 1}" for i in range(len(w))]
    assets = [{"name": n, "weight": round(float(wi), 6),
               "value": round(float(wi * req.portfolio_value), 2),
               "annualised_vol": round(float(X[:, i].std(ddof=1) * np.sqrt(252)), 4)}
              for i, (n, wi) in enumerate(zip(names, w))]
    return {
        "alpha": req.alpha,
        "horizon_days": req.horizon_days,
        "observations": len(port),
        "data_from": used[0] if used else None,
        "data_to": used[-1] if used else None,
        "portfolio_value": req.portfolio_value,
        "annualised_vol": round(float(port.std(ddof=1) * np.sqrt(252)), 4),
        "assets": assets,
        "pnl_histogram": _histogram(port * scale * req.portfolio_value),
        "results": out,
    }
