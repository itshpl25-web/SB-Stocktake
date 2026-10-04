/* StockTake Admin: Reconciliation (step 3, with the Gondola Trace from the legacy admin)
   Live comparison of counted quantity against the MI24 book quantity for the selected
   outlet (and department, if one is chosen). Search, filter chips (variance, zero count,
   unmatched), sortable columns, paged fetching so the 1000-row cap can never truncate.
   Gondola Trace: for every material, which gondolas it was scanned in (summary on the row, every scan in a pop-up). */
(function () {
  "use strict";
  var App = window.StockTakeAdmin;
  if (!App) return;
  var Scoped = App.Scoped, esc = App.esc, icon = App.icon, toast = App.toast;
  function $(s, r) { return (r || document).querySelector(s); }

  var SHOW = 300; // rows drawn at a time; the totals always cover every filtered row

  function fresh() {
    return {
      key: null, rows: [], un: [], loaded: false, loading: false, error: null,
      q: "", mode: "all", sort: { k: "material", d: 1 }, limit: SHOW,
      trace: {}, traceError: null, traceKey: null, sapCols: false
    };
  }
  var S = fresh();

  function curKey() { return String(App.outletId) + "|" + String(App.deptId); }
  function pill(kind, text) { return '<span class="pill ' + kind + '"><i></i>' + esc(text) + "</span>"; }
  function num(v) { var n = Number(v); return isNaN(n) ? 0 : n; }
  function fmt(n) { return Number(n).toLocaleString("en-US", { maximumFractionDigits: 3 }); }

  /* ---------- gondola trace ---------- */
  function tkey(deptId, material) { return String(deptId) + "|" + String(material); }
  /* One line per gondola, summed: a quick "how much from where". The pop-up lists every single scan. */
  function traceSummary(rows) {
    if (!rows || !rows.length) return "—";
    var by = {}, order = [];
    rows.forEach(function (r) {
      if (!by[r.gondola_id]) { by[r.gondola_id] = { sum: 0, n: 0 }; order.push(r.gondola_id); }
      by[r.gondola_id].sum += num(r.qty); by[r.gondola_id].n++;
    });
    return order.map(function (g) { return g + ": " + fmt(by[g].sum) + (by[g].n > 1 ? " (" + by[g].n + " scans)" : ""); }).join(", ");
  }
  function stamp(iso) {
    var d = new Date(iso); if (isNaN(d.getTime())) return "";
    return d.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  }
  /* The trace for the selected outlet, one department at a time (the database function takes a single department). */
  function fetchTrace(deptIds) {
    var o = App.outletId;
    return Promise.all(deptIds.map(function (d) {
      return App.fetchAllPages(function (a, b) {
        return Scoped.rpc("department_scan_trace", { p_department_id: d }).order("material").order("gondola_id").order("scanned_at").range(a, b);
      }).then(function (rows) {
        rows.forEach(function (r) {
          if ((r.outlet_id != null && String(r.outlet_id) !== String(o)) || (r.department_id != null && String(r.department_id) !== String(d))) {
            throw new Error("Scans from another outlet or department came back, so the trace was blocked.");
          }
        });
        return { d: d, rows: rows };
      });
    }));
  }
  /* Barcodes: every distinct barcode actually scanned for the material (EA and carton both show if both were scanned).
     Materials with no scans fall back to their numerator-1 barcode from the MASTER LIST. */
  function fillBarcodes(deptIds) {
    var need = {};
    S.rows.forEach(function (r) { if (!r.barcode) (need[r.deptId] = need[r.deptId] || {})[r.material] = true; });
    var jobs = [];
    Object.keys(need).forEach(function (d) {
      var list = Object.keys(need[d]);
      for (var i = 0; i < list.length; i += 300) {
        (function (chunk) {
          jobs.push(Promise.resolve(App.sb.from("products").select("barcode,material,numerator").eq("department_id", d).in("material", chunk)).then(function (r) {
            if (r.error || !r.data) return;
            var best = {};
            r.data.forEach(function (p) { if (!best[p.material] || Number(p.numerator) === 1) best[p.material] = p.barcode; });
            S.rows.forEach(function (x) { if (String(x.deptId) === String(d) && !x.barcode && best[x.material]) x.barcode = best[x.material]; });
          }));
        })(list.slice(i, i + 300));
      }
    });
    return Promise.all(jobs);
  }
  function decorate(traceResults) {
    var map = {};
    traceResults.forEach(function (t) {
      t.rows.forEach(function (r) { (map[tkey(t.d, r.material)] = map[tkey(t.d, r.material)] || []).push(r); });
    });
    S.trace = map;
    S.rows.forEach(function (x) {
      var rows = map[tkey(x.deptId, x.material)] || [], seen = {}, codes = [], gs = {};
      rows.forEach(function (r) { if (r.barcode && !seen[r.barcode]) { seen[r.barcode] = 1; codes.push(r.barcode); } gs[r.gondola_id] = 1; });
      x.barcode = codes.join(", ");
      x.gondolas = Object.keys(gs).join(" ");
      x.traceText = traceSummary(rows);
    });
  }

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
      fetchView("sap_export", ["department_id", "material", "id"]),
      fetchView("unmatched_scans", ["department_id", "material", "description"])
    ]).then(function (r) {
      if (mine !== S || key !== S.key) return; // outlet or department changed while loading
      if (r[0].some(function (x) { return String(x.outlet_id) !== String(App.outletId); })) throw new Error("Rows from another outlet came back, so the reconciliation was blocked.");
      var rows = r[0].map(function (x) {
        var counted = num(x.qty_counted), book = num(x.book_quantity); // a blank book quantity counts as 0
        return { material: x.material, desc: x.description || "", dept: x.department, deptId: x.department_id, uom: x.base_uom || "", book: book, counted: counted, variance: counted - book, barcode: "", gondolas: "", traceText: "—",
          doc: x.phys_inventory_doc || "", item: x.item, batch: x.batch || "", plant: x.plant || "", sloc: x.storage_location || "", special: x.special_stock || "", cdate: x.count_date || "", zero: x.zero_count || "" };
      });
      var un = r[1].map(function (x) {
        return { material: x.material, desc: x.description || "", dept: x.department, deptId: x.department_id, counted: num(x.qty_counted) };
      });
      // the trace is extra detail: if it fails, the reconciliation itself must still show
      var deptIds = App.deptId ? [App.deptId] : Object.keys(rows.reduce(function (a, x) { a[x.deptId] = 1; return a; }, {}));
      return fetchTrace(deptIds).then(function (t) { return { t: t, err: null }; }, function (e) { return { t: [], err: (e && e.message) || String(e) }; }).then(function (tr) {
        if (mine !== S || key !== S.key) return;
        S.rows = rows; S.un = un; S.traceError = tr.err;
        decorate(tr.t);
        return fillBarcodes().catch(function () { /* barcodes are a convenience */ }).then(function () {
          if (mine !== S || key !== S.key) return;
          S.loaded = true; S.loading = false; S.error = null;
          renderBanner(); renderChips(); renderTable(); updateBadge();
        });
      });
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
    return !q || (r.material + " " + r.desc + " " + (r.barcode || "") + " " + (r.gondolas || "")).toLowerCase().indexOf(q) > -1;
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
    status: statusRank,
    barcode: function (r) { return r.barcode || ""; },
    doc: function (r) { return r.doc || ""; },
    item: function (r) { return num(r.item); },
    batch: function (r) { return r.batch || ""; },
    plant: function (r) { return r.plant || ""; },
    sloc: function (r) { return r.sloc || ""; },
    special: function (r) { return r.special || ""; },
    cdate: function (r) { return r.cdate || ""; }
  };
  /* The columns on screen. Same list drives the table, the sorting and the Excel file. */
  var SAPC = {
    doc: { k: "doc", l: "Phys. Inventory Doc." }, item: { k: "item", l: "Item", n: 1 }, batch: { k: "batch", l: "Batch" }, plant: { k: "plant", l: "Plant" },
    sloc: { k: "sloc", l: "Storage location" }, special: { k: "special", l: "Special Stock" }, cdate: { k: "cdate", l: "Count Date" }
  };
  function currentCols() {
    var showDept = !App.deptId, c = [];
    if (S.mode === "unmatched") {
      c.push({ k: "material", l: "Material" }, { k: "desc", l: "Description" });
      if (showDept) c.push({ k: "dept", l: "Department" });
      c.push({ k: "counted", l: "Qty counted", n: 1 });
      return c;
    }
    if (S.sapCols) c.push(SAPC.doc, SAPC.item);
    c.push({ k: "material", l: "Material" }, { k: "desc", l: "Description" });
    if (showDept) c.push({ k: "dept", l: "Department" });
    if (S.sapCols) c.push(SAPC.batch, SAPC.plant, SAPC.sloc, SAPC.special, SAPC.cdate);
    c.push({ k: "uom", l: "UOM" }, { k: "book", l: "Book qty", n: 1 }, { k: "counted", l: "Qty counted", n: 1 }, { k: "variance", l: "Variance", n: 1 }, { k: "status", l: "Status" },
      { k: "barcode", l: "Barcode" }, { k: "trace", l: "Gondola trace", ns: 1 }, { k: "act", l: "", ns: 1 });
    return c;
  }
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
      '<label class="search">' + icon("search") + '<input type="text" id="r-search" placeholder="Search material, description, barcode or gondola" aria-label="Search reconciliation"></label>' +
      '<div class="chips" id="r-chips"></div><button type="button" class="btn sm" id="r-sapbtn" data-rx="sapcols" aria-pressed="false">SAP columns</button>' +
      '<button type="button" class="btn sm" data-rx="xls">' + icon("exp") + 'Export to Excel</button><span class="sp muted small mono" id="r-sum"></span></div>' +
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
    var byDept = {}, emptyBook = [];
    S.rows.forEach(function (r) { var d = byDept[r.deptId] = byDept[r.deptId] || { name: r.dept, all0: true }; if (r.book !== 0) d.all0 = false; });
    Object.keys(byDept).forEach(function (k) { if (byDept[k].all0) emptyBook.push(byDept[k].name); });
    var enote = emptyBook.length ? '<div class="note warn" style="margin-bottom:16px">' + icon("alert") + "<span><b>Book quantities are all empty or 0 for " + esc(emptyBook.sort().join(", ")) +
      ".</b> This looks like the MI24 from before SAP posting, so Variance equals the counted quantity and is not meaningful yet. Re-upload the MI24 with the real book quantities to get a real variance. " +
      '<button type="button" class="linkbtn" data-rx="uploads">Go to Uploads</button></span></div>' : "";
    var tnote = S.traceError ? '<div class="note warn" style="margin-bottom:16px">' + icon("alert") + "<span>The gondola trace could not be loaded (" + esc(S.traceError) + "). The reconciliation below is complete; only the trace and barcode columns are affected. " +
      '<button type="button" class="linkbtn" data-rx="reload">Try again</button></span></div>' : "";
    el.innerHTML = enote + tnote + (names.length
      ? '<div class="note warn" style="margin-bottom:16px">' + icon("alert") + "<span>No MI24 book list for " + esc(names.join(", ")) +
        ", so everything scanned there shows as unmatched. <button type=\"button\" class=\"linkbtn\" data-rx=\"uploads\">Go to Uploads</button></span></div>"
      : "");
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
  function cell(r, c, unm) {
    switch (c.k) {
      case "material": return '<td class="mono">' + esc(r.material) + "</td>";
      case "desc": return "<td>" + esc(r.desc) + "</td>";
      case "dept": return "<td>" + esc(r.dept) + "</td>";
      case "uom": return "<td>" + esc(r.uom) + "</td>";
      case "book": return '<td class="num">' + fmt(r.book) + "</td>";
      case "counted": return '<td class="num">' + fmt(r.counted) + "</td>";
      case "variance":
        var v = r.variance > 0 ? "+" + fmt(r.variance) : (r.variance < 0 ? "\u2212" + fmt(Math.abs(r.variance)) : "0");
        return '<td class="num ' + (r.variance < 0 ? "v-neg" : (r.variance > 0 ? "v-pos" : "")) + '">' + v + "</td>";
      case "status": return "<td>" + (r.counted === 0 ? pill("crit", "Zero count") : (r.variance !== 0 ? pill("warn", "Variance") : pill("ok", "Matches"))) + "</td>";
      case "barcode": return '<td class="mono small">' + esc(r.barcode || "") + "</td>";
      case "trace": return '<td class="tracecell">' + esc(r.traceText) + "</td>";
      case "act": return '<td class="act"><button type="button" class="btn sm" data-rx="trace" data-k="' + esc(tkey(r.deptId, r.material)) + '" aria-label="Show every scan of ' + esc(r.material) + '">' + icon("search") + "Trace</button></td>";
      case "item": return '<td class="num">' + esc(r.item == null ? "" : r.item) + "</td>";
      default: return '<td class="' + (c.k === "doc" ? "mono small" : "") + '">' + esc(GET[c.k](r)) + "</td>";
    }
  }
  function renderTable() {
    var el = $("#r-table"); if (!el) return;
    var sb = $("#r-sapbtn"); if (sb) { sb.setAttribute("aria-pressed", String(S.sapCols)); sb.classList.toggle("on", S.sapCols); sb.hidden = S.mode === "unmatched"; }
    if (S.loading && !S.loaded) { el.innerHTML = '<div class="empty">Loading reconciliation…</div>'; $("#r-sum").textContent = ""; return; }
    if (S.error && !S.loaded) { el.innerHTML = '<div class="empty">Could not load reconciliation: ' + esc(S.error) + ' <button type="button" class="btn sm" data-rx="reload">Retry</button></div>'; return; }
    var unm = S.mode === "unmatched", cols = currentCols();
    var rows = visible(cols), shown = rows.slice(0, S.limit);
    var head = cols.map(function (c) {
      if (c.ns) return "<th>" + c.l + "</th>";
      var on = S.sort.k === c.k;
      return '<th class="' + (c.n ? "num" : "") + '" aria-sort="' + (on ? (S.sort.d === 1 ? "ascending" : "descending") : "none") + '">' +
        '<button type="button" class="thbtn" data-rx-sort="' + c.k + '">' + c.l + '<span class="arr">' + (on ? (S.sort.d === 1 ? "▲" : "▼") : "") + "</span></button></th>";
    }).join("");
    var body = shown.map(function (r) {
      var tint = !unm && r.counted > 0 && r.variance !== 0 ? "tint-warn" : "";
      return '<tr class="' + tint + '">' + cols.map(function (c) { return cell(r, c, unm); }).join("") + "</tr>";
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

  /* ---------- Excel export ---------- */
  function localDate() { var d = new Date(), p = function (n) { return (n < 10 ? "0" : "") + n; }; return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()); }
  /* Exports exactly what is on screen: the current search and filter, in the current sort order. */
  function exportExcel() {
    if (!S.loaded) { toast("The reconciliation is still loading.", "err"); return; }
    if (!window.XLSX) { toast("The Excel writer did not load. Check the connection and reload the page.", "err"); return; }
    var unm = S.mode === "unmatched", cols = currentCols(), rows = visible(cols);
    if (!rows.length) { toast("Nothing to export with these filters.", "err"); return; }
    var data, headers, sheet, prefix;
    if (unm) {
      headers = ["Department", "Material", "Material Description", "Qty Counted"]; sheet = "Unmatched"; prefix = "Unmatched";
      data = rows.map(function (r) { return { "Department": r.dept || "", "Material": r.material, "Material Description": r.desc, "Qty Counted": r.counted }; });
    } else {
      headers = ["Phys. Inventory Doc.", "Item", "Material", "Material Description", "Batch", "Plant", "Storage location", "Special Stock", "Count Date",
        "Qty Counted", "Base Unit of Measure", "Book Quantity", "Zero Count", "Var Qty", "Barcode", "Gondola Trace"]; sheet = "Reconciliation"; prefix = "Reconciliation";
      if (!App.deptId) { headers.splice(4, 0, "Department"); }
      data = rows.map(function (r) {
        var o = {
          "Phys. Inventory Doc.": r.doc, "Item": r.item == null ? "" : r.item, "Material": r.material, "Material Description": r.desc, "Batch": r.batch, "Plant": r.plant,
          "Storage location": r.sloc, "Special Stock": r.special, "Count Date": r.cdate, "Qty Counted": r.counted, "Base Unit of Measure": r.uom,
          "Book Quantity": r.book, "Zero Count": r.zero, "Var Qty": r.variance, "Barcode": r.barcode, "Gondola Trace": r.traceText === "—" ? "" : r.traceText
        };
        if (!App.deptId) o["Department"] = r.dept || "";
        return o;
      });
    }
    var ws = window.XLSX.utils.json_to_sheet(data, { header: headers }), wb = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(wb, ws, sheet);
    var file = prefix + "_" + String(App.outletName()).replace(/\s+/g, "_") + "_" + String(App.deptName() || "All_departments").replace(/\s+/g, "_") + "_" + localDate() + ".xlsx";
    window.XLSX.writeFile(wb, file);
    var filtered = S.q.trim() || S.mode !== "all";
    toast("Exported " + rows.length + " line" + (rows.length === 1 ? "" : "s") + " to " + file + (filtered ? " (with the current search or filter applied)." : "."));
  }

  /* ---------- events ---------- */
  function openTrace(k) {
    var m = $("#modal"); if (!m) return;
    var rows = S.trace[k] || [], row = S.rows.find(function (x) { return tkey(x.deptId, x.material) === k; });
    if (!row) return;
    S.traceOpen = k;
    var total = rows.reduce(function (a, r) { return a + num(r.qty); }, 0), anyCode = rows.some(function (r) { return r.barcode; });
    var body = rows.length
      ? '<div class="tablewrap" style="flex:1;min-width:0;background:var(--surface)"><table class="dt"><thead><tr><th class="plain">Gondola</th>' + (anyCode ? '<th class="plain">Barcode</th>' : "") +
        '<th class="plain num">Qty</th><th class="plain">Scanned at</th></tr></thead><tbody>' +
        rows.map(function (r) {
          return "<tr><td><b>" + esc(r.gondola_id) + "</b></td>" + (anyCode ? '<td class="mono">' + esc(r.barcode || "") + "</td>" : "") + '<td class="num">' + fmt(num(r.qty)) + "</td><td>" + esc(stamp(r.scanned_at)) + "</td></tr>";
        }).join("") + "</tbody></table></div>"
      : '<div class="empty" style="flex:1">No scans found for this material.</div>';
    var note = rows.length && total !== row.counted
      ? "Total scanned " + fmt(total) + " · counted in Reconciliation " + fmt(row.counted) + ". These can differ for items counted in cartons or packs (the counted quantity is in base units) or if a count changed while this page was open."
      : (rows.length ? "Total scanned " + fmt(total) + " · matches the counted quantity." : "");
    m.innerHTML = '<div class="modal-card" style="width:min(720px,100%)"><div class="modal-h"><h2>Scan trace · ' + esc(row.material) + '</h2><button type="button" class="icon-btn" data-rx="closeModal" aria-label="Close">' + icon("x") + "</button></div>" +
      '<div class="modal-b" style="flex-direction:column;flex-wrap:nowrap"><div class="muted">' + esc(row.desc) + " · " + esc(App.outletName()) + (row.dept ? " · " + esc(row.dept) : "") + "</div>" + body + "</div>" +
      '<div class="modal-f"><span class="muted small sp">' + esc(note) + '</span><button type="button" class="btn" data-rx="closeModal">Close</button></div></div>';
    m.hidden = false; $("#scrim").hidden = false;
  }

  var ACT = {
    trace: function (d) { openTrace(d.k); },
    xls: exportExcel,
    sapcols: function () { S.sapCols = !S.sapCols; renderTable(); },
    closeModal: function () { App.closeOverlays(); },
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
    reset: function () { S = fresh(); },
    closeOverlays: function () { S.traceOpen = null; }
  });
})();
