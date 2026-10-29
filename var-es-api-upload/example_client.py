"""Call the API from Python. Start the app first: uvicorn app.main:app"""
import requests

URL = "http://127.0.0.1:8000"

portfolio = {
    "tickers": ["SPY", "QQQ", "TLT", "GLD"],
    "values": [400_000, 200_000, 250_000, 150_000],   # dollars in each
    "alpha": 0.99,
    "horizon_days": 1,
}

risk = requests.post(f"{URL}/var", json=portfolio, timeout=120).json()
print(f"Portfolio ${risk['portfolio_value']:,.0f}, annualised vol {risk['annualised_vol']:.1%}\n")
for method, r in risk["results"].items():
    print(f"{method:<20} VaR ${r['var_usd']:>10,.0f}   ES ${r['es_usd']:>10,.0f}")
