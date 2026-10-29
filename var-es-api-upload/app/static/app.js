"use strict";

const METHODS = {
  historical: "Historical simulation",
  normal: "Normal (variance–covariance)",
  student_t: "Student-t",
  monte_carlo: "Monte Carlo",
  filtered_historical: "Filtered historical simulation",
};

// z-scores for the confidence levels offered on the page
const Z = { 0.95: 1.645, 0.975: 1.96, 0.99: 2.326, 0.995: 2.576 };

const DEFAULT_HOLDINGS = [
  ["SPY", 400000],
  ["QQQ", 200000],
  ["TLT", 250000],
  ["GLD", 150000],
];

const $ = (sel, el = document) => el.querySelector(sel);
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const usdCompact = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });
const pct = (x, d = 2) => `${(x * 100).toFixed(d)}%`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------- holdings form ---------- */

function parseMoney(text) {
  const n = Number(String(text).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : NaN;
}

function addRow(ticker = "", value = "") {
  const row = $("#row-template").content.firstElementChild.cloneNode(true);
  $(".ticker", row).value = ticker;
  $(".value", row).value = value === "" ? "" : Number(value).toLocaleString("en-US");
  $(".remove", row).addEventListener("click", () => {
    if ($("#rows").children.length > 1) row.remove();
    else { $(".ticker", row).value = ""; $(".value", row).value = ""; }
    updateTotal();
  });
  $(".value", row).addEventListener("input", updateTotal);
  $(".value", row).addEventListener("blur", (e) => {
    const n = parseMoney(e.target.value);
    if (e.target.value.trim() && Number.isFinite(n)) e.target.value = n.toLocaleString("en-US");
  });
  $("#rows").appendChild(row);
  return row;
}

function readHoldings() {
  return [...$("#rows").children].map((row) => ({
    row,
    ticker: $(".ticker", row).value.trim().toUpperCase(),
    value: parseMoney($(".value", row).value),
  }));
}

function updateTotal() {
  const total = readHoldings().reduce((s, h) => s + (h.value > 0 ? h.value : 0), 0);
  $("#total").textContent = usd.format(total);
}

function syncHorizon() {
  document.querySelectorAll('input[name="horizon-preset"]').forEach((r) => {
    r.addEventListener("change", () => { $("#horizon").value = r.value; });
  });
  $("#horizon").addEventListener("input", () => {
    const v = $("#horizon").value;
    document.querySelectorAll('input[name="horizon-preset"]').forEach((r) => { r.checked = r.value === v; });
  });
}

function alphaHint() {
  const a = Number(document.querySelector('input[name="alpha"]:checked').value);
  const n = Math.round(1 / (1 - a));
  $("#alpha-hint").textContent = `The loss should be exceeded about once every ${n} periods.`;
}

function showError(msg) {
  const el = $("#form-error");
  el.textContent = msg;
  el.hidden = !msg;
}

function validate() {
  const holdings = readHoldings().filter((h) => h.ticker || $(".value", h.row).value.trim());
  readHoldings().forEach((h) => {
    $(".ticker", h.row).removeAttribute("aria-invalid");
    $(".value", h.row).removeAttribute("aria-invalid");
  });
  if (!holdings.length) return "Add at least one instrument.";
  const seen = new Set();
  for (const h of holdings) {
    if (!h.ticker) { $(".ticker", h.row).setAttribute("aria-invalid", "true"); return "Every row needs a ticker."; }
    if (!(h.value > 0)) { $(".value", h.row).setAttribute("aria-invalid", "true"); return `Enter a value above 0 for ${h.ticker}.`; }
    if (seen.has(h.ticker)) { $(".ticker", h.row).setAttribute("aria-invalid", "true"); return `${h.ticker} is listed twice. Combine the rows.`; }
    seen.add(h.ticker);
  }
  const horizon = Number($("#horizon").value);
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > 250) return "Time horizon must be a whole number of trading days from 1 to 250.";
  const win = Number($("#window").value);
  if (!Number.isInteger(win) || win < 100 || win > 5000) return "Days of history must be between 100 and 5000.";
  if (!$("#start").value) return "Pick a start date for the price download.";
  return { holdings, horizon, win };
}

/* ---------- API ---------- */

async function post(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    let msg = data.detail;
    if (Array.isArray(msg)) msg = msg.map((d) => String(d.msg).replace(/^Value error, /, "")).join(" ");
    throw new Error(msg || `The server returned an error (${res.status}).`);
  }
  return data;
}

