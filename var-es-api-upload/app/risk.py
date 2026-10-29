"""VaR / Expected Shortfall estimators. Losses are positive fractions."""
import numpy as np
from scipy import optimize, stats


def historical(r, alpha):
    losses = -np.asarray(r)
    var = np.quantile(losses, alpha)
    return var, losses[losses >= var].mean()


def normal(r, alpha):
    mu, sigma = np.mean(r), np.std(r, ddof=1)
    z = stats.norm.ppf(alpha)
    return -mu + sigma * z, -mu + sigma * stats.norm.pdf(z) / (1 - alpha)


def fit_nu(r, lo=3.0, hi=50.0):
    """MLE of degrees of freedom only, with mean and variance fixed to the sample.

    A free 3-parameter fit on ~500 days often lands near nu=2, which makes
    the variance nearly infinite and overstates VaR. Matching the variance
    and bounding nu keeps the estimate stable."""
    r = np.asarray(r)
    mu, sd = r.mean(), r.std(ddof=1)

    def nll(nu):
        scale = sd * np.sqrt((nu - 2) / nu)
        return -stats.t.logpdf(r, nu, loc=mu, scale=scale).sum()

    res = optimize.minimize_scalar(nll, bounds=(lo, hi), method="bounded")
    nu = float(res.x)
    return nu, mu, sd * np.sqrt((nu - 2) / nu)


def student_t(r, alpha):
    nu, loc, scale = fit_nu(r)
    q = stats.t.ppf(alpha, nu)
    var = -loc + scale * q
    es = -loc + scale * stats.t.pdf(q, nu) / (1 - alpha) * (nu + q**2) / (nu - 1)
    return var, es


def monte_carlo(asset_r, weights, alpha, n=10_000, nu=5, seed=42):
    rng = np.random.default_rng(seed)
    X = np.asarray(asset_r)
    if X.shape[1] == 1:
        cov = np.atleast_2d(np.var(X, ddof=1))
    else:
        cov = np.cov(X, rowvar=False)
    L = np.linalg.cholesky(cov * (nu - 2) / nu + 1e-12 * np.eye(len(cov)))
    z = rng.standard_normal((n, X.shape[1]))
    chi = rng.chisquare(nu, size=(n, 1))
    sims = X.mean(axis=0) + (z @ L.T) / np.sqrt(chi / nu)
    return historical(sims @ weights, alpha)


def ewma_vol(r, lam=0.94):
    r = np.asarray(r)
    var = np.empty_like(r)
    var[0] = r[:30].var()
    for t in range(1, len(r)):
        var[t] = lam * var[t - 1] + (1 - lam) * r[t - 1] ** 2
    return np.sqrt(var), np.sqrt(lam * var[-1] + (1 - lam) * r[-1] ** 2)


def filtered_historical(r, alpha):
    sig, sig_next = ewma_vol(r)
    return historical(np.asarray(r) / sig * sig_next, alpha)


METHODS = ["historical", "normal", "student_t", "monte_carlo", "filtered_historical"]


def estimate(method, port_r, asset_r, weights, alpha):
    if method == "historical":
        return historical(port_r, alpha)
    if method == "normal":
        return normal(port_r, alpha)
    if method == "student_t":
        return student_t(port_r, alpha)
    if method == "monte_carlo":
        return monte_carlo(asset_r, weights, alpha)
    if method == "filtered_historical":
        return filtered_historical(port_r, alpha)
    raise ValueError(f"unknown method {method}")
