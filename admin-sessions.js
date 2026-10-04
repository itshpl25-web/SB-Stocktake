/* StockTake Admin: Sessions (step 2)
   List of gondolas for the selected outlet, with search, filters and sorting,
   a detail panel to correct or delete counts, a Print button on every row,
   and the A4 Zone Count Report (Verified by box on the last page only,
   page numbers carry the gondola ID). Loads after admin.js. */
(function () {
  "use strict";
  var App = window.StockTakeAdmin;
  if (!App) return;
  var Scoped = App.Scoped, esc = App.esc, icon = App.icon, toast = App.toast;
  function $(s, r) { return (r || document).querySelector(s); }

  var STALE_HOURS = 6;
  /* Rows per A4 page, kept below what physically fits so nothing is ever cut off. */
  var PAGE_ROWS = { first: 30, next: 35, reserve: 5 }; // reserve = space the Verified by box takes on the last page

  function fresh() {
    return {
      rows: [], loaded: false, loading: false, error: null,
      q: "", status: "all", pf: "all", sort: { k: "started", d: -1 },
      openId: null, items: null, printId: null, printItems: null
    };
  }
  var S = fresh();

  /* ---------- helpers ---------- */
  function sid(v) { return String(v); }
  function findRow(id) { return S.rows.find(function (r) { return sid(r.id) === sid(id); }); }
  function hoursOpen(r) { return (Date.now() - new Date(r.started_at).getTime()) / 36e5; }
  function isStale(r) { return r.status === "in_progress" && hoursOpen(r) > STALE_HOURS; }
  function pill(kind, text) { return '<span class="pill ' + kind + '"><i></i>' + esc(text) + "</span>"; }
  function statusPill(r) {
    if (r.status === "done") return pill("ok", "Done");
    if (isStale(r)) return pill("warn", "Stale · " + Math.floor(hoursOpen(r)) + "h open");
    return pill("info", "In progress");
  }
  function ago(r) {
    var h = hoursOpen(r);
    return h < 1 ? Math.round(h * 60) + " min ago" : h.toFixed(1) + " h ago";
  }
  function fmtDate(iso) {
    return new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  }
  function p2(n) { return String(n).padStart(2, "0"); }
  function fmtStamp(d) { return p2(d.getDate()) + "." + p2(d.getMonth() + 1) + "." + d.getFullYear() + " " + p2(d.getHours()) + ":" + p2(d.getMinutes()); }
  function uomLabel(i) { return (i.uom || "") + (Number(i.numerator) > 1 ? " (" + i.numerator + "'s)" : ""); }

  /* ---------- filtering + sorting (client side, so department changes are instant) ---------- */
  function deptRows() {
    return S.rows.filter(function (r) { return !App.deptId || sid(r.department_id) === sid(App.deptId); });
  }
  function textMatch(r) {
    var q = S.q.trim().toLowerCase();
    return !q || (r.gondola_id + " " + (r.staff_name || "") + " " + r.department).toLowerCase().indexOf(q) > -1;
  }
  function visible() {
    return deptRows().filter(textMatch).filter(function (r) {
      if (S.status === "progress" && r.status !== "in_progress") return false;
      if (S.status === "done" && r.status !== "done") return false;
      if (S.status === "stale" && !isStale(r)) return false;
      if (S.pf === "unprinted" && r.printed_at) return false;
      if (S.pf === "printed" && !r.printed_at) return false;
      return true;
    });
  }
  var GET = {
    gondola: function (r) { return r.gondola_id; },
    dept: function (r) { return r.department; },
    staff: function (r) { return r.staff_name || ""; },
    status: function (r) { return r.status === "done" ? "c" : (isStale(r) ? "a" : "b"); },
    items: function (r) { return Number(r.item_count) || 0; },
    started: function (r) { return new Date(r.started_at).getTime(); },
    printed: function (r) { return r.printed_at ? new Date(r.printed_at).getTime() : 0; }
  };
  function sorted(rows) {
    var g = GET[S.sort.k] || GET.started, d = S.sort.d;
    return rows.slice().sort(function (a, b) {
      var x = g(a), y = g(b);
      var c = typeof x === "string" ? x.localeCompare(y, undefined, { numeric: true }) : x - y;
      return c * d;
    });
  }

  /* ---------- loading ---------- */
  function load(silent) {
    var mine = S;
    if (!silent) { S.loading = true; S.error = null; renderTable(); }
    return App.fetchAllPages(function (a, b) {
      return Scoped.select("session_summary", "*").order("started_at", { ascending: false }).order("id").range(a, b);
    }).then(function (rows) {
      if (mine !== S) return; // outlet changed while loading
      S.rows = rows;
      S.loaded = true; S.loading = false; S.error = null;
      renderChips(); renderTable(); updateBadge();
    }).catch(function (e) {
      if (mine !== S) return;
      S.loading = false;
      if (!S.loaded) S.error = (e && e.message) || String(e);
      renderTable();
      if (silent) App.handleError(e);
    });
  }
  function updateBadge() {
    var open = S.rows.filter(function (r) { return r.status === "in_progress"; }).length;
    if (open) App.badges.sessions = { text: open + " open", warn: S.rows.some(isStale) };
    else delete App.badges.sessions;
    App.renderNav();
  }
  /* ---------- page ---------- */
  function render(root) {
    root.innerHTML = App.pageHead("Sessions",
      "Every gondola for " + App.outletName() + " · " + (App.deptName() || "all departments") + ". Click a row to correct counts, or print from the row.") +
      '<section class="panel"><div class="toolbar">' +
      '<label class="search">' + icon("search") + '<input type="text" id="s-search" placeholder="Search gondola, staff, department" aria-label="Search sessions"></label>' +
      '<div class="chips" id="s-chips"></div>' +
      '<select id="s-print" class="sp" aria-label="Print status"><option value="all">All print states</option><option value="unprinted">Not printed</option><option value="printed">Printed</option></select>' +
      '</div><div class="tablewrap" id="s-table"></div></section>';
    $("#s-search").value = S.q;
    $("#s-print").value = S.pf;
    renderChips(); renderTable();
    if (!S.loaded && !S.loading) load(false);
  }
  function renderChips() {
    var el = $("#s-chips"); if (!el) return;
    var base = deptRows().filter(textMatch);
    var n = function (f) { return base.filter(f).length; };
    var chips = [
      ["all", "All", base.length],
      ["progress", "In progress", n(function (r) { return r.status === "in_progress"; })],
      ["done", "Done", n(function (r) { return r.status === "done"; })],
      ["stale", "Stale", n(isStale)]
    ];
    el.innerHTML = chips.map(function (c) {
      return '<button type="button" data-sx="status" data-v="' + c[0] + '" aria-pressed="' + (S.status === c[0]) + '">' + c[1] + " <b>" + c[2] + "</b></button>";
    }).join("");
  }
  var COLS = [["gondola", "Gondola"], ["dept", "Department"], ["staff", "Staff"], ["status", "Status"], ["items", "Items", true], ["started", "Started"], ["printed", "Printed"], [null, ""]];
  function rowHTML(r) {
    return '<tr class="click" data-sx="open" data-id="' + esc(r.id) + '" tabindex="0">' +
      '<td class="mono strong">' + esc(r.gondola_id) + "</td><td>" + esc(r.department) + "</td><td>" + esc(r.staff_name || "") + "</td><td>" + statusPill(r) + "</td>" +
      '<td class="num">' + (Number(r.item_count) || 0) + '</td><td class="muted" title="' + esc(ago(r)) + '">' + esc(fmtDate(r.started_at)) + "</td>" +
      "<td>" + (r.printed_at ? '<span title="' + esc(fmtStamp(new Date(r.printed_at))) + '">' + pill("ok", "Printed") + "</span>" : '<span class="muted">Not printed</span>') + "</td>" +
      '<td class="act"><button type="button" class="btn sm" data-sx="print" data-id="' + esc(r.id) + '">' + icon("printer") + "Print</button></td></tr>";
  }
  function renderTable() {
    var el = $("#s-table"); if (!el) return;
    if (S.loading && !S.loaded) { el.innerHTML = '<div class="empty">Loading sessions…</div>'; return; }
    if (S.error && !S.loaded) { el.innerHTML = '<div class="empty">Could not load sessions: ' + esc(S.error) + ' <button type="button" class="btn sm" data-sx="reload">Retry</button></div>'; return; }
    var rows = sorted(visible());
    var head = COLS.map(function (c) {
      if (!c[0]) return '<th class="plain"></th>';
      var on = S.sort.k === c[0];
      return '<th class="' + (c[2] ? "num" : "") + '" aria-sort="' + (on ? (S.sort.d === 1 ? "ascending" : "descending") : "none") + '">' +
        '<button type="button" class="thbtn" data-sx-sort="' + c[0] + '">' + c[1] + '<span class="arr">' + (on ? (S.sort.d === 1 ? "▲" : "▼") : "") + "</span></button></th>";
    }).join("");
    el.innerHTML = '<table class="dt"><thead><tr>' + head + "</tr></thead><tbody>" +
      (rows.length ? rows.map(rowHTML).join("") : '<tr><td colspan="8" class="empty">No sessions match these filters.</td></tr>') + "</tbody></table>";
  }

  /* ---------- detail panel ---------- */
  function openSession(id) {
    var r = findRow(id);
    if (!r) { toast("That gondola is not in the list for this outlet.", "err"); return; }
    S.openId = r.id; S.items = null;
    $("#drawer").hidden = false; $("#scrim").hidden = false;
    renderDrawer();
    loadItems();
  }
  function loadItems() {
    var mine = S, id = S.openId;
    S.items = null; renderDrawer();
    Promise.resolve(Scoped.scanItems(id)).then(function (r) {
      if (mine !== S || S.openId !== id) return;
      if (r.error) throw r.error;
      S.items = r.data || [];
      renderDrawer();
    }).catch(function (e) {
      if (mine !== S) return;
      App.handleError(e);
      App.closeOverlays();
    });
  }
  function renderDrawer() {
    var d = $("#drawer"), r = findRow(S.openId);
    if (!r) { d.hidden = true; d.innerHTML = ""; return; }
    var body;
    if (S.items === null) body = '<div class="empty">Loading items…</div>';
    else if (!S.items.length) body = '<div class="empty">No items scanned.</div>';
    else body = '<table class="dt compact"><thead><tr><th class="plain">Barcode</th><th class="plain">Description</th><th class="plain num">Qty</th><th class="plain"></th></tr></thead><tbody>' +
      S.items.map(function (i) {
        return '<tr><td class="mono small">' + esc(i.barcode) + "</td><td>" + esc(i.description) + '<div class="muted small">' + esc(uomLabel(i)) + "</div></td>" +
          '<td class="num"><input class="qty" type="number" min="0" max="9999" id="q-' + esc(i.id) + '" value="' + esc(i.qty) + '" aria-label="Quantity for ' + esc(i.description) + '"></td>' +
          '<td class="act"><button type="button" class="btn sm" data-sx="saveQty" data-id="' + esc(i.id) + '">Save</button>' +
          '<button type="button" class="btn sm danger" data-sx="delItem" data-id="' + esc(i.id) + '">Delete</button></td></tr>';
      }).join("") + "</tbody></table>";
    d.innerHTML = '<div class="dr-head"><div><div class="eyebrow">' + esc(r.outlet) + " · " + esc(r.department) + "</div><h2>" + esc(r.gondola_id) + '</h2>' +
      '<div class="muted" style="display:flex;gap:8px;align-items:center;margin-top:4px;flex-wrap:wrap">' + esc(r.staff_name || "") + " " + statusPill(r) + "</div></div>" +
      '<button type="button" class="icon-btn" data-sx="closeAll" aria-label="Close">' + icon("x") + "</button></div>" +
      '<div class="dr-body"><p class="muted small" style="margin:0 0 10px">Correct a quantity after re-counting. Reconciliation reflects the change straight away.</p>' + body + "</div>" +
      '<div class="dr-foot"><button type="button" class="btn btn-ghost sm" data-sx="reloadItems">Reload items</button>' +
      '<button type="button" class="btn sm danger" data-sx="delSession" data-id="' + esc(r.id) + '" title="Delete this one gondola and its scanned items">' + icon("clear") + 'Delete gondola</button><span style="flex:1"></span>' +
      '<button type="button" class="btn" data-sx="closeAll">Close</button>' +
      '<button type="button" class="btn btn-primary" data-sx="print" data-id="' + esc(r.id) + '">' + icon("printer") + "Print report</button></div>";
  }
  function saveQty(itemId) {
    var inp = $("#q-" + itemId); if (!inp) return;
    var raw = inp.value, v = Number(raw);
    if (raw === "" || isNaN(v) || v < 0 || v > 9999) { toast("Enter a quantity from 0 to 9999.", "err"); return; }
    var mine = S, sessionId = S.openId;
    Promise.resolve(Scoped.updateScanQty(sessionId, itemId, v)).then(function (res) {
      if (mine !== S) return;
      if (res.error) throw res.error;
      if (!res.data) { toast("This item was already deleted. Reloading the items.", "err"); loadItems(); return; }
      var it = S.items && S.items.find(function (i) { return sid(i.id) === sid(itemId); });
      if (it) it.qty = v;
      toast("Quantity updated. Reconciliation reflects it now.");
    }).catch(App.handleError);
  }
  function deleteItem(itemId, btn) {
    if (btn.dataset.arm !== "1") {
      btn.dataset.arm = "1"; btn.textContent = "Confirm delete?";
      setTimeout(function () { if (btn.isConnected) { btn.dataset.arm = "0"; btn.textContent = "Delete"; } }, 3200);
      return;
    }
    var mine = S, sessionId = S.openId;
    Promise.resolve(Scoped.deleteScanItem(sessionId, itemId)).then(function (res) {
      if (mine !== S) return;
      if (res.error) throw res.error;
      if (!res.data) { toast("This item was already deleted. Reloading the items.", "err"); loadItems(); return; }
      S.items = S.items.filter(function (i) { return sid(i.id) !== sid(itemId); });
      var r = findRow(sessionId); if (r) r.item_count = S.items.length;
      renderDrawer(); renderTable();
      toast("Item deleted.");
    }).catch(App.handleError);
  }

  /* Deletes exactly one gondola (its scanned items go with it). The fix for a gondola ID started under the wrong
     department: the ID is unique per outlet, so a wrong one blocks the ID until it is deleted. */
  function deleteSession(id) {
    var r = findRow(id);
    if (!r) { toast("That gondola is not in the list for this outlet.", "err"); return; }
    var label = r.gondola_id + " · " + r.outlet + " · " + r.department + " (" + (r.status === "done" ? "done" : "in progress") + ", " + (r.staff_name || "no staff name") + ", " + r.item_count + " item" + (Number(r.item_count) === 1 ? "" : "s") + ")";
    var warnOpen = r.status === "in_progress" ? "\n\nThis gondola is still IN PROGRESS: staff may still be counting on it." : "";
    if (!window.confirm("Permanently delete this ONE gondola and all its scanned items?\n\n" + label + warnOpen +
      "\n\nThis cannot be undone. The gondola ID can be used again straight away. No other gondolas or departments are affected.")) return;
    var mine = S;
    Promise.resolve(Scoped.remove("gondola_sessions", { id: r.id }).select()).then(function (res) {
      if (res.error) throw res.error;
      if (mine !== S) return;
      var gone = res.data && res.data.length;
      S.rows = S.rows.filter(function (x) { return sid(x.id) !== sid(r.id); });
      App.closeOverlays();
      renderChips(); renderTable(); updateBadge();
      App.invalidateData("sessions");
      toast(gone ? "Gondola " + r.gondola_id + " deleted. The ID is free to use again." : "That gondola was already gone.", gone ? "ok" : "info");
    }).catch(App.handleError);
  }

  /* ---------- A4 report ---------- */
  function paginate(n) {
    var cap = function (i) { return i === 0 ? PAGE_ROWS.first : PAGE_ROWS.next; };
    var pages = 1, total = cap(0) - PAGE_ROWS.reserve;
    while (total < n) { total += cap(pages); pages++; }
    var counts = [], left = n;
    for (var i = 0; i < pages; i++) {
      var c = cap(i) - (i === pages - 1 ? PAGE_ROWS.reserve : 0);
      var take = Math.min(left, c);
      counts.push(take); left -= take;
    }
    // Never leave the Verified by box alone on a page: pull a few rows onto the last page.
    if (pages > 1 && counts[pages - 1] === 0) {
      var k = Math.min(PAGE_ROWS.reserve, counts[pages - 2]);
      counts[pages - 2] -= k; counts[pages - 1] = k;
    }
    return counts;
  }
  function sheetHTML(r, rows, idx, total, stamp) {
    var first = idx === 0, last = idx === total - 1;
    var cg = '<colgroup><col style="width:38mm"><col><col style="width:26mm"><col style="width:24mm"></colgroup>';
    var thead = first ? "<thead><tr><th>Barcode</th><th>Description</th><th>UOM</th><th class=\"r\">Qty Counted</th></tr></thead>" : "";
    var trs = rows.map(function (i) {
      return "<tr><td>" + esc(i.barcode) + "</td><td>" + esc(i.description) + "</td><td>" + esc(uomLabel(i)) + '</td><td class="r">' + esc(i.qty) + "</td></tr>";
    }).join("");
    if (!rows.length && first) trs = '<tr><td colspan="4" class="c">No items scanned.</td></tr>';
    var table = trs ? "<table>" + cg + thead + "<tbody>" + trs + "</tbody></table>" : "";
    var head = first
      ? "<h3>Zone Count Report</h3><div class=\"meta\"><div><b>Outlet:</b> " + esc(r.outlet) + "</div><div><b>Department:</b> " + esc(r.department) +
        "</div><div><b>Gondola:</b> " + esc(r.gondola_id) + "</div><div><b>Staff:</b> " + esc(r.staff_name || "") +
        "</div><div><b>Status:</b> " + (r.status === "done" ? "DONE" : "IN PROGRESS") + "</div><div><b>Printed:</b> " + esc(stamp) + "</div></div>"
      : "";
    var verify = last ? '<div class="verify"><div>Verified by<span></span></div><div>Date<span></span></div></div>' : "";
    return '<div class="sheet">' + head + '<div class="body">' + table + "</div>" + verify +
      '<div class="foot">' + esc(r.gondola_id) + " · Page " + (idx + 1) + " of " + total + "</div></div>";
  }
  function buildSheets(r, items) {
    var counts = paginate(items.length), stamp = fmtStamp(new Date()), pos = 0;
    return counts.map(function (c, idx) {
      var slice = items.slice(pos, pos + c); pos += c;
      return sheetHTML(r, slice, idx, counts.length, stamp);
    });
  }
  function startPrint(id) {
    var r = findRow(id);
    if (!r) { toast("That gondola is not in the list for this outlet.", "err"); return; }
    $("#drawer").hidden = true; $("#drawer").innerHTML = ""; S.openId = null; S.items = null;
    S.printId = r.id; S.printItems = null;
    $("#modal").hidden = false; $("#scrim").hidden = false;
    renderModal();
    var mine = S;
    Promise.resolve(Scoped.scanItems(r.id)).then(function (res) {
      if (mine !== S || sid(S.printId) !== sid(r.id)) return;
      if (res.error) throw res.error;
      S.printItems = res.data || [];
      renderModal();
    }).catch(function (e) {
      if (mine !== S) return;
      App.handleError(e);
      App.closeOverlays();
    });
  }
  function renderModal() {
    var m = $("#modal"), r = findRow(S.printId);
    if (!r) { m.hidden = true; m.innerHTML = ""; return; }
    var body, pages = 0;
    if (S.printItems === null) body = '<div class="empty" style="flex:1">Loading items…</div>';
    else {
      var sheets = buildSheets(r, S.printItems); pages = sheets.length;
      body = '<div class="sheet-row">' + sheets.map(function (h) { return '<div class="sheet-wrap"><div class="sheet-scale">' + h + "</div></div>"; }).join("") + "</div>" +
        '<div class="pv-notes"><h3>What is on the sheet</h3><ul><li>A4 portrait, one gondola per report.</li>' +
        "<li>Outlet, department, gondola, staff and status at the top.</li>" +
        "<li>Every page number carries the gondola ID, so mixed-up pages can be sorted.</li>" +
        "<li>The Verified by box and date sit on the last page only.</li>" +
        "<li>The table header is not repeated on later pages.</li></ul></div>";
    }
    m.innerHTML = '<div class="modal-card"><div class="modal-h"><h2>Print preview · ' + esc(r.gondola_id) + '</h2><button type="button" class="icon-btn" data-sx="closeAll" aria-label="Close">' + icon("x") + "</button></div>" +
      '<div class="modal-b">' + body + "</div>" +
      '<div class="modal-f"><span class="muted small sp">' + (pages ? pages + " page" + (pages > 1 ? "s" : "") + " · " + (S.printItems.length) + " item" + (S.printItems.length === 1 ? "" : "s") : "") + "</span>" +
      '<button type="button" class="btn" data-sx="closeAll">Cancel</button>' +
      '<button type="button" class="btn btn-primary" data-sx="doPrint"' + (S.printItems === null ? " disabled" : "") + ">" + icon("printer") + "Print and mark as printed</button></div></div>";
  }
  function doPrint() {
    var r = findRow(S.printId);
    if (!r || S.printItems === null) return;
    var sheets = buildSheets(r, S.printItems), area = $("#print-area"), id = r.id, label = r.gondola_id, done = false;
    area.innerHTML = sheets.join("");
    function finish() {
      if (done) return;
      done = true;
      window.removeEventListener("afterprint", finish);
      area.innerHTML = "";
      stampPrinted(id, label);
    }
    window.addEventListener("afterprint", finish);
    App.closeOverlays();
    window.print();
    setTimeout(finish, 60000); // safety net for browsers that never fire afterprint
  }
  /* Same behaviour as today: the print stamp is set once the print dialog has been opened and closed. */
  function stampPrinted(id, label) {
    var mine = S, when = new Date().toISOString();
    Promise.resolve(Scoped.update("gondola_sessions", { printed_at: when }, { id: id }).select().maybeSingle()).then(function (res) {
      if (res.error) throw res.error;
      if (!res.data) throw new Error("Could not mark " + label + " as printed.");
      if (mine === S) { var row = findRow(id); if (row) row.printed_at = when; renderTable(); }
      toast(label + " marked as printed.");
    }).catch(App.handleError);
  }

  /* ---------- events ---------- */
  var ACT = {
    open: function (d) { openSession(d.id); },
    print: function (d) { startPrint(d.id); },
    reload: function () { load(false); },
    status: function (d) { S.status = d.v; renderChips(); renderTable(); },
    closeAll: function () { App.closeOverlays(); },
    saveQty: function (d) { saveQty(d.id); },
    delItem: function (d, el) { deleteItem(d.id, el); },
    reloadItems: function () { loadItems(); },
    delSession: function (d) { deleteSession(d.id); },
    doPrint: doPrint
  };
  document.addEventListener("click", function (e) {
    var so = e.target.closest("[data-sx-sort]");
    if (so) {
      var k = so.dataset.sxSort;
      if (S.sort.k === k) S.sort.d *= -1; else { S.sort.k = k; S.sort.d = 1; }
      renderTable();
      var again = document.querySelector('[data-sx-sort="' + k + '"]'); if (again) again.focus();
      return;
    }
    var t = e.target.closest("[data-sx]");
    if (t && ACT[t.dataset.sx]) ACT[t.dataset.sx](t.dataset, t);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && e.target.matches && e.target.matches('tr[data-sx="open"]')) openSession(e.target.dataset.id);
  });
  document.addEventListener("input", function (e) {
    if (e.target.id === "s-search") { S.q = e.target.value; renderChips(); renderTable(); }
  });
  document.addEventListener("change", function (e) {
    if (e.target.id === "s-print") { S.pf = e.target.value; renderTable(); }
  });

  App.register("sessions", {
    render: render,
    refresh: function () { return load(true); },
    reset: function () { S = fresh(); },
    closeOverlays: function () { S.openId = null; S.items = null; S.printId = null; S.printItems = null; }
  });
  App.sessions = { paginate: paginate, buildSheets: buildSheets, PAGE_ROWS: PAGE_ROWS };
})();
