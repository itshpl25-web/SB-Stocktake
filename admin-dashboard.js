/* StockTake Admin: Dashboard + stocktake checklist (step 5)
   Whole-outlet overview: tiles, "needs attention" list, progress per department, and a checklist for the
   chosen department. Three steps are ticked by hand and shared between supervisors (table checklist_progress);
   the other three tick themselves from live data. Every read and write goes through Scoped, so it is always
   the selected outlet. Loads after the other sections. */
(function () {
  "use strict";
  var App = window.StockTakeAdmin;
  if (!App) return;
  var Scoped = App.Scoped, esc = App.esc, icon = App.icon, toast = App.toast, sb = App.sb;
  function $(s, r) { return (r || document).querySelector(s); }

  var MANUAL = ["master", "review", "export"];
  var STEPS = [
    { id: "master", label: "MASTER LIST loaded", manual: true, go: "uploads", goLabel: "Uploads" },
    { id: "mi24", label: "MI24 book list loaded", go: "uploads", goLabel: "Uploads" },
    { id: "gondolas", label: "All gondolas finished", go: "sessions", goLabel: "Sessions" },
    { id: "printed", label: "All gondola reports printed", go: "sessions", goLabel: "Sessions" },
    { id: "review", label: "Reconciliation reviewed", manual: true, go: "recon", goLabel: "Reconciliation" },
    { id: "export", label: "Exported for SAP", manual: true, go: "export", goLabel: "Export" }
  ];

  function fresh() { return { key: null, loaded: false, loading: false, error: null, data: null, ticks: {}, ticksError: null, loadedAt: null, writing: false, focus: null }; }
  var S = fresh();
  var P = { key: null, count: null }; // MASTER products on file for the chosen department (shared data, read only)

  function fmt(n) { return Number(n || 0).toLocaleString("en-US"); }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function when(iso) {
    var d = new Date(iso); if (isNaN(d.getTime())) return "";
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return p(d.getDate()) + " " + MON[d.getMonth()] + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  /* ---------- loading ---------- */
  function load(silent) {
    var mine = S, key = String(App.outletId);
    if (!silent) { S.loading = true; S.error = null; paint(); }
    var depts = App.depts.slice();
    var sessionsQ = App.fetchAllPages(function (a, b) {
      return Scoped.select("session_summary", "id,department_id,status,printed_at,item_count").order("id").range(a, b);
    });
    var unmatchedQ = App.fetchAllPages(function (a, b) {
      return Scoped.select("unmatched_scans", "department_id,material").order("department_id").order("material").range(a, b);
    });
    var sapQ = Promise.all(depts.map(function (d) {
      return Scoped.select("sap_uploads", "id", { count: "exact", head: true }).eq("department_id", d.id);
    }));
    // the checklist table is new; if it is missing the rest of the dashboard must still work
    var ticksQ = App.fetchAllPages(function (a, b) {
      return Scoped.select("checklist_progress", "*").order("department_id").order("step").range(a, b);
    }).then(function (rows) { return { rows: rows }; }, function (e) { return { error: (e && e.message) || String(e) }; });

    return Promise.all([sessionsQ, unmatchedQ, sapQ, ticksQ]).then(function (r) {
      if (mine !== S || key !== String(App.outletId)) return; // outlet changed while loading
      var bad = r[2].find(function (x) { return x.error; });
      if (bad) throw bad.error;
      var by = {};
      depts.forEach(function (d, i) {
        by[d.id] = { id: d.id, name: d.name, sap: r[2][i].count || 0, sessions: 0, inProgress: 0, done: 0, unprinted: 0, items: 0, unmatched: 0 };
      });
      function slot(id) { return by[id] || (by[id] = { id: id, name: "Department " + id, sap: 0, sessions: 0, inProgress: 0, done: 0, unprinted: 0, items: 0, unmatched: 0 }); }
      r[0].forEach(function (s) {
        var x = slot(s.department_id);
        x.sessions++; x.items += Number(s.item_count) || 0;
        if (s.status === "in_progress") x.inProgress++;
        else if (s.status === "done") { x.done++; if (!s.printed_at) x.unprinted++; }
      });
      r[1].forEach(function (u) { slot(u.department_id).unmatched++; });
      var ticks = {};
      if (!r[3].error) {
        r[3].rows.forEach(function (t) {
          if (String(t.outlet_id) !== key) return; // belt and braces: never use another outlet's tick
          ticks[String(t.department_id) + "|" + t.step] = { done: !!t.done, at: t.updated_at };
        });
      }
      S.data = Object.keys(by).map(function (k) { return by[k]; });
      S.ticks = ticks; S.ticksError = r[3].error || null;
      S.loaded = true; S.loading = false; S.error = null; S.loadedAt = new Date();
      paint(); badge();
    }).catch(function (e) {
      if (mine !== S || key !== String(App.outletId)) return;
      S.loading = false;
      if (!S.loaded) S.error = (e && e.message) || String(e);
      paint();
      if (silent) App.handleError(e);
    });
  }
  function loadProducts() {
    var d = App.deptId, key = String(App.outletId) + "|" + String(d);
    if (!d) { P = { key: key, count: null }; return; }
    if (P.key === key) return;
    P = { key: key, count: null };
    Promise.resolve(sb.from("products").select("id", { count: "exact", head: true }).eq("department_id", d)).then(function (r) {
      if (P.key !== key) return;
      P.count = r.error ? null : (r.count || 0);
      paint();
    });
  }

  /* ---------- what the data says ---------- */
  function tickOf(d, step) { return S.ticks[String(d) + "|" + step] || { done: false, at: null }; }
  function stateOf(x) {
    var st = {};
    st.master = tickOf(x.id, "master").done;
    st.mi24 = x.sap > 0;
    st.gondolas = x.sessions > 0 && x.inProgress === 0;
    st.printed = x.done > 0 && x.unprinted === 0 && x.inProgress === 0;
    st.review = tickOf(x.id, "review").done;
    st.export = tickOf(x.id, "export").done;
    st.n = STEPS.filter(function (s) { return st[s.id]; }).length;
    return st;
  }
  /* A manual tick that the data contradicts is allowed, but flagged. */
  function warningsOf(x, st) {
    var w = [];
    if (st.export) {
      if (!st.mi24) w.push({ step: "export", text: "Marked exported, but no MI24 data is on file." });
      if (x.inProgress > 0) w.push({ step: "export", text: "Marked exported, but " + plural(x.inProgress, "gondola is", "gondolas are") + " still in progress." });
      if (!st.review) w.push({ step: "export", text: "Marked exported before reconciliation was marked reviewed." });
    }
    if (st.review) {
      if (!st.mi24) w.push({ step: "review", text: "Marked reviewed, but no MI24 data is on file." });
      if (x.inProgress > 0) w.push({ step: "review", text: "Marked reviewed, but " + plural(x.inProgress, "gondola is", "gondolas are") + " still in progress." });
    }
    return w;
  }
  function attention() {
    var out = [];
    S.data.slice().sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); }).forEach(function (x) {
      var st = stateOf(x);
      if (x.sessions > 0 && !x.sap) out.push({ tone: "crit", dept: x, text: "Scans exist but no MI24 book list is loaded.", go: "uploads", label: "Go to Uploads" });
      if (x.inProgress > 0) out.push({ tone: "warn", dept: x, text: plural(x.inProgress, "gondola is", "gondolas are") + " still in progress.", go: "sessions", label: "Open Sessions" });
      if (x.unprinted > 0) out.push({ tone: "warn", dept: x, text: plural(x.unprinted, "finished gondola has", "finished gondolas have") + " not been printed.", go: "sessions", label: "Open Sessions" });
      if (x.unmatched > 0) out.push({ tone: "warn", dept: x, text: plural(x.unmatched, "scanned item is", "scanned items are") + " not in the MI24 book list.", go: "recon", label: "Open Reconciliation" });
      warningsOf(x, st).forEach(function (w) {
        out.push({ tone: "warn", dept: x, text: w.text, go: w.step === "export" ? "export" : "recon", label: w.step === "export" ? "Open Export" : "Open Reconciliation" });
      });
    });
    return out;
  }
  function badge() {
    if (!S.loaded) return;
    var n = attention().length;
    if (n) App.badges.dashboard = { text: n + " open", warn: true }; else delete App.badges.dashboard;
    App.renderNav();
  }

  /* ---------- painting ---------- */
  function tile(k, v, s, tone) {
    return '<div class="tile' + (tone ? " " + tone : "") + '"><span class="k">' + esc(k) + '</span><span class="v">' + v + "</span>" + (s ? '<span class="s">' + esc(s) + "</span>" : "") + "</div>";
  }
  function render(root) {
    if (S.key !== String(App.outletId)) { S = fresh(); S.key = String(App.outletId); }
    root.innerHTML = App.pageHead("Dashboard", App.outletName() + ": how far the stocktake has got in every department. Click a department to see its checklist.") +
      '<div id="d-body"></div>';
    paint();
    loadProducts();
    if (!S.loaded && !S.loading) load(false);
  }
  function paint() {
    var el = $("#d-body"); if (!el) return;
    if (S.loading && !S.loaded) { el.innerHTML = '<section class="panel"><div class="empty">Loading the dashboard…</div></section>'; return; }
    if (S.error && !S.loaded) {
      el.innerHTML = '<div class="note err">' + icon("alert") + "<span>Could not load the dashboard: " + esc(S.error) + ' <button type="button" class="btn sm" data-dx="reload" style="margin-left:8px">Retry</button></span></div>';
      return;
    }
    if (!S.loaded) return;
    var D = S.data, tot = { sessions: 0, inProgress: 0, done: 0, unprinted: 0, items: 0, sap: 0, unmatched: 0 };
    D.forEach(function (x) { Object.keys(tot).forEach(function (k) { tot[k] += x[k]; }); });
    var att = attention();

    var tiles = '<div class="tiles">' +
      tile("Gondolas finished", fmt(tot.done) + '<small> / ' + fmt(tot.sessions) + "</small>", tot.inProgress ? plural(tot.inProgress, "still in progress", "still in progress") : "None in progress", tot.inProgress ? "warn" : "") +
      tile("Waiting to be printed", fmt(tot.unprinted), tot.unprinted ? "Finished, not printed yet" : "All finished gondolas printed", tot.unprinted ? "warn" : "") +
      tile("Items scanned", fmt(tot.items), "Lines across all gondolas") +
      tile("MI24 rows", fmt(tot.sap), "Book list on file") +
      tile("Unmatched scans", fmt(tot.unmatched), tot.unmatched ? "Not in the MI24 book list" : "Everything scanned is in MI24", tot.unmatched ? "warn" : "") + "</div>";

    var attHtml = '<section class="panel" style="margin-bottom:16px"><div class="panel-h"><h2>Needs attention</h2><p>' + esc(App.outletName()) + ", all departments</p></div>" +
      '<div class="panel-b">' + (att.length
        ? '<ul class="attn">' + att.map(function (a, i) {
          return '<li class="' + a.tone + '">' + icon("alert") + "<span><b>" + esc(a.dept.name) + ":</b> " + esc(a.text) + '</span><button type="button" class="btn sm" data-dx="open" data-i="' + i + '">' + esc(a.label) + "</button></li>";
        }).join("") + "</ul>"
        : '<div class="note ok">' + icon("check") + "<span>Nothing needs attention right now.</span></div>") + "</div></section>";

    var rows = D.slice().sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); }).map(function (x) {
      var st = stateOf(x), sel = String(x.id) === String(App.deptId);
      var dots = STEPS.map(function (s) { return '<i class="' + (st[s.id] ? "on" : "off") + '" title="' + esc(s.label + (st[s.id] ? ": done" : ": not done")) + '"></i>'; }).join("");
      var pill = st.n === STEPS.length ? '<span class="pill ok"><i></i>Complete</span>' : (st.n === 0 && !x.sessions && !x.sap ? '<span class="pill info"><i></i>Not started</span>' : '<span class="pill warn"><i></i>In progress</span>');
      return '<tr class="click' + (sel ? " sel" : "") + '" data-dx="pick" data-d="' + esc(x.id) + '" tabindex="0" aria-label="Show checklist for ' + esc(x.name) + '"><td><b>' + esc(x.name) + "</b></td>" +
        '<td class="num">' + fmt(x.sap) + '</td><td class="num">' + fmt(x.done) + " / " + fmt(x.sessions) + '</td><td class="num">' + fmt(x.done - x.unprinted) + " / " + fmt(x.done) +
        '</td><td><span class="dots" aria-hidden="true">' + dots + '</span></td><td class="num">' + st.n + " / " + STEPS.length + "</td><td>" + pill + "</td></tr>";
    }).join("");
    var table = '<section class="panel" style="margin-bottom:16px"><div class="panel-h"><h2>Progress by department</h2><p>Dots follow the checklist order: MASTER, MI24, finished, printed, reviewed, exported.</p></div>' +
      '<div class="tablewrap"><table class="dt"><thead><tr><th class="plain">Department</th><th class="plain num">MI24 rows</th><th class="plain num">Gondolas done</th><th class="plain num">Printed</th><th class="plain">Steps</th><th class="plain num">Done</th><th class="plain">Status</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="7" class="empty">No departments yet.</td></tr>') + "</tbody></table></div></section>";

    el.innerHTML = tiles + attHtml + table + checklistHtml();
    var f = S.focus; S.focus = null;
    if (f) { var b = $('[data-dx="tick"][data-step="' + f + '"]'); if (b) b.focus(); }
  }

  function checklistHtml() {
    if (!App.deptId) {
      return '<section class="panel"><div class="panel-h"><h2>Checklist</h2></div><div class="panel-b"><div class="note">' + icon("info") +
        "<span>Click a department above, or choose one in the bar at the top, to see its checklist.</span></div></div></section>";
    }
    var x = S.data.find(function (y) { return String(y.id) === String(App.deptId); });
    if (!x) x = { id: App.deptId, name: App.deptName(), sap: 0, sessions: 0, inProgress: 0, done: 0, unprinted: 0, items: 0, unmatched: 0 };
    var st = stateOf(x), warns = warningsOf(x, st);
    function detail(id) {
      if (id === "master") return P.count == null ? "" : plural(P.count, "product is", "products are") + " on file for this department. MASTER LIST is shared by every outlet.";
      if (id === "mi24") return x.sap ? plural(x.sap, "row", "rows") + " loaded for this outlet." : "Nothing loaded for this outlet and department yet.";
      if (id === "gondolas") return !x.sessions ? "No gondolas yet." : fmt(x.done) + " of " + fmt(x.sessions) + " finished" + (x.inProgress ? ", " + x.inProgress + " in progress." : ".");
      if (id === "printed") return !x.done ? "No finished gondolas yet." : fmt(x.done - x.unprinted) + " of " + fmt(x.done) + " finished gondolas printed.";
      return "";
    }
    var list = STEPS.map(function (s, i) {
      var on = st[s.id], t = s.manual ? tickOf(x.id, s.id) : null;
      var ws = warns.filter(function (w) { return w.step === s.id; });
      var control = s.manual
        ? '<button type="button" class="chk" role="checkbox" aria-checked="' + on + '" aria-label="' + esc(s.label) + '" data-dx="tick" data-step="' + s.id + '"' + (S.writing || App.busy ? " disabled" : "") + ">" + (on ? icon("check") : "") + "</button>"
        : '<span class="chk auto' + (on ? " on" : "") + '" aria-hidden="true">' + (on ? icon("check") : "") + "</span>";
      var sub = s.manual ? (on && t.at ? "Ticked " + when(t.at) + ". " : "") + detail(s.id) : detail(s.id);
      return '<li class="step' + (on ? " done" : "") + '">' + control + '<div class="st"><b>' + (i + 1) + ". " + esc(s.label) + "</b>" +
        '<span class="how">' + (s.manual ? "Manual check required" : "Checked automatically") + "</span>" +
        (sub ? '<div class="sub">' + esc(sub) + "</div>" : "") +
        ws.map(function (w) { return '<div class="sub warnline">' + icon("alert") + esc(w.text) + "</div>"; }).join("") + "</div>" +
        '<button type="button" class="linkbtn" data-dx="goto" data-to="' + s.go + '">' + esc(s.goLabel) + "</button></li>";
    }).join("");
    var pct = Math.round(st.n / STEPS.length * 100);
    return '<section class="panel"><div class="panel-h"><h2>Checklist · ' + esc(App.outletName()) + " · " + esc(x.name) + "</h2><p>" + st.n + " of " + STEPS.length +
      ' done. Ticks are shared: every supervisor sees the same state. Clear resets this checklist.</p></div><div class="panel-b">' +
      (S.ticksError ? '<div class="note err" style="margin-bottom:12px">' + icon("alert") + "<span>The checklist table could not be read (" + esc(S.ticksError) + "). Run the checklist SQL in Supabase. Ticks will not be saved until then.</span></div>" : "") +
      '<div class="prog" style="margin:0 0 14px"><i style="width:' + pct + '%"></i></div><ol class="steps">' + list + "</ol></div></section>";
  }

  /* ---------- ticking a manual step ---------- */
  function tick(step) {
    if (S.writing || App.busy || MANUAL.indexOf(step) < 0) return;
    var sc;
    try { sc = App.requireScope(true); } catch (e) { App.handleError(e); return; }
    var o = sc.outletId, d = sc.deptId, k = String(d) + "|" + step;
    var was = S.ticks[k] || { done: false, at: null }, next = !was.done, nowIso = new Date().toISOString();
    S.writing = true; S.focus = step; App.setBusy(true);
    S.ticks[k] = { done: next, at: nowIso }; paint();
    Promise.resolve(Scoped.upsert("checklist_progress", { department_id: d, step: step, done: next, updated_at: nowIso }, "outlet_id,department_id,step")).then(function (r) {
      if (r.error) throw r.error;
    }).catch(function (e) {
      if (String(App.outletId) === String(o)) S.ticks[k] = was;
      App.handleError(e);
    }).then(function () {
      S.writing = false; App.setBusy(false);
      paint(); badge();
      load(true);
    });
  }

  /* Clear wipes the data for one outlet + department, so its checklist starts again from the top. */
  App.onCleared = function (o, d) {
    if (String(o) !== String(App.outletId)) return; // Scoped only ever acts on the selected outlet
    Promise.resolve(Scoped.remove("checklist_progress", { department_id: d })).then(function (r) {
      if (r.error) throw r.error;
      Object.keys(S.ticks).forEach(function (k) { if (k.indexOf(String(d) + "|") === 0) delete S.ticks[k]; });
      paint(); badge();
    }).catch(function (e) { toast("The data was cleared, but the checklist could not be reset: " + ((e && e.message) || e), "err"); });
  };

  /* ---------- events ---------- */
  function activate(t) {
    var a = t.dataset.dx;
    if (a === "tick") tick(t.dataset.step);
    else if (a === "pick") { App.setDept(t.dataset.d); }
    else if (a === "goto") App.go(t.dataset.to);
    else if (a === "reload") { S.key = String(App.outletId); load(false); }
    else if (a === "open") {
      var item = attention()[Number(t.dataset.i)]; if (!item) return;
      if (App.busy) { toast("A save is still running. Try again in a moment.", "err"); return; }
      App.setDept(String(item.dept.id));
      App.go(item.go);
    }
  }
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-dx]"); if (!t || t.disabled) return;
    if (t.dataset.dx === "pick" && e.target.closest("button,a")) return;
    activate(t);
  });
  document.addEventListener("keydown", function (e) {
    if ((e.key === "Enter" || e.key === " ") && e.target.dataset && e.target.dataset.dx === "pick") { e.preventDefault(); activate(e.target); }
  });

  App.register("dashboard", {
    render: render,
    refresh: function () { if (S.writing || App.busy) return; loadProducts(); return load(true); },
    reset: function () { S = fresh(); P = { key: null, count: null }; }
  });
})();
