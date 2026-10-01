/* StockTake Admin: Export (step 4)
   Builds the .xlsx that is uploaded to SAP, for the selected outlet and department only.
   - Reads the sap_export view page by page (no 1000-row cut-off)
   - Refuses to build the file if any row belongs to a different outlet or department
   - Warns about gondolas still in progress and scanned items that are not in the MI24 book list
   Columns, sheet name and file name follow the old admin page. Loads after admin.js. */
(function () {
  "use strict";
  var App = window.StockTakeAdmin;
  if (!App) return;
  var Scoped = App.Scoped, esc = App.esc, icon = App.icon, toast = App.toast;
  function $(s, r) { return (r || document).querySelector(s); }

  var PREVIEW_ROWS = 10;
  var HEADERS = ["Phys. Inventory Doc.", "Item", "Material", "Material Description", "Batch", "Plant", "Storage location",
    "Special Stock", "Count Date", "Qty Counted", "Base Unit of Measure", "Book Quantity", "Zero Count"];

  function fresh() { return { key: null, rows: null, loading: false, error: null, openSessions: 0, unmatched: 0, loadedAt: null }; }
  var S = fresh();

  function curKey() { return String(App.outletId) + "|" + String(App.deptId); }
  function num(v) { var n = Number(v); return isNaN(n) ? 0 : n; }
  function fmt(n) { return Number(n).toLocaleString("en-US", { maximumFractionDigits: 3 }); }
  function p2(n) { return String(n).padStart(2, "0"); }
  function localDate() { var d = new Date(); return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()); }

  /* ---------- loading ---------- */
  function load() {
    var mine = S, key = S.key, o = App.outletId, d = App.deptId;
    S.loading = true; S.error = null; S.rows = null;
    paint();
    return Promise.all([
      App.fetchAllPages(function (a, b) {
        return Scoped.select("sap_export", "*").eq("department_id", d).order("id").range(a, b);
      }),
      Scoped.select("gondola_sessions", "id", { count: "exact", head: true }).eq("department_id", d).eq("status", "in_progress"),
      Scoped.select("unmatched_scans", "material", { count: "exact", head: true }).eq("department_id", d)
    ]).then(function (r) {
      if (mine !== S || key !== S.key) return; // outlet or department changed while loading
      if (r[1].error) throw r[1].error;
      if (r[2].error) throw r[2].error;
      var rows = r[0];
      var wrong = rows.some(function (x) { return String(x.outlet_id) !== String(o) || String(x.department_id) !== String(d); });
      if (wrong) throw new Error("Rows from another outlet or department came back, so the export was blocked. Nothing can be downloaded.");
      S.rows = rows; S.openSessions = r[1].count || 0; S.unmatched = r[2].count || 0;
      S.loading = false; S.loadedAt = new Date();
      paint();
    }).catch(function (e) {
      if (mine !== S || key !== S.key) return;
      S.loading = false; S.error = (e && e.message) || String(e);
      paint();
    });
  }

  /* ---------- page ---------- */
  function render(root) {
    var head = App.pageHead("Export", "Step 4. Download the .xlsx that gets uploaded to SAP. It contains the MI24 lines for " + App.outletName() + (App.deptName() ? " · " + App.deptName() : "") + " only.");
    if (!App.deptId) {
      root.innerHTML = head + '<section class="panel"><div class="panel-b"><div class="note warn">' + icon("alert") +
        "<span>Choose a department in the bar above. An export always covers one outlet and one department.</span></div></div></section>";
      return;
    }
    if (S.key !== curKey()) { S = fresh(); S.key = curKey(); }
    root.innerHTML = head + '<div id="x-body"></div>';
    paint();
    if (S.rows === null && !S.loading && !S.error) load();
  }
  function paint() {
    var el = $("#x-body"); if (!el) return;
    if (S.loading) { el.innerHTML = '<section class="panel"><div class="empty">Loading the export…</div></section>'; return; }
    if (S.error) {
      el.innerHTML = '<div class="note err">' + icon("alert") + "<span>" + esc(S.error) + ' <button type="button" class="btn sm" data-xx="reload" style="margin-left:8px">Retry</button></span></div>';
      return;
    }
    if (!S.rows) return;
    if (!S.rows.length) {
      el.innerHTML = '<div class="note warn">' + icon("alert") + "<span>There is no MI24 data for this outlet and department, so there is nothing to export. " +
        '<button type="button" class="linkbtn" data-xx="uploads">Go to Uploads</button></span></div>';
      return;
    }
    var rows = S.rows, tq = rows.reduce(function (a, r) { return a + num(r.qty_counted); }, 0);
    var zero = rows.filter(function (r) { return r.zero_count === "X"; }).length;
    var warns = "";
    if (S.openSessions) warns += '<div class="note warn">' + icon("alert") + "<span><b>" + S.openSessions + " gondola" + (S.openSessions > 1 ? "s are" : " is") +
      " still in progress</b> for this department. What has been scanned so far is in the file. Anything scanned after you download is not.</span></div>";
    if (S.unmatched) warns += '<div class="note warn">' + icon("alert") + "<span><b>" + S.unmatched + " scanned item" + (S.unmatched > 1 ? "s are" : " is") +
      " not in the MI24 book list</b>, so they are not in this file. SAP only receives MI24 lines. Check Reconciliation, Unmatched.</span></div>";
    var prev = rows.slice(0, PREVIEW_ROWS).map(function (r) {
      return '<tr><td class="mono">' + esc(r.material) + "</td><td>" + esc(r.description || "") + '</td><td class="num">' + esc(r.book_quantity == null ? "" : fmt(num(r.book_quantity))) +
        '</td><td class="num">' + fmt(num(r.qty_counted)) + "</td><td>" + esc(r.zero_count || "") + "</td></tr>";
    }).join("");
    el.innerHTML =
      '<div class="tiles tight"><div class="tile"><span class="k">Total lines</span><span class="v">' + fmt(rows.length) + "</span></div>" +
      '<div class="tile"><span class="k">Total qty counted</span><span class="v">' + fmt(tq) + "</span><span class=\"s\">Base units (count × numerator)</span></div>" +
      '<div class="tile"><span class="k">Zero-count lines</span><span class="v">' + fmt(zero) + "</span></div>" +
      '<div class="tile"><span class="k">Count date</span><span class="v" style="font-size:22px">' + esc(rows[0].count_date || "—") + "</span></div></div>" +
      (warns ? '<div class="stack" style="margin-bottom:16px">' + warns + "</div>" : "") +
      '<section class="panel"><div class="panel-h"><h2>' + esc(rows[0].outlet) + " · " + esc(rows[0].department) + "</h2><p>First " + Math.min(PREVIEW_ROWS, rows.length) +
      " of " + fmt(rows.length) + " lines. Zero Count is marked X where nothing was counted.</p></div>" +
      '<div class="panel-b" style="padding-top:8px"><div class="tablewrap" style="max-height:340px"><table class="dt"><thead><tr><th class="plain">Material</th><th class="plain">Description</th>' +
      '<th class="plain num">Book quantity</th><th class="plain num">Qty counted</th><th class="plain">Zero count</th></tr></thead><tbody>' + prev + "</tbody></table></div></div>" +
      '<div class="toolbar" style="border-top:1px solid var(--line);border-bottom:0"><button type="button" class="btn btn-primary" data-xx="download">' + icon("exp") + "Download .xlsx for SAP</button>" +
      '<button type="button" class="btn" data-xx="reload">Reload data</button><span class="sp muted small">Loaded ' + esc(p2(S.loadedAt.getHours()) + ":" + p2(S.loadedAt.getMinutes())) + "</span></div></section>";
  }

  /* ---------- download ---------- */
  function download() {
    if (!S.rows || !S.rows.length) return;
    if (S.key !== curKey()) { toast("The outlet or department changed. Reload the export first.", "err"); return; }
    if (!window.XLSX) { toast("The Excel writer did not load. Check the connection and reload the page.", "err"); return; }
    var o = App.outletId, d = App.deptId;
    if (S.rows.some(function (r) { return String(r.outlet_id) !== String(o) || String(r.department_id) !== String(d); })) {
      toast("Rows from another outlet or department were found. The export was blocked.", "err"); return;
    }
    var data = S.rows.map(function (r) {
      return {
        "Phys. Inventory Doc.": r.phys_inventory_doc, "Item": r.item, "Material": r.material, "Material Description": r.description,
        "Batch": r.batch, "Plant": r.plant, "Storage location": r.storage_location, "Special Stock": r.special_stock,
        "Count Date": r.count_date, "Qty Counted": r.qty_counted, "Base Unit of Measure": r.base_uom,
        "Book Quantity": r.book_quantity, "Zero Count": r.zero_count
      };
    });
    var outlet = S.rows[0].outlet, dept = S.rows[0].department;
    var ws = window.XLSX.utils.json_to_sheet(data, { header: HEADERS });
    var wb = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(wb, ws, "SAP Upload");
    var file = "SAP_Export_" + String(outlet).replace(/\s+/g, "_") + "_" + String(dept).replace(/\s+/g, "_") + "_" + localDate() + ".xlsx";
    window.XLSX.writeFile(wb, file);
    toast("Downloaded " + file + " (" + S.rows.length + " lines).");
  }

  /* ---------- events ---------- */
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-xx]"); if (!t) return;
    var a = t.dataset.xx;
    if (a === "download") download();
    else if (a === "reload") { if (App.deptId) { S.key = curKey(); load(); } }
    else if (a === "uploads") App.go("uploads");
  });

  App.register("export", {
    render: render,
    reset: function () { S = fresh(); },
    _test: { HEADERS: HEADERS }
  });
})();
