/* StockTake Admin: core (step 1)
   - PIN gate, sidebar navigation, sticky outlet + department scope bar
   - Remembered outlet, guarded outlet-scoped database helpers
   - Toasts, live-refresh scaffold, section registry
   Sections plug in with App.register(id, { render(root), refresh(), reset() }). */
(function () {
  "use strict";

  /* ---------- config ---------- */
  var SUPABASE_URL = "https://fcigsdjzyyrhxjfuyilc.supabase.co";
  var SUPABASE_ANON_KEY = "sb_publishable_Rc_eDYds1FWvEwM6kpujZA_LNjgUlbP";
  var ADMIN_PIN = "8888"; // unchanged, as agreed
  var OUTLET_STORE = "stocktake_admin_outlet";
  var LIVE_SECONDS = 30;

  var sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  /* ---------- small helpers ---------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  var IC = {
    dash: '<rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/>',
    upload: '<path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M4 20h16"/>',
    recon: '<path d="M3 3v18h18"/><path d="M7 15l4-5 3 3 5-7"/>',
    sessions: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
    exp: '<path d="M12 4v12"/><path d="M7 11l5 5 5-5"/><path d="M4 20h16"/>',
    clear: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>',
    check: '<path d="M5 12l5 5 9-10"/>',
    alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.5"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.5"/>',
    printer: '<path d="M7 9V3h10v6"/><rect x="4" y="9" width="16" height="8" rx="1"/><path d="M7 14h10v7H7z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>'
  };
  function icon(name) {
    return '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">' + IC[name] + "</svg>";
  }
  function toast(msg, type) {
    var el = document.createElement("div");
    el.className = "toast " + (type || "ok");
    el.innerHTML = icon(type === "err" ? "alert" : type === "info" ? "info" : "check") + "<span>" + esc(msg) + "</span>";
    $("#toasts").appendChild(el);
    setTimeout(function () {
      el.classList.add("out");
      setTimeout(function () { el.remove(); }, 260);
    }, type === "err" ? 6000 : 3800);
  }
  function pageHead(title, sub) {
    return '<div class="page-head"><h1>' + esc(title) + "</h1>" + (sub ? "<p>" + esc(sub) + "</p>" : "") + "</div>";
  }

  /* ---------- app state ---------- */
  var App = {
    outlets: [], depts: [],
    outletId: null, deptId: "",
    section: "dashboard", sections: {},
    paused: false, lastRefresh: Date.now(), renderToken: 0
  };

  function outletName() {
    var o = App.outlets.find(function (x) { return x.id === App.outletId; });
    return o ? o.name : "";
  }
  function deptName() {
    var d = App.depts.find(function (x) { return String(x.id) === String(App.deptId); });
    return d ? d.name : "";
  }

  /* ---------- outlet guard ----------
     Every database write in the admin goes through Scoped. It refuses to run
     without a selected outlet, always adds the outlet filter, and refuses a
     delete or update with no extra filter. Nothing here can touch another outlet. */
  function ScopeError(msg) { this.name = "ScopeError"; this.message = msg; }
  ScopeError.prototype = Object.create(Error.prototype);

  function requireScope(needDept) {
    if (App.outletId === null || App.outletId === undefined) throw new ScopeError("Choose an outlet first.");
    if (needDept && !App.deptId) throw new ScopeError("Choose a department first.");
    return { outletId: App.outletId, deptId: App.deptId || null };
  }
  function applyFilters(q, filters) {
    Object.keys(filters || {}).forEach(function (k) { q = q.eq(k, filters[k]); });
    return q;
  }
  var Scoped = {
    select: function (table, cols, opts) {
      var s = requireScope(false);
      return sb.from(table).select(cols || "*", opts).eq("outlet_id", s.outletId);
    },
    insert: function (table, rows) {
      var s = requireScope(false);
      var list = (Array.isArray(rows) ? rows : [rows]).map(function (r) {
        if (r.outlet_id != null && String(r.outlet_id) !== String(s.outletId)) {
          throw new ScopeError("A row belongs to a different outlet. Nothing was saved.");
        }
        return Object.assign({}, r, { outlet_id: s.outletId });
      });
      return sb.from(table).insert(list);
    },
    update: function (table, values, filters) {
      var s = requireScope(false);
      if (!filters || !Object.keys(filters).length) throw new ScopeError("Refusing to update without a filter.");
      return applyFilters(sb.from(table).update(values).eq("outlet_id", s.outletId), filters);
    },
    remove: function (table, filters) {
      var s = requireScope(false);
      if (!filters || !Object.keys(filters).length) throw new ScopeError("Refusing to delete without a filter.");
      return applyFilters(sb.from(table).delete().eq("outlet_id", s.outletId), filters);
    },

    /* scan_items has no outlet_id column, so ownership is proven through the session:
       every item read or write first confirms the gondola belongs to the selected outlet,
       then also pins the item to that session id. */
    assertSession: function (sessionId) {
      var s = requireScope(false);
      return Promise.resolve(
        sb.from("gondola_sessions").select("id").eq("id", sessionId).eq("outlet_id", s.outletId).maybeSingle()
      ).then(function (r) {
        if (r.error) throw r.error;
        if (!r.data) throw new ScopeError("That gondola does not belong to the selected outlet. Nothing was changed.");
        return true;
      });
    },
    scanItems: function (sessionId) {
      return Scoped.assertSession(sessionId).then(function () {
        return sb.from("scan_items").select("*").eq("session_id", sessionId).order("material");
      });
    },
    updateScanQty: function (sessionId, itemId, qty) {
      return Scoped.assertSession(sessionId).then(function () {
        return sb.from("scan_items").update({ qty: qty, updated_at: new Date().toISOString() })
          .eq("id", itemId).eq("session_id", sessionId).select().maybeSingle();
      });
    },
    deleteScanItem: function (sessionId, itemId) {
      return Scoped.assertSession(sessionId).then(function () {
        return sb.from("scan_items").delete().eq("id", itemId).eq("session_id", sessionId).select().maybeSingle();
      });
    }
  };
  function handleError(e) {
    if (e && e.name === "ScopeError") { toast(e.message, "err"); return; }
    console.error(e);
    toast("Something went wrong: " + ((e && e.message) || e), "err");
  }

  /* Supabase caps a single request at 1000 rows and truncates silently, so every list that can
     grow goes through this. makeQuery(from, to) must return a query with a stable order applied. */
  function fetchAllPages(makeQuery) {
    var PAGE = 1000, out = [];
    function step(from) {
      return Promise.resolve(makeQuery(from, from + PAGE - 1)).then(function (r) {
        if (r.error) throw r.error;
        var d = r.data || [];
        out = out.concat(d);
        return d.length === PAGE ? step(from + PAGE) : out;
      });
    }
    return step(0);
  }

  /* ---------- navigation ---------- */
  var NAV = [
    { id: "dashboard", label: "Dashboard", icon: "dash" },
    { id: "uploads", label: "Uploads", icon: "upload", n: 1 },
    { id: "sessions", label: "Sessions", icon: "sessions", n: 2 },
    { id: "recon", label: "Reconciliation", icon: "recon", n: 3 },
    { id: "export", label: "Export", icon: "exp", n: 4 },
    { id: "clear", label: "Clear", icon: "clear", n: 5 }
  ];
  App.badges = {}; // e.g. { sessions: { text: "3 open", warn: false } }, filled by sections later

  function renderNav() {
    var h = "";
    NAV.forEach(function (it, i) {
      if (i === 1) h += '<div class="nav-label" style="margin-top:14px">Stocktake steps</div>';
      var b = App.badges[it.id];
      h += '<button type="button" data-nav="' + it.id + '"' + (App.section === it.id ? ' aria-current="page"' : "") + ">" +
        (it.n ? '<span class="n">' + it.n + "</span>" : "") + icon(it.icon) +
        '<span class="lbl">' + it.label + "</span>" +
        (b ? '<span class="badge' + (b.warn ? " warn" : "") + '">' + esc(b.text) + "</span>" : "") + "</button>";
    });
    $("#nav").innerHTML = h;
  }

  function go(id) {
    if (!App.sections[id]) id = "dashboard";
    App.section = id;
    if (location.hash !== "#" + id) history.replaceState(null, "", "#" + id);
    render();
    window.scrollTo(0, 0);
  }

  /* ---------- scope bar ---------- */
  function persistOutlet() {
    try {
      if (App.outletId === null) localStorage.removeItem(OUTLET_STORE);
      else localStorage.setItem(OUTLET_STORE, String(App.outletId));
    } catch (e) { /* storage may be blocked; the app still works */ }
  }
  function restoreOutlet() {
    var saved = null;
    try { saved = localStorage.getItem(OUTLET_STORE); } catch (e) { /* ignore */ }
    var match = saved === null ? null : App.outlets.find(function (o) { return String(o.id) === saved; });
    if (match) App.outletId = match.id;
    else if (App.outlets.length === 1) App.outletId = App.outlets[0].id;
    else App.outletId = null;
  }
  function renderScope() {
    var os = $("#g-outlet");
    os.innerHTML = (App.outletId === null ? '<option value="">Choose outlet…</option>' : "") +
      App.outlets.map(function (o) { return '<option value="' + esc(o.id) + '">' + esc(o.name) + "</option>"; }).join("");
    os.value = App.outletId === null ? "" : String(App.outletId);

    var ds = $("#g-dept");
    ds.innerHTML = '<option value="">All departments</option>' +
      App.depts.map(function (d) { return '<option value="' + esc(d.id) + '">' + esc(d.name) + "</option>"; }).join("");
    ds.value = App.deptId === "" ? "" : String(App.deptId);
    ds.disabled = App.outletId === null;

    $("#side-scope").innerHTML = App.outletId === null
      ? '<div class="k">Working on</div><div class="o">No outlet chosen</div>'
      : '<div class="k">Working on</div><div class="o">' + esc(outletName()) + '</div><div class="d">' + esc(deptName() || "All departments") + "</div>";
  }
  function closeOverlays() {
    $("#drawer").hidden = true; $("#drawer").innerHTML = "";
    $("#modal").hidden = true; $("#modal").innerHTML = "";
    $("#scrim").hidden = true;
    var s = App.sections[App.section];
    if (s && s.closeOverlays) s.closeOverlays();
  }
  function resetSections() {
    Object.keys(App.sections).forEach(function (k) {
      if (App.sections[k].reset) App.sections[k].reset();
    });
    App.badges = {};
  }
  function setOutlet(idStr) {
    var o = App.outlets.find(function (x) { return String(x.id) === idStr; });
    var next = o ? o.id : null;
    if (next === App.outletId) return;
    App.outletId = next;
    App.deptId = "";
    persistOutlet();
    closeOverlays();
    resetSections();
    renderScope();
    render();
    if (o) toast("Now working on " + o.name + ".", "info");
  }
  function setDept(idStr) {
    App.deptId = idStr;
    closeOverlays();
    renderScope();
    render();
  }

  /* ---------- rendering ---------- */
  function renderChooser(root) {
    root.innerHTML = '<div class="choose">' + pageHead("Which outlet are you working on?", "Everything you do here applies to one outlet only. Your choice is remembered on this browser.") +
      '<div class="choose-grid">' + App.outlets.map(function (o) {
        return '<button type="button" class="choose-btn" data-choose="' + esc(o.id) + '"><span class="eyebrow">Outlet</span><b>' + esc(o.name) + "</b></button>";
      }).join("") + "</div></div>";
  }
  function render() {
    App.renderToken++;
    App.lastRefresh = Date.now();
    renderNav();
    var root = $("#content");
    if (App.outletId === null) { renderChooser(root); tick(); return; }
    var sec = App.sections[App.section];
    root.innerHTML = "";
    try { sec.render(root); } catch (e) { handleError(e); }
    tick();
  }
  function showFatal(msg) {
    $("#content").innerHTML = '<div class="note err" style="max-width:640px">' + icon("alert") +
      "<span>" + esc(msg) + ' <button class="btn sm" type="button" id="retry-init" style="margin-left:8px">Retry</button></span></div>';
    var r = $("#retry-init");
    if (r) r.addEventListener("click", init);
  }

  /* ---------- live refresh scaffold ---------- */
  function startLive() {
    setInterval(tick, 1000);
    $("#live-btn").addEventListener("click", function () {
      App.paused = !App.paused;
      App.lastRefresh = Date.now();
      $("#live-btn").textContent = App.paused ? "Resume" : "Pause";
      $("#live").classList.toggle("paused", App.paused);
      tick();
    });
  }
  function tick() {
    var box = $("#live");
    if (!box) return;
    var sec = App.sections[App.section];
    var show = !!(sec && sec.refresh) && App.outletId !== null;
    box.hidden = !show;
    if (!show) return;
    var txt = $("#live-txt");
    if (App.paused) { txt.textContent = "Auto-refresh paused"; return; }
    if (document.hidden) return;
    var s = Math.floor((Date.now() - App.lastRefresh) / 1000);
    if (s >= LIVE_SECONDS) {
      App.lastRefresh = Date.now();
      s = 0;
      var dot = $("#live-dot");
      dot.classList.add("pulse");
      setTimeout(function () { dot.classList.remove("pulse"); }, 900);
      try { sec.refresh(); } catch (e) { handleError(e); }
    }
    txt.textContent = "Live · updated " + s + "s ago · every " + LIVE_SECONDS + "s";
  }

  /* ---------- section registry ---------- */
  function register(id, def) { App.sections[id] = def; }

  function placeholder(title, step, points) {
    return {
      render: function (root) {
        root.innerHTML = pageHead(title, "Step " + step + " of the overhaul. Not built yet.") +
          '<section class="panel"><div class="panel-h"><h2>What will be here</h2></div><div class="panel-b"><ul style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px">' +
          points.map(function (p) { return "<li>" + esc(p) + "</li>"; }).join("") + "</ul></div></section>";
      }
    };
  }

  /* Dashboard (step 1 version): connection and outlet scope check.
     The real dashboard and checklist arrive in step 5. */
  var dashRoot = null;
  function countQuery(table, extra) {
    var q = Scoped.select(table, "id", { count: "exact", head: true });
    if (App.deptId) q = q.eq("department_id", App.deptId);
    return extra ? extra(q) : q;
  }
  function loadScopeCheck() {
    var root = dashRoot;
    if (!root) return;
    var token = App.renderToken;
    var body = $("#sc-body", root);
    Promise.all([
      countQuery("gondola_sessions"),
      countQuery("gondola_sessions", function (q) { return q.eq("status", "in_progress"); }),
      countQuery("gondola_sessions", function (q) { return q.eq("status", "done"); }),
      countQuery("sap_uploads")
    ]).then(function (r) {
      if (token !== App.renderToken || !body) return; // outlet or section changed while loading
      var bad = r.find(function (x) { return x.error; });
      if (bad) throw bad.error;
      body.innerHTML = '<div class="tiles" style="margin-bottom:12px">' +
        tile("Gondola sessions", r[0].count) + tile("In progress", r[1].count) + tile("Done", r[2].count) + tile("MI24 rows", r[3].count) + "</div>" +
        '<div class="note ok">' + icon("check") + "<span>Connected. These counts come from " + esc(outletName()) + " only. No other outlet is queried.</span></div>";
    }).catch(function (e) {
      if (token !== App.renderToken || !body) return;
      body.innerHTML = '<div class="note err">' + icon("alert") + "<span>Could not load counts: " + esc((e && e.message) || e) + "</span></div>";
    });
  }
  function tile(k, v) { return '<div class="tile"><span class="k">' + esc(k) + '</span><span class="v">' + (v == null ? "—" : v) + "</span></div>"; }

  register("dashboard", {
    render: function (root) {
      dashRoot = root;
      root.innerHTML = pageHead("Dashboard", "Step 1 check: connection and outlet scope. The full dashboard and checklist arrive in step 5.") +
        '<section class="panel"><div class="panel-h"><h2>' + esc(outletName()) + " · " + esc(deptName() || "All departments") +
        '</h2><p>Switch outlet or department in the bar above and compare the numbers.</p></div><div class="panel-b" id="sc-body">Loading…</div></section>';
      loadScopeCheck();
    },
    refresh: loadScopeCheck,
    reset: function () { dashRoot = null; }
  });
  register("uploads", placeholder("Uploads", 4, ["MASTER LIST update (shared across outlets)", "MI24 upload for the selected outlet and department", "What is already on file per department"]));
  register("sessions", placeholder("Sessions", 2, ["Search, filter and sort every gondola", "Detail panel to correct or delete counts", "Print button on each row, A4 report with Verified by box on the last page"]));
  register("recon", placeholder("Reconciliation", 3, ["Book vs counted with a variance column", "Filters for variance, zero count and unmatched scans"]));
  register("export", placeholder("Export", 4, ["Summary and preview, then download the .xlsx for SAP"]));
  register("clear", placeholder("Clear", 4, ["Delete one outlet and department after the count, with the 4-character confirm code"]));

  /* ---------- boot ---------- */
  function init() {
    Promise.all([
      sb.from("outlets").select("id, name").order("name"),
      sb.from("departments").select("id, name").order("name")
    ]).then(function (r) {
      if (r[0].error) throw r[0].error;
      if (r[1].error) throw r[1].error;
      App.outlets = r[0].data || [];
      App.depts = r[1].data || [];
      if (!App.outlets.length) { showFatal("No outlets found in the database."); return; }
      restoreOutlet();
      renderScope();
      var fromHash = (location.hash || "").replace("#", "");
      App.section = App.sections[fromHash] ? fromHash : "dashboard";
      render();
    }).catch(function () {
      showFatal("Could not load outlets and departments. Check the connection and retry.");
    });
  }

  function unlock() {
    $("#gate").hidden = true;
    $("#shell").hidden = false;
    startLive();
    init();
  }

  document.addEventListener("click", function (e) {
    var n = e.target.closest("[data-nav]");
    if (n) { go(n.dataset.nav); return; }
    var c = e.target.closest("[data-choose]");
    if (c) { setOutlet(c.dataset.choose); }
  });
  document.addEventListener("change", function (e) {
    if (e.target.id === "g-outlet") setOutlet(e.target.value);
    else if (e.target.id === "g-dept") setDept(e.target.value);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeOverlays();
  });
  $("#scrim").addEventListener("click", closeOverlays);
  $("#modal").addEventListener("click", function (e) {
    if (e.target.id === "modal") closeOverlays();
  });
  window.addEventListener("hashchange", function () {
    var id = (location.hash || "").replace("#", "");
    if (App.sections[id] && id !== App.section && !$("#shell").hidden) { App.section = id; render(); }
  });

  $("#pin-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var input = $("#pin-input");
    if (input.value.trim() === ADMIN_PIN) { unlock(); return; }
    $("#pin-err").textContent = "Incorrect PIN. Try again.";
    input.value = "";
    input.focus();
  });
  $("#pin-input").focus();

  /* exposed for the later steps and for debugging in the browser console */
  App.sb = sb; App.Scoped = Scoped; App.toast = toast; App.esc = esc; App.icon = icon; App.pageHead = pageHead;
  App.fetchAllPages = fetchAllPages;
  App.register = register; App.go = go; App.handleError = handleError; App.requireScope = requireScope;
  App.outletName = outletName; App.deptName = deptName; App.renderNav = renderNav; App.closeOverlays = closeOverlays;
  window.StockTakeAdmin = App;
})();
