/* StockTake Admin: Clear (step 5 of the workflow)
   Deletes the gondola sessions (scanned items go with them), and the MI24 data, for ONE outlet and ONE department.
   - Same 4-character confirm code as before (no 0/O/1/I), typed in the page instead of a browser prompt
   - Every delete goes through Scoped, so it always carries the selected outlet
   - Counts other outlets and other departments before and after, and reports whether they stayed untouched
   MASTER LIST products are never touched. Loads after admin.js. */
(function () {
  "use strict";
  var App = window.StockTakeAdmin;
  if (!App) return;
  var Scoped = App.Scoped, esc = App.esc, icon = App.icon, toast = App.toast, sb = App.sb;
  function $(s, r) { return (r || document).querySelector(s); }

  var CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no O/0 or I/1, as before
  function genCode() { var c = ""; for (var i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]; return c; }
  function fmt(n) { return Number(n).toLocaleString("en-US"); }

  function fresh() { return { key: null, code: "", typed: "", info: null, loading: false, error: null, busy: false, result: null }; }
  var S = fresh();
  function curKey() { return String(App.outletId) + "|" + String(App.deptId); }

  /* ---------- which departments of this outlet still hold data ---------- */
  var OV = { key: null, rows: null, loading: false, error: null };
  function loadOverview() {
    var key = String(App.outletId), depts = App.depts.slice();
    OV = { key: key, rows: null, loading: true, error: null };
    var mine = OV;
    paintOverview();
    Promise.all(depts.map(function (d) {
      return Promise.all([
        Scoped.select("sap_uploads", "id", { count: "exact", head: true }).eq("department_id", d.id),
        Scoped.select("gondola_sessions", "id", { count: "exact", head: true }).eq("department_id", d.id)
      ]).then(function (r) {
        var bad = r.find(function (x) { return x.error; });
        if (bad) throw bad.error;
        return { id: d.id, name: d.name, sap: r[0].count || 0, sessions: r[1].count || 0 };
      });
    })).then(function (rows) {
      if (mine !== OV || key !== String(App.outletId)) return;
      OV.rows = rows.filter(function (x) { return x.sap > 0 || x.sessions > 0; }).sort(function (a, b) { return (b.sap + b.sessions) - (a.sap + a.sessions); });
      OV.loading = false; paintOverview();
    }).catch(function (e) {
      if (mine !== OV) return;
      OV.loading = false; OV.error = (e && e.message) || String(e); paintOverview();
    });
  }
  function paintOverview() {
    var el = $("#c-ov"); if (!el) return;
    if (OV.loading) { el.innerHTML = '<div class="empty">Checking which departments still have data…</div>'; return; }
    if (OV.error) { el.innerHTML = '<div class="note err">' + icon("alert") + "<span>" + esc(OV.error) + ' <button type="button" class="btn sm" data-cc="ovreload" style="margin-left:8px">Retry</button></span></div>'; return; }
    if (!OV.rows) return;
    if (!OV.rows.length) { el.innerHTML = '<div class="note ok">' + icon("check") + "<span>No department has MI24 data or gondolas for " + esc(App.outletName()) + ".</span></div>"; return; }
    el.innerHTML = '<p class="muted" style="margin:0 0 10px"><b>' + OV.rows.length + "</b> department" + (OV.rows.length === 1 ? " still has" : "s still have") + " data for " + esc(App.outletName()) + ". They may need clearing.</p>" +
      '<div class="tablewrap"><table class="dt"><thead><tr><th class="plain">Department</th><th class="plain num">Gondolas</th><th class="plain num">MI24 rows</th><th class="plain"></th></tr></thead><tbody>' +
      OV.rows.map(function (r) {
        var sel = String(r.id) === String(App.deptId);
        return '<tr class="' + (sel ? "sel" : "") + '"><td><b>' + esc(r.name) + '</b></td><td class="num">' + fmt(r.sessions) + '</td><td class="num">' + fmt(r.sap) + '</td><td class="act">' +
          (sel ? '<span class="muted small">Selected</span>' : '<button type="button" class="btn sm" data-cc="pick" data-d="' + esc(r.id) + '">Select</button>') + "</td></tr>";
      }).join("") + "</tbody></table></div>";
  }
  var OVPANEL = '<section class="panel" style="max-width:680px;margin-top:16px"><div class="panel-h"><h2>Departments still holding data</h2>' +
    "<p>Every department of this outlet that still has gondolas or MI24 rows. Other outlets are not shown.</p></div><div class=\"panel-b\" id=\"c-ov\"></div></section>";

  /* ---------- what is on file ---------- */
  function load() {
    var mine = S, key = S.key, d = App.deptId;
    S.loading = true; S.error = null;
    paint();
    return Promise.all([
      App.fetchAllPages(function (a, b) {
        return Scoped.select("session_summary", "id,status,printed_at,item_count").eq("department_id", d).order("id").range(a, b);
      }),
      Scoped.select("sap_uploads", "id", { count: "exact", head: true }).eq("department_id", d)
    ]).then(function (r) {
      if (mine !== S || key !== S.key) return;
      if (r[1].error) throw r[1].error;
      var rows = r[0];
      S.info = {
        sessions: rows.length,
        items: rows.reduce(function (a, x) { return a + (Number(x.item_count) || 0); }, 0),
        inProgress: rows.filter(function (x) { return x.status === "in_progress"; }).length,
        unprinted: rows.filter(function (x) { return x.status === "done" && !x.printed_at; }).length,
        sap: r[1].count || 0
      };
      S.loading = false;
      paint();
    }).catch(function (e) {
      if (mine !== S || key !== S.key) return;
      S.loading = false; S.error = (e && e.message) || String(e);
      paint();
    });
  }

  /* Rows that must NOT change: every other outlet, and this outlet's other departments. */
  function countRest(o, d) {
    function head(table) { return sb.from(table).select("id", { count: "exact", head: true }); }
    return Promise.all([
      head("gondola_sessions").neq("outlet_id", o),
      head("sap_uploads").neq("outlet_id", o),
      head("gondola_sessions").eq("outlet_id", o).neq("department_id", d),
      head("sap_uploads").eq("outlet_id", o).neq("department_id", d)
    ]).then(function (r) {
      var bad = r.find(function (x) { return x.error; });
      if (bad) throw bad.error;
      return { otherSessions: r[0].count || 0, otherSap: r[1].count || 0, deptSessions: r[2].count || 0, deptSap: r[3].count || 0 };
    });
  }
  function countScope(d) {
    return Promise.all([
      Scoped.select("gondola_sessions", "id", { count: "exact", head: true }).eq("department_id", d),
      Scoped.select("sap_uploads", "id", { count: "exact", head: true }).eq("department_id", d)
    ]).then(function (r) {
      var bad = r.find(function (x) { return x.error; });
      if (bad) throw bad.error;
      return { sessions: r[0].count || 0, sap: r[1].count || 0 };
    });
  }

  /* ---------- page ---------- */
  function render(root) {
    var head = App.pageHead("Clear", "Step 5. Deletes the gondola sessions, scanned items and MI24 data for one outlet and department. MASTER LIST products and every other outlet stay untouched.");
    if (!App.deptId) {
      root.innerHTML = head + '<section class="panel" style="max-width:680px"><div class="panel-b"><div class="note warn">' + icon("alert") +
        "<span>Choose a department in the bar above. Clear always works on one outlet and one department.</span></div></div></section>" + OVPANEL;
      paintOverview(); if (OV.key !== String(App.outletId)) loadOverview();
      return;
    }
    if (S.key !== curKey()) { S = fresh(); S.key = curKey(); S.code = genCode(); }
    root.innerHTML = head + '<section class="panel" style="max-width:680px"><div class="panel-h"><h2>' + esc(App.outletName()) + " · " + esc(App.deptName()) +
      '</h2></div><div class="panel-b" id="c-body"></div></section>' + OVPANEL;
    paint();
    paintOverview(); if (OV.key !== String(App.outletId)) loadOverview();
    if (!S.info && !S.loading && !S.error) load();
  }
  function paint() {
    var el = $("#c-body"); if (!el) return;
    if (S.loading && !S.info) { el.innerHTML = '<div class="empty">Loading what is on file…</div>'; return; }
    if (S.error && !S.info) {
      el.innerHTML = '<div class="note err">' + icon("alert") + "<span>" + esc(S.error) + ' <button type="button" class="btn sm" data-cc="reload" style="margin-left:8px">Retry</button></span></div>';
      return;
    }
    var I = S.info; if (!I) return;
    var nothing = !I.sessions && !I.items && !I.sap;
    var notes = "";
    if (I.inProgress) notes += '<div class="note warn">' + icon("alert") + "<span><b>" + I.inProgress + " gondola" + (I.inProgress > 1 ? "s are" : " is") + " still in progress.</b> Staff may still be counting. Their scans are deleted too.</span></div>";
    if (I.unprinted) notes += '<div class="note warn">' + icon("alert") + "<span><b>" + I.unprinted + " finished gondola" + (I.unprinted > 1 ? "s have" : " has") + " not been printed.</b> Printouts cannot be made after this.</span></div>";
    if (!nothing) notes += '<div class="note">' + icon("info") + "<span>Export first. Once cleared, this data cannot be exported or recovered. " +
      '<button type="button" class="linkbtn" data-cc="export">Go to Export</button></span></div>';
    notes += '<div class="note ok">' + icon("check") + "<span>MASTER LIST products, other outlets, and this outlet's other departments will not be touched.</span></div>";
    var result = "";
    if (S.result) result = '<div class="log" style="margin-top:16px;max-height:none">' + S.result.map(function (l) { return '<div class="' + (l.c || "") + '">' + esc(l.m) + "</div>"; }).join("") + "</div>";
    el.innerHTML =
      '<div class="tiles tight"><div class="tile"><span class="k">Gondola sessions</span><span class="v">' + fmt(I.sessions) + "</span></div>" +
      '<div class="tile"><span class="k">Scanned items</span><span class="v">' + fmt(I.items) + "</span></div>" +
      '<div class="tile"><span class="k">MI24 rows</span><span class="v">' + fmt(I.sap) + "</span></div></div>" +
      '<div class="stack" style="margin-bottom:16px">' + notes + "</div>" +
      (nothing ? "" :
        '<div class="field"><span>Type this code to confirm</span><div><span class="codebox" aria-label="Confirmation code">' + esc(S.code) + "</span></div></div>" +
        '<div style="display:flex;gap:10px;flex-wrap:wrap"><input type="text" id="c-code" maxlength="4" placeholder="Code" autocomplete="off" aria-label="Confirmation code input" ' +
        'style="width:120px;text-transform:uppercase;font-family:var(--f-mono);letter-spacing:.2em" value="' + esc(S.typed) + '">' +
        '<button type="button" class="btn danger" id="c-go" data-cc="clear">' + icon("clear") + "Clear " + esc(App.outletName()) + " · " + esc(App.deptName()) + "</button></div>") +
      result;
    paintBtn();
  }
  function paintBtn() {
    var b = $("#c-go"); if (!b) return;
    b.disabled = S.busy || S.typed.trim().toUpperCase() !== S.code;
  }

  /* ---------- the delete ---------- */
  function doClear() {
    if (S.busy || !S.info) return;
    var sc;
    try { sc = App.requireScope(true); } catch (e) { App.handleError(e); return; }
    if (S.key !== curKey()) { toast("The outlet or department changed. Nothing was deleted.", "err"); return; }
    if (S.typed.trim().toUpperCase() !== S.code) { toast("The code does not match. Nothing was deleted.", "err"); return; }
    var o = sc.outletId, d = sc.deptId, label = App.outletName() + " · " + App.deptName();
    var mine = S, lines = [], stage = "start", before = null;
    function say(m, c) { lines.push({ m: m, c: c }); }
    S.busy = true; S.result = null; S.code = genCode(); S.typed = "";   // a code works once
    App.setBusy(true); paint();
    countRest(o, d).then(function (b) {
      before = b; stage = "sessions";
      return Scoped.remove("gondola_sessions", { department_id: d });
    }).then(function (r) {
      if (r.error) throw r.error;
      stage = "sap";
      return Scoped.remove("sap_uploads", { department_id: d });
    }).then(function (r) {
      if (r.error) throw r.error;
      stage = "verify";
      return Promise.all([countScope(d), countRest(o, d)]);
    }).then(function (v) {
      var left = v[0], after = v[1];
      var removedAll = left.sessions === 0 && left.sap === 0;
      say(removedAll ? "Cleared " + label + ": gondola sessions, scanned items and MI24 data are gone." : "Something is left for " + label + ": " + left.sessions + " gondola(s) and " + left.sap + " MI24 row(s). Run Clear again.", removedAll ? "ok" : "err");
      var shrank = after.otherSessions < before.otherSessions || after.otherSap < before.otherSap || after.deptSessions < before.deptSessions || after.deptSap < before.deptSap;
      var same = after.otherSessions === before.otherSessions && after.otherSap === before.otherSap && after.deptSessions === before.deptSessions && after.deptSap === before.deptSap;
      if (shrank) say("WARNING: the number of rows in other outlets or departments went DOWN. Check the data before doing anything else.", "err");
      else if (same) say("Checked: other outlets and this outlet's other departments are unchanged (" + fmt(after.otherSessions + after.deptSessions) + " gondola(s) and " + fmt(after.otherSap + after.deptSap) + " MI24 row(s) elsewhere).", "ok");
      else say("Other outlets and departments only gained rows while this ran (staff may have been scanning). Nothing there was removed.", "");
      say("MASTER LIST products were not touched.", "ok");
      S.result = lines;
      toast(removedAll ? "Cleared " + label + "." : "Clear finished with rows left. See the details.", removedAll ? "ok" : "err");
    }).catch(function (e) {
      var msg = (e && e.message) || String(e);
      if (stage === "start") say("Nothing was deleted: " + msg, "err");
      else if (stage === "sessions") say("Stopped while deleting the gondola sessions: " + msg + " Some data may already be gone. Run Clear again to finish.", "err");
      else if (stage === "sap") say("Gondola sessions and scans were deleted, but the MI24 data could not be: " + msg + " Run Clear again to finish.", "err");
      else say("The delete ran, but the final check failed: " + msg + " Reload the page and check the Sessions and Reconciliation pages.", "err");
      S.result = lines;
      App.handleError(e);
    }).then(function () {
      S.busy = false;
      App.setBusy(false);
      App.invalidateData("clear");
      if (typeof App.onCleared === "function") { try { App.onCleared(o, d); } catch (x) { /* the clear itself is already done */ } }
      if (mine === S) { S.info = null; load(); }
      loadOverview();
    });
  }

  /* ---------- events ---------- */
  document.addEventListener("input", function (e) {
    if (e.target.id === "c-code") { S.typed = e.target.value; paintBtn(); }
  });
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-cc]"); if (!t) return;
    var a = t.dataset.cc;
    if (a === "clear") doClear();
    else if (a === "reload") { S.key = curKey(); load(); }
    else if (a === "ovreload") loadOverview();
    else if (a === "pick") App.setDept(t.dataset.d);
    else if (a === "export") App.go("export");
  });

  App.register("clear", {
    render: render,
    reset: function () { S = fresh(); OV = { key: null, rows: null, loading: false, error: null }; },
    _test: { genCode: genCode, CODE_CHARS: CODE_CHARS }
  });
})();