async function onSubmit(e) {
  e.preventDefault();
  const v = validate();
  if (typeof v === "string") { showError(v); return; }
  showError("");

  const body = {
    tickers: v.holdings.map((h) => h.ticker),
    values: v.holdings.map((h) => h.value),
    alpha: Number(document.querySelector('input[name="alpha"]:checked').value),
    horizon_days: v.horizon,
    window: v.win,
    start: $("#start").value,
  };

  const btn = $("#submit");
  btn.disabled = true;
  btn.textContent = "Calculating…";
  $("#results").innerHTML = `<p class="loading">Downloading prices and running five models…</p>`;
  try {
    const res = await post("/var", body);
    renderResults(res, body);
  } catch (err) {
    $("#results").innerHTML = "";
    showError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Calculate risk";
  }
}

/* ---------- results ---------- */

function horizonText(h) {
  const named = { 1: "the next trading day", 5: "the next week", 10: "the next two weeks", 21: "the next month" };
  return named[h] || `the next ${h} trading days`;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function renderResults(res, req) {
  const a = res.alpha;
  const h = res.horizon_days;
  const chance = pct(1 - a, a === 0.975 ? 1 : 0);
  const r = res.results;
  const vars = Object.values(r).map((x) => x.var_usd);
  const ess = Object.values(r).map((x) => x.es_usd);
  const lo = Math.min(...vars), hi = Math.max(...vars);
  const nameOf = (v) => METHODS[Object.keys(r).find((m) => r[m].var_usd === v)];
  const spread = vars.length > 1
    ? `The five methods give between ${usd.format(lo)} (${nameOf(lo)}) and ${usd.format(hi)} (${nameOf(hi)}); the figure above is the middle of the five.`
    : "";
  const dates = res.data_from ? `from ${res.data_from} to ${res.data_to}` : "";

  $("#results").innerHTML = `
    <div class="results-body">
      <p class="answer">There is a ${chance} chance that this ${usd.format(res.portfolio_value)} portfolio
        loses more than <span class="amount">${usd.format(median(vars))}</span> over ${horizonText(h)}.</p>
      <p class="context">${spread} If a loss that large does happen, it averages
        ${usd.format(Math.min(...ess))} to ${usd.format(Math.max(...ess))} (the Expected Shortfall).
        Based on the last ${res.observations} trading days ${dates}; annual volatility ${pct(res.annualised_vol, 1)}.</p>

      <div class="chart-block">
        <h3>Gains and losses on past days${h > 1 ? `, scaled to ${h} days` : ""}</h3>
        <p class="chart-caption">Each bar counts how many days had that profit or loss. Each coloured line is one
          method’s VaR. Red bars are the days that lost more than the historical VaR.</p>
        <div class="chart" id="chart"></div>
      </div>

      <div class="table-block">
        <h3>Results by method</h3>
        <div class="scroll">
          <table>
            <thead><tr><th>Method</th><th>VaR</th><th>VaR %</th><th>Expected Shortfall</th><th>ES ÷ VaR</th></tr></thead>
            <tbody>
              ${Object.entries(r).map(([m, x]) => `
                <tr data-method="${m}">
                  <td><span class="swatch" style="background:var(--m-${m})"></span><a href="#method-${m}">${METHODS[m]}</a></td>
                  <td>${usd.format(x.var_usd)}</td>
                  <td>${pct(x.var_pct)}</td>
                  <td>${usd.format(x.es_usd)}</td>
                  <td>${x.es_to_var ?? "–"}</td>
                </tr>`).join("")}
            </tbody>
          </table>
        </div>
        <p class="table-note">ES ÷ VaR shows how much worse the worst days are than the VaR line.
          A higher ratio means a fatter tail.</p>
      </div>

      <div class="holdings-block">
        <h3>Holdings used</h3>
        <div class="scroll">
          <table>
            <thead><tr><th>Ticker</th><th>Value</th><th>Weight</th><th>Annual volatility</th></tr></thead>
            <tbody>
              ${res.assets.map((s) => `
                <tr><td>${esc(s.name)}</td><td>${usd.format(s.value)}</td><td>${pct(s.weight, 1)}</td><td>${pct(s.annualised_vol, 1)}</td></tr>`).join("")}
            </tbody>
          </table>
        </div>
      </div>

      <div class="methods">
        <h2>How each method works</h2>
        ${Object.entries(r).map(([m, x]) => methodSection(m, x, res, req)).join("")}
      </div>
    </div>`;

  drawChart(res);
  wireTable();
}

function methodSection(m, x, res, req) {
  const t = explain(m, x, res);
  return `
    <section class="method" id="method-${m}" style="--method-color:var(--m-${m})">
      <h3>${METHODS[m]}</h3>
      <dl class="method-figures">
        <div><dt>VaR</dt><dd>${usd.format(x.var_usd)}</dd></div>
        <div><dt>Expected Shortfall</dt><dd>${usd.format(x.es_usd)}</dd></div>
        ${t.figure ? `<div><dt>${t.figure[0]}</dt><dd>${t.figure[1]}</dd></div>` : ""}
      </dl>
      <div class="method-text">
        <p>${t.how}</p>
        ${t.formula ? `<p class="formula">${t.formula}</p>` : ""}
        <h4>What it assumes</h4>
        <p>${t.assumes}</p>
        <h4>When it can mislead</h4>
        <p>${t.caveat}</p>
      </div>
    </section>`;
}

function explain(m, x, res) {
  const a = res.alpha;
  const obs = res.observations;
  const tail = Math.max(1, Math.floor(obs * (1 - a)));
  const tailPct = pct(1 - a, a === 0.975 ? 1 : 0);
  const d = x.details || {};

  switch (m) {
    case "historical":
      return {
        how: `Takes the last ${obs} days of real returns for each holding, applies them to today’s portfolio, and sorts the
          resulting gains and losses. VaR is the loss that only ${tailPct} of those days exceeded, which here is about
          ${tail} days. Expected Shortfall is the average loss on those ${tail} worst days.`,
        assumes: `Tomorrow will look like a day picked at random from the window. It makes no assumption about the shape of the distribution.`,
        caveat: `It cannot produce a loss bigger than the worst day in the window, and it reacts slowly: if the window was calm, VaR stays low even after markets turn.
          ${tail < 10 ? `With only ${tail} days in the tail, the Expected Shortfall rests on very few observations.` : ""}`,
      };
    case "normal":
      return {
        how: `Fits a bell curve to the portfolio’s daily returns using their average (μ) and standard deviation (σ), then reads the
          loss off the curve at the ${pct(a, a === 0.975 ? 1 : 0)} point.`,
        formula: `VaR = z·σ − μ &nbsp;&nbsp; ES = σ·φ(z) ⁄ (1 − α) − μ &nbsp;&nbsp; with z = ${Z[a] ?? "Φ⁻¹(α)"}`,
        assumes: `Returns follow a normal distribution and volatility is constant.`,
        caveat: `Real returns have fatter tails than a bell curve, so this method usually understates the worst days. Its ES ÷ VaR
          ratio (${x.es_to_var}) is fixed by the formula, not by your data, which makes it a useful baseline for the other methods.`,
      };
    case "student_t": {
      const nu = d.degrees_of_freedom;
      return {
        figure: ["Degrees of freedom ν", nu],
        how: `Replaces the bell curve with a Student-t distribution, which gives extreme days more weight. Tail thickness is set by
          the degrees of freedom ν, fitted to your data by maximum likelihood while keeping the sample’s volatility fixed. Here
          ν = ${nu}. Lower means fatter tails; a normal curve is the limit as ν grows large.`,
        assumes: `Returns follow a Student-t distribution with constant volatility. ν is kept between 3 and 50 so the fit stays stable.`,
        caveat: `It handles fat tails better than the normal model, but it is still symmetric and ignores whether markets are calm or stressed right now.
          ${nu <= 3.2 ? "The fit hit the lower limit of 3, which means the data has very heavy tails." : ""}`,
      };
    }
    case "monte_carlo":
      return {
        figure: ["Simulated days", (d.scenarios || 10000).toLocaleString("en-US")],
        how: `Generates ${(d.scenarios || 10000).toLocaleString("en-US")} possible days. Each simulated day draws returns for all
          holdings at once from their average returns and covariance matrix (using a Cholesky factor), so assets that tend to fall
          together also fall together in the simulation. Shocks come from a Student-t with ${d.degrees_of_freedom || 5} degrees of freedom
          for fat tails. VaR and ES are then read from the simulated losses, as in historical simulation.`,
        assumes: `The volatilities and correlations measured over the window hold tomorrow, with the same tail thickness (ν = ${d.degrees_of_freedom || 5}) for every asset.`,
        caveat: `The result is only as good as the model fed into it. In a crash, correlations often jump towards 1, which a fixed
          covariance matrix misses. The random seed is fixed, so the same inputs always give the same numbers.`,
      };
    case "filtered_historical": {
      const cur = d.current_daily_vol, avg = d.average_daily_vol;
      const dir = cur > avg ? "higher" : "lower";
      const hist = res.results.historical;
      return {
        figure: ["Daily volatility now vs average", `${pct(cur)} vs ${pct(avg)}`],
        how: `Works like historical simulation, but first rescales every past day to today’s volatility. Volatility is tracked
          with an exponentially weighted moving average (EWMA, λ = 0.94, the RiskMetrics standard), so recent days count most.
          Each past return is divided by the volatility at that time and multiplied by today’s. Volatility is ${dir} now than
          its window average${hist ? `, so this VaR is ${x.var_usd > hist.var_usd ? "above" : "below"} the plain historical one` : ""}.`,
        assumes: `The shape of past shocks repeats, but their size follows current volatility.`,
        caveat: `It reacts quickly, which helps in a crisis but means the number can swing from one day to the next. λ = 0.94 is a
          market convention, not fitted to your portfolio.`,
      };
    }
    default:
      return { how: "", assumes: "", caveat: "" };
  }
}

/* ---------- chart ---------- */

function drawChart(res) {
  const W = 720, H = 260, P = { l: 8, r: 8, t: 12, b: 28 };
  const { edges, counts } = res.pnl_histogram;
  const varLines = Object.entries(res.results).map(([m, x]) => [m, -x.var_usd]);
  const xmin = Math.min(edges[0], ...varLines.map(([, v]) => v * 1.05));
  const xmax = edges[edges.length - 1];
  const cmax = Math.max(...counts);
  const sx = (v) => P.l + ((v - xmin) / (xmax - xmin)) * (W - P.l - P.r);
  const sy = (c) => H - P.b - (c / cmax) * (H - P.t - P.b);
  const histVar = res.results.historical ? -res.results.historical.var_usd : Math.max(...varLines.map(([, v]) => v));

  const bars = counts.map((c, i) => {
    if (!c) return "";
    const x0 = sx(edges[i]), x1 = sx(edges[i + 1]);
    const tail = edges[i + 1] <= histVar + 1e-9;
    return `<rect class="bar${tail ? " tail" : ""}" x="${x0 + 0.5}" y="${sy(c)}" width="${Math.max(x1 - x0 - 1, 1)}" height="${H - P.b - sy(c)}"></rect>`;
  }).join("");

  const ticks = niceTicks(xmin, xmax, 6).map((v) => `
    <line class="axis" x1="${sx(v)}" x2="${sx(v)}" y1="${H - P.b}" y2="${H - P.b + 4}"></line>
    <text class="tick" x="${sx(v)}" y="${H - 8}" text-anchor="middle">${v === 0 ? "$0" : usdCompact.format(v).replace("-", "−")}</text>`).join("");

  const zero = xmin < 0 && xmax > 0 ? `<line class="zero" x1="${sx(0)}" x2="${sx(0)}" y1="${P.t}" y2="${H - P.b}"></line>` : "";

  const lines = varLines.map(([m, v]) => `
    <line class="var-line" data-method="${m}" x1="${sx(v)}" x2="${sx(v)}" y1="${P.t}" y2="${H - P.b}" style="stroke:var(--m-${m})">
      <title>${METHODS[m]} VaR: ${usd.format(-v)}</title>
    </line>`).join("");

  $("#chart").innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Histogram of past profit and loss with each method's VaR marked">
      ${bars}
      <line class="axis" x1="${P.l}" x2="${W - P.r}" y1="${H - P.b}" y2="${H - P.b}"></line>
      ${ticks}${zero}${lines}
    </svg>`;
}

function niceTicks(min, max, count) {
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((s) => span / s <= count) || 10 * mag;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) out.push(Math.round(v / step) * step);
  return out;
}

function wireTable() {
  const rows = document.querySelectorAll(".table-block tbody tr");
  const lines = document.querySelectorAll(".var-line");
  const focus = (m) => lines.forEach((l) => l.classList.toggle("dim", m && l.dataset.method !== m));
  rows.forEach((row) => {
    row.addEventListener("mouseenter", () => { row.classList.add("active"); focus(row.dataset.method); });
    row.addEventListener("mouseleave", () => { row.classList.remove("active"); focus(null); });
  });
}

/* ---------- start ---------- */

DEFAULT_HOLDINGS.forEach(([t, v]) => addRow(t, v));
updateTotal();
syncHorizon();
alphaHint();
document.querySelectorAll('input[name="alpha"]').forEach((r) => r.addEventListener("change", alphaHint));
$("#add-row").addEventListener("click", () => $(".ticker", addRow()).focus());
$("#portfolio-form").addEventListener("submit", onSubmit);
