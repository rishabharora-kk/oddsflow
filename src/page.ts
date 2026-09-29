/** The single static HTML page (inline CSS and JS). Market titles are untrusted text: the client only ever uses textContent. */
export const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>oddsflow</title>
<style>
  :root {
    --bg: #0f1216; --panel: #171b21; --line: #262c35; --text: #e6e9ee; --muted: #8b95a3;
    --pos: #3ecf8e; --neg: #f0616d; --warn: #e0b341; --link: #7db4ff;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg: #f6f7f9; --panel: #ffffff; --line: #dde1e7; --text: #1b2028; --muted: #5d6673;
      --pos: #12915a; --neg: #cf2f3e; --warn: #9a6c00; --link: #1a5fd0; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  header, main, footer { max-width: 1200px; margin: 0 auto; padding: 0 16px; }
  header { padding-top: 20px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: var(--muted); margin: 0 0 12px; }
  .banner { background: var(--panel); border: 1px solid var(--line); border-left: 4px solid var(--warn); padding: 8px 12px; border-radius: 6px; margin: 8px 0; }
  .status { color: var(--muted); font-size: 13px; margin: 8px 0; display: flex; flex-wrap: wrap; gap: 4px 16px; align-items: center; }
  .status .bad { color: var(--neg); font-weight: 600; }
  .status label { cursor: pointer; }
  .wrap { overflow-x: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
  table { border-collapse: collapse; width: 100%; min-width: 900px; }
  th, td { padding: 8px 10px; text-align: right; border-bottom: 1px solid var(--line); white-space: nowrap; }
  th:first-child, td:first-child { text-align: left; white-space: normal; min-width: 280px; max-width: 460px; }
  th { position: sticky; top: 0; background: var(--panel); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .03em; color: var(--muted); cursor: pointer; user-select: none; }
  th[aria-sort="ascending"]::after { content: " \25B2"; }
  th[aria-sort="descending"]::after { content: " \25BC"; }
  a { color: var(--link); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .pos { color: var(--pos); font-weight: 600; }
  .neg { color: var(--neg); font-weight: 600; }
  .muted { color: var(--muted); }
  .dim { opacity: .5; }
  .badge { display: inline-block; font-size: 11px; padding: 0 6px; border-radius: 9px; border: 1px solid var(--line); color: var(--muted); margin-left: 6px; }
  .badge.stale { color: var(--warn); border-color: var(--warn); font-weight: 600; }
  .badge.low { color: var(--warn); border-color: var(--warn); }
  .badge.high { color: var(--pos); border-color: var(--pos); }
  button.why { background: none; border: 1px solid var(--line); color: var(--muted); border-radius: 4px; font-size: 11px; padding: 0 6px; margin-left: 6px; cursor: pointer; }
  tr.detail td { text-align: left; white-space: normal; background: var(--bg); }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 14px; margin: 4px 0; }
  dt { color: var(--muted); }
  dd { margin: 0; word-break: break-all; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  footer { color: var(--muted); font-size: 13px; padding-top: 16px; padding-bottom: 28px; display: flex; gap: 16px; flex-wrap: wrap; }
  .empty { padding: 24px; text-align: center; color: var(--muted); }
</style>
</head>
<body>
<header>
  <h1>oddsflow</h1>
  <p class="sub">Fair probabilities for Panta price markets, computed from live Solana DEX prices and realised volatility.</p>
  <div class="banner" role="note">Read-only analytics. Not financial advice.</div>
  <div class="status" id="status" aria-live="polite"></div>
</header>
<main>
  <div class="wrap">
    <table id="tbl">
      <thead><tr id="head"></tr></thead>
      <tbody id="body"></tbody>
    </table>
    <div class="empty" id="empty" hidden></div>
  </div>
</main>
<footer><span>Powered by Panta</span><span>Data: Solami</span></footer>
<script>
(function () {
  "use strict";
  var COLS = [
    { key: "title", label: "Market", get: function (r) { return r.title; }, text: true },
    { key: "yes", label: "Panta YES", get: function (r) { return r.yes; } },
    { key: "fair", label: "Fair", get: function (r) { return r.fair; } },
    { key: "edge", label: "Edge", get: function (r) { return r.edge; } },
    { key: "spot", label: "Spot", get: function (r) { return r.spot; } },
    { key: "sigma", label: "σ (ann.)", get: function (r) { return r.sigma; } },
    { key: "left", label: "Time left", get: function (r) { return r.expiry === null ? null : r.expiry - Date.now() / 1000; } },
    { key: "conf", label: "Confidence", get: function (r) { return r.confidence === "high" ? 2 : r.confidence === "low" ? 1 : null; } },
    { key: "asOf", label: "Updated", get: function (r) { return r.asOf; } }
  ];
  var rows = [], status = null, sort = { key: "edge", dir: -1, abs: true }, open = {}, connected = false, lastPush = null, showAll = false;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function pct(x, d) { return x === null || x === undefined ? "—" : (x * 100).toFixed(d === undefined ? 1 : d) + "%"; }
  function usd(x) {
    if (x === null || x === undefined) return "—";
    var a = Math.abs(x);
    var d = a >= 1000 ? 0 : a >= 1 ? 2 : a >= 0.01 ? 4 : 8;
    return "$" + x.toLocaleString(undefined, { minimumFractionDigits: Math.min(d, 2), maximumFractionDigits: d });
  }
  function dur(sec) {
    if (sec === null || sec === undefined) return "—";
    if (sec <= 0) return "expired";
    var d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
    if (d > 0) return d + "d " + h + "h";
    if (h > 0) return h + "h " + m + "m";
    return m + "m";
  }
  function ago(sec) {
    if (sec === null || sec === undefined) return "—";
    var s = Math.max(0, Math.round(Date.now() / 1000 - sec));
    if (s < 90) return s + "s ago";
    if (s < 5400) return Math.round(s / 60) + "m ago";
    return Math.round(s / 3600) + "h ago";
  }

  function renderHead() {
    var tr = document.getElementById("head");
    tr.textContent = "";
    COLS.forEach(function (c) {
      var th = el("th", null, c.label);
      th.setAttribute("scope", "col");
      th.setAttribute("aria-sort", sort.key === c.key ? (sort.dir > 0 ? "ascending" : "descending") : "none");
      th.tabIndex = 0;
      var go = function () {
        if (sort.key === c.key) sort.dir = -sort.dir; else { sort.key = c.key; sort.dir = c.text ? 1 : -1; }
        sort.abs = c.key === "edge";
        render();
      };
      th.addEventListener("click", go);
      th.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
      tr.appendChild(th);
    });
  }

  function sorted() {
    var col = COLS.filter(function (c) { return c.key === sort.key; })[0] || COLS[0];
    var list = rows.filter(function (r) { return showAll || r.fair !== null || r.reason !== "unparsed"; });
    return list.slice().sort(function (a, b) {
      var x = col.get(a), y = col.get(b);
      if (x === null || x === undefined) return (y === null || y === undefined) ? 0 : 1;
      if (y === null || y === undefined) return -1;
      if (sort.abs) { x = Math.abs(x); y = Math.abs(y); }
      if (col.text) return sort.dir * String(x).localeCompare(String(y));
      return sort.dir * (x - y);
    });
  }

  function whyPanel(r) {
    var td = el("td"); td.colSpan = COLS.length;
    var dl = el("dl");
    function add(k, v) { if (v === null || v === undefined || v === "") return; dl.appendChild(el("dt", null, k)); var d = el("dd"); d.textContent = String(v); dl.appendChild(d); }
    var formula = {
      close_above: "P = N(d2), d2 = (ln(S/K) - sigma^2 T/2) / (sigma sqrt(T))",
      close_below: "P = 1 - N(d2), d2 = (ln(S/K) - sigma^2 T/2) / (sigma sqrt(T))",
      touch_above: "P = N((-b - sigma^2 T/2)/v) + (S/K) N((-b + sigma^2 T/2)/v), b = ln(K/S), v = sigma sqrt(T)",
      touch_below: "P = N((-b + sigma^2 T/2)/v) + (S/K) N((-b - sigma^2 T/2)/v), b = ln(S/K), v = sigma sqrt(T)",
      mcap_touch_above: "touch-above with K = target market cap / supply"
    };
    add("Contract", r.kind ? r.kind + " on " + r.asset : "not parsed (unsupported market)");
    add("Formula", r.kind ? formula[r.kind] : null);
    if (r.fair !== null) {
      add("S (spot)", r.spot);
      add("K (strike)", r.K);
      if (r.mcap !== null) add("Target market cap", r.mcap);
      add("sigma (annualised)", r.sigma);
      add("T (years)", r.T === null ? null : r.T.toFixed(6) + " (" + dur(r.expiry - Date.now() / 1000) + ")");
      add("Candles used", r.nCandles);
    } else {
      add("Why no fair value", r.reason);
    }
    add("Supply", r.supply);
    add("Mint", r.mint ? r.mint + (r.mintSource ? " (" + r.mintSource + ")" : "") : null);
    add("Spot as of", r.asOf ? new Date(r.asOf * 1000).toISOString() : null);
    add("Panta price as of", r.yesAsOf ? new Date(r.yesAsOf * 1000).toISOString() : null);
    if (r.staleReasons && r.staleReasons.length) add("Stale because", r.staleReasons.join("; "));
    if (!connected) add("Connection", "lost, showing last received data");
    (r.notes || []).forEach(function (n) { add("Note", n); });
    td.appendChild(dl);
    var tr = el("tr", "detail"); tr.appendChild(td);
    return tr;
  }

  function renderRow(r) {
    var tr = el("tr");
    var c0 = el("td");
    var a = el("a", null, r.title || r.marketId);
    if (/^https:\/\/www\.panta\.market\/market\//.test(r.url)) { a.href = r.url; a.target = "_blank"; a.rel = "noopener noreferrer"; }
    c0.appendChild(a);
    var b = el("button", "why", open[r.marketId] ? "hide" : "why");
    b.type = "button";
    b.setAttribute("aria-expanded", open[r.marketId] ? "true" : "false");
    b.addEventListener("click", function () { open[r.marketId] = !open[r.marketId]; render(); });
    c0.appendChild(b);
    if (r.fair !== null && isStale(r)) c0.appendChild(el("span", "badge stale", "stale"));
    tr.appendChild(c0);

    tr.appendChild(el("td", null, pct(r.yes)));
    tr.appendChild(el("td", r.fair !== null && isStale(r) ? "dim" : null, r.fair !== null ? pct(r.fair) : "—"));
    var edgeCls = "muted", edgeTxt = "—";
    if (r.edge !== null && r.fair !== null) {
      var pp = r.edge * 100;
      edgeTxt = (pp >= 0 ? "+" : "") + pp.toFixed(1) + " pp";
      edgeCls = isStale(r) ? "muted dim" : (pp >= 0.05 ? "pos" : pp <= -0.05 ? "neg" : "muted");
    }
    tr.appendChild(el("td", edgeCls, edgeTxt));
    tr.appendChild(el("td", null, usd(r.spot)));
    tr.appendChild(el("td", null, pct(r.sigma, 0)));
    tr.appendChild(el("td", null, r.expiry === null ? "—" : dur(r.expiry - Date.now() / 1000)));
    var tdc = el("td");
    if (r.fair !== null) tdc.appendChild(el("span", "badge " + (isStale(r) ? "low" : r.confidence), isStale(r) ? "low" : r.confidence));
    else tdc.appendChild(el("span", "muted", r.reason || "—"));
    tr.appendChild(tdc);
    var tdu = el("td", isStale(r) && r.fair !== null ? "muted" : null, r.asOf ? ago(r.asOf) : "—");
    tr.appendChild(tdu);
    return tr;
  }
  function isStale(r) { return r.stale || !connected; }

  function renderStatus() {
    var s = document.getElementById("status");
    s.textContent = "";
    if (!connected) s.appendChild(el("span", "bad", "Disconnected from server: data below is not live."));
    if (status) {
      s.appendChild(el("span", null, status.supported + " of " + status.markets + " markets supported"));
      if (status.streamMode) s.appendChild(el("span", null, "spot feed: " + (status.streamMode === "stream" ? "live stream" : "REST polling (15 s)")));
      if (status.error) s.appendChild(el("span", "bad", status.error));
      if (!status.hasPanta) s.appendChild(el("span", "bad", "PANTA_API_KEY is not set on the server."));
      if (!status.hasSolami) s.appendChild(el("span", "bad", "SOLAMI_API_KEY is not set on the server."));
    }
    if (lastPush) s.appendChild(el("span", null, "last update " + ago(lastPush)));
    var lab = el("label"); var cb = el("input"); cb.type = "checkbox"; cb.checked = showAll;
    cb.addEventListener("change", function () { showAll = cb.checked; if (showAll) fetchRows(true); render(); });
    lab.appendChild(cb); lab.appendChild(document.createTextNode(" show unsupported markets"));
    s.appendChild(lab);
  }

  function render() {
    renderHead();
    renderStatus();
    var body = document.getElementById("body");
    body.textContent = "";
    var list = sorted();
    list.forEach(function (r) {
      body.appendChild(renderRow(r));
      if (open[r.marketId]) body.appendChild(whyPanel(r));
    });
    var empty = document.getElementById("empty");
    empty.hidden = list.length > 0;
    empty.textContent = status && status.markets === 0 ? "No markets loaded yet." : "No rows to show.";
  }

  function fetchRows(all) {
    fetch("/api/rows" + (all ? "?all=1" : ""), { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (j) { rows = j; render(); }).catch(function () {});
  }
  function fetchStatus() {
    fetch("/api/status", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (j) { status = j; render(); }).catch(function () {});
  }

  function connect() {
    var es = new EventSource("/events");
    es.addEventListener("open", function () { connected = true; render(); });
    es.addEventListener("rows", function (ev) { try { rows = JSON.parse(ev.data); lastPush = Date.now() / 1000; connected = true; render(); } catch (e) {} });
    es.addEventListener("status", function (ev) { try { status = JSON.parse(ev.data); render(); } catch (e) {} });
    es.addEventListener("error", function () { connected = false; render(); });
  }

  render();
  fetchRows(false);
  fetchStatus();
  connect();
  setInterval(render, 5000);
})();
</script>
</body>
</html>
`;
