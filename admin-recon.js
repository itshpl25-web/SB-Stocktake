/* StockTake Admin: Reconciliation (step 3)
   Live comparison of counted quantity against the MI24 book quantity for the selected
   outlet (and department, if one is chosen). Search, filter chips (variance, zero count,
   unmatched), sortable columns, paged fetching so the 1000-row cap can never truncate. */
(function () {
  "use strict";
  var App = window.StockTakeAdmin;
  if (!App) return;
  var Scoped = App.Scoped, esc = App.esc, icon = App.icon;
  function $(s, r) { return (r || document).querySelector(s); }

  var SHOW = 300; // rows drawn at a time; the totals always cover every filtered row

  function fresh() {
    return {
      key: null, rows: [], un: [], loaded: false, loading: false, error: null,
      q: "", mode: "all", sort: { k: "material", d: 1 }, limit: SHOW
    };
  }
  var S = fresh();

  function curKey() { return String(App.outletId) + "|" + String(App.deptId); }
  function pill(kind, text) { return '<span class="pill ' + kind + '"><i></i>' + esc(text) + "</span>"; }
  function num(v) { var n = Number(v); return isNaN(n) ? 0 : n; }
  function fmt(n) { return Number(n).toLocaleString("en-US", { maximumFractionDigits: 3 }); }

  /* ---------- loading ---------- */
  function fetchView(table, orderCols) {
    return App.fetchAllPages(function (a, b) {
      var q = Scoped.select(table, "*");
      if (App.deptId) q = q.eq("department_id", App.deptId);
      orderCols.forEach(function (c) { q = q.order(c); });
      return q.range(a, b);
    });
  }
  function load(silent) {
    var mine = S, key = S.key;
    if (!silent) { S.loading = true; S.error = null; renderTable(); }
    return Promise.all([
      fetchView("reconciliation", ["department_id", "material", "description", "book_quantity"]),
      fetchView("unmatched_scans", ["department_id", "material", "description"])
    ]).then(function (r) {
      if (mine !== S || key !== S.key) return; // outlet or department changed while loading
      S.rows = r[0].map(function (x) {
        var counted = num(x.qty_counted), book = num(x.book_quantity); // a blank book quantity counts as 0
        return { material: x.material, desc: x.description || "", dept: x.department, deptId: x.department_id, uom: x.base_uom || "", book: book, counted: counted, variance: counted - book };
      });
      S.un = r[1].map(function (x) {
        return { material: x.material, desc: x.description || "", dept: x.department, deptId: x.department_id, counted: num(x.qty_counted) };
      });
      S.loaded = true; S.loading = false; S.error = null;
      renderBanner(); renderChips(); renderTable(); updateBadge();
    }).catch(function (e) {
      if (mine !== S || key !== S.key) return;
      S.loading = false;
      if (!S.loaded) S.error = (e && e.message) || String(e);
      renderTable();
      if (silent) App.handleError(e);
    });
  }
  function updateBadge() {
    if (S.un.length) App.badges.recon = { text: S.un.length + " unmatched", warn: true };
    else delete App.badges.recon;
    App.renderNav();
  }

  /* ---------- filtering + sorting ---------- */
  function textMatch(r) {
    var q = S.q.trim().toLowerCase();
    return !q || (r.material + " " + r.desc).toLowerCase().indexOf(q) > -1;
  }
  function statusRank(r) { return r.counted === 0 ? 2 : (r.variance !== 0 ? 1 : 0); }
  var GET = {
    material: function (r) { return r.material; },
    desc: function (r) { return r.desc; },
    dept: function (r) { return r.dept || ""; },
    uom: function (r) { return r.uom || ""; },
    book: function (r) { return r.book; },
    counted: function (r) { return r.counted; },
    variance: function (r) { return r.variance; },
    status: statusRank
  };
  function visible(cols) {
    var pool = S.mode === "unmatched" ? S.un : S.rows;
    var rows = pool.filter(textMatch);
    if (S.mode === "variance") rows = rows.filter(function (r) { return r.variance !== 0; });
    if (S.mode === "zero") rows = rows.filter(function (r) { return r.counted === 0; });
    var k = S.sort.k; if (!cols.some(function (c) { return c.k === k; })) k = "material";
    var g = GET[k], d = S.sort.d;
    return rows.slice().sort(function (a, b) {
      var x = g(a), y = g(b);
      var c = typeof x === "string" ? x.localeCompare(y, undefined, { numeric: true }) : x - y;
      return c * d;
    });
  }

  /* ---------- page ---------- */
  function render(root) {
    if (S.key !== curKey()) { S.key = curKey(); S.loaded = false; S.loading = false; S.rows = []; S.un = []; S.limit = SHOW; }
    root.innerHTML = App.pageHead("Reconciliation",
      "Live comparison of counted quantity against the MI24 book quantity for " + App.outletName() + " · " + (App.deptName() || "all departments") +
      ". Corrections made in Sessions show here straight away. Counted quantity is in base units (count × numerator).") +
      '<div id="r-banner"></div><section class="panel"><div class="toolbar">' +
      '<label class="search">' + icon("search") + '<input type="text" id="r-search" placeholder="Search material or description" aria-label="Search reconciliation"></label>' +
      '<div class="chips" id="r-chips"></div><span class="sp muted small mono" id="r-sum"></span></div>' +
      '<div class="tablewrap" id="r-table"></div></section>';
    $("#r-search").value = S.q;
    renderBanner(); renderChips(); renderTable();
    if (!S.loaded && !S.loading) load(false);
  }
  /* A department with scans but no MI24 rows has no book list, so every scan there shows as unmatched. */
  function renderBanner() {
    var el = $("#r-banner"); if (!el) return;
    if (!S.loaded) { el.innerHTML = ""; return; }
    var withRows = {}, missing = {};
    S.rows.forEach(function (r) { withRows[r.deptId] = true; });
    S.un.forEach(function (r) { if (!withRows[r.deptId]) missing[r.dept] = true; });
    var names = Object.keys(missing).sort();
    el.innerHTML = names.length
      ? '<div class="note warn" style="margin-bottom:16px">' + icon("alert") + "<span>No MI24 book list for " + esc(names.join(", ")) +
        ", so everything scanned there shows as unmatched. <button type=\"button\" class=\"linkbtn\" data-rx=\"uploads\">Go to Uploads</button></span></div>"
      : "";
  }
  function renderChips() {
    var el = $("#r-chips"); if (!el) return;
    var base = S.rows.filter(textMatch);
    var chips = [
      ["all", "All lines", base.length],
      ["variance", "Variance", base.filter(function (r) { return r.variance !== 0; }).length],
      ["zero", "Zero count", base.filter(function (r) { return r.counted === 0; }).length],
      ["unmatched", "Unmatched", S.un.filter(textMatch).length]
    ];
    el.innerHTML = chips.map(function (c) {
      return '<button type="button" data-rx="mode" data-v="' + c[0] + '" aria-pressed="' + (S.mode === c[0]) + '">' + c[1] + " <b>" + c[2] + "</b></button>";
    }).join("");
  }
  function renderTable() {
    var el = $("#r-table"); if (!el) return;
    if (S.loading && !S.loaded) { el.innerHTML = '<div class="empty">Loading reconciliation…</div>'; $("#r-sum").textContent = ""; return; }
    if (S.error && !S.loaded) { el.innerHTML = '<div class="empty">Could not load reconciliation: ' + esc(S.error) + ' <button type="button" class="btn sm" data-rx="reload">Retry</button></div>'; return; }
    var unm = S.mode === "unmatched", showDept = !App.deptId;
    var cols = [{ k: "material", l: "Material" }, { k: "desc", l: "Description" }];
    if (showDept) cols.push({ k: "dept", l: "Department" });
    if (unm) cols.push({ k: "counted", l: "Qty counted", n: 1 });
    else cols.push({ k: "uom", l: "UOM" }, { k: "book", l: "Book qty", n: 1 }, { k: "counted", l: "Qty counted", n: 1 }, { k: "variance", l: "Variance", n: 1 }, { k: "status", l: "Status" });
    var rows = visible(cols), shown = rows.slice(0, S.limit);
    var head = cols.map(function (c) {
      var on = S.sort.k === c.k;
      return '<th class="' + (c.n ? "num" : "") + '" aria-sort="' + (on ? (S.sort.d === 1 ? "ascending" : "descending") : "none") + '">' +
        '<button type="button" class="thbtn" data-rx-sort="' + c.k + '">' + c.l + '<span class="arr">' + (on ? (S.sort.d === 1 ? "▲" : "▼") : "") + "</span></button></th>";
    }).join("");
    var body = shown.map(function (r) {
      var tint = !unm && r.counted > 0 && r.variance !== 0 ? "tint-warn" : "";
      var t = '<tr class="' + tint + '"><td class="mono">' + esc(r.material) + "</td><td>" + esc(r.desc) + "</td>" + (showDept ? "<td>" + esc(r.dept) + "</td>" : "");
      if (unm) return t + '<td class="num">' + fmt(r.counted) + "</td></tr>";
      var v = r.variance > 0 ? "+" + fmt(r.variance) : (r.variance < 0 ? "−" + fmt(Math.abs(r.variance)) : "0");
      var vc = r.variance < 0 ? "v-neg" : (r.variance > 0 ? "v-pos" : "");
      var sp = r.counted === 0 ? pill("crit", "Zero count") : (r.variance !== 0 ? pill("warn", "Variance") : pill("ok", "Matches"));
      return t + "<td>" + esc(r.uom) + '</td><td class="num">' + fmt(r.book) + '</td><td class="num">' + fmt(r.counted) + '</td><td class="num ' + vc + '">' + v + "</td><td>" + sp + "</td></tr>";
    }).join("");
    if (!rows.length) body = '<tr><td colspan="' + cols.length + '" class="empty">' + (unm
      ? "None. Every scanned item is in the MI24 book list."
      : (S.rows.length || S.un.length ? "No lines match these filters." : "No MI24 data and no scans for this selection yet.")) + "</td></tr>";
    if (rows.length > shown.length) {
      body += '<tr><td colspan="' + cols.length + '" class="more">Showing ' + shown.length + " of " + rows.length + ' lines. <button type="button" class="btn sm" data-rx="more">Show ' + Math.min(SHOW, rows.length - shown.length) + ' more</button>' +
        '<button type="button" class="btn sm" data-rx="all">Show all</button></td></tr>';
    }
    el.innerHTML = '<table class="dt"><thead><tr>' + head + "</tr></thead><tbody>" + body + "</tbody></table>";
    var counted = rows.reduce(function (a, r) { return a + r.counted; }, 0);
    $("#r-sum").textContent = unm
      ? rows.length + " lines · " + fmt(counted) + " counted"
      : rows.length + " lines · " + fmt(counted) + " counted · " + fmt(rows.reduce(function (a, r) { return a + r.book; }, 0)) + " book";
  }

  /* ---------- events ---------- */
  var ACT = {
    mode: function (d) { S.mode = d.v; S.limit = SHOW; renderChips(); renderTable(); },
    reload: function () { load(false); },
    more: function () { S.limit += SHOW; renderTable(); },
    all: function () { S.limit = Infinity; renderTable(); },
    uploads: function () { App.go("uploads"); }
  };
  document.addEventListener("click", function (e) {
    var so = e.target.closest("[data-rx-sort]");
    if (so) {
      var k = so.dataset.rxSort;
      if (S.sort.k === k) S.sort.d *= -1; else { S.sort.k = k; S.sort.d = 1; }
      renderTable();
      var again = document.querySelector('[data-rx-sort="' + k + '"]'); if (again) again.focus();
      return;
    }
    var t = e.target.closest("[data-rx]");
    if (t && ACT[t.dataset.rx]) ACT[t.dataset.rx](t.dataset, t);
  });
  document.addEventListener("input", function (e) {
    if (e.target.id === "r-search") { S.q = e.target.value; S.limit = SHOW; renderChips(); renderTable(); }
  });

  App.register("recon", {
    render: render,
    refresh: function () { return load(true); },
    reset: function () { S = fresh(); }
  });
})();
