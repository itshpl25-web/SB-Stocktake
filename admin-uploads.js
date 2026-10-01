/* StockTake Admin: Uploads (step 4)
   1. MASTER LIST  - shared by every outlet (products have no outlet). One department per file.
   2. MI24         - belongs to the selected outlet + department. Replaces what is on file for that pair only.
   3. Data on file - what is loaded, per department, for the selected outlet.
   Columns are found by header NAME, never by fixed position, and the mapping is shown before anything is saved. */
(function () {
  "use strict";
  var App = window.StockTakeAdmin;
  if (!App) return;
  var Scoped = App.Scoped, esc = App.esc, icon = App.icon, sb = App.sb;
  function $(s, r) { return (r || document).querySelector(s); }

  var CHUNK = 500;

  /* ---------- field definitions ---------- */
  // alias = exact normalised header names, in priority order. prefix = header starts with. legacy = the old fixed column.
  var MASTER_FIELDS = [
    { k: "barcode", label: "Barcode", req: true, legacy: 4, alias: ["barcode", "ean", "eanupc", "eanupccode", "internationalarticlenumber", "internationalarticlenumberean", "gtin", "upc"], prefix: ["eanupc", "internationalarticle"] },
    { k: "material", label: "Material", req: true, legacy: 2, alias: ["material", "materialnumber", "materialno", "articlenumber", "article"] },
    { k: "description", label: "Description", req: true, legacy: 3, alias: ["materialdescription", "description", "articledescription", "desc"] },
    { k: "material_group", label: "Material group", req: false, legacy: 37, alias: ["materialgroup", "matlgroup", "matgroup"] },
    { k: "uom", label: "UOM (pack unit)", req: true, legacy: 7, alias: ["alternativeunitofmeasure", "alternateunitofmeasure", "altuom", "alternativeuom", "aun", "unitofmeasure", "uom", "baseunitofmeasure", "baseuom"], prefix: ["alternativeunit"] },
    { k: "numerator", label: "Numerator", req: true, legacy: 8, alias: ["numerator", "counter"], prefix: ["numeratorfor", "numerator"] }
  ];
  var SAP_FIELDS = [
    { k: "phys_inventory_doc", label: "Phys. inventory doc.", req: true, legacy: 0, alias: ["physinventorydoc", "physinventorydocument", "physicalinventorydocument", "physicalinventorydoc"], prefix: ["physinv", "physicalinv"] },
    { k: "item", label: "Item", req: false, legacy: 1, alias: ["item", "itemno"] },
    { k: "material", label: "Material", req: true, legacy: 2, alias: ["material", "materialnumber", "materialno"] },
    { k: "description", label: "Description", req: true, legacy: 5, alias: ["materialdescription", "description"] },
    { k: "batch", label: "Batch", req: false, legacy: 6, alias: ["batch"] },
    { k: "plant", label: "Plant", req: false, legacy: 7, alias: ["plant"] },
    { k: "storage_location", label: "Storage location", req: false, legacy: 8, alias: ["storagelocation", "sloc", "storagelocationcode"] },
    { k: "special_stock", label: "Special stock", req: false, legacy: 9, alias: ["specialstock"] },
    { k: "base_uom", label: "Base unit of measure", req: false, legacy: 12, alias: ["baseunitofmeasure", "baseuom", "unitofmeasure", "uom"] },
    { k: "book_quantity", label: "Book quantity", req: true, legacy: 13, alias: ["bookquantity", "bookqty", "bookquantityinbaseunit"], prefix: ["bookq"] }
  ];

  /* ---------- helpers ---------- */
  function norm(h) { return String(h == null ? "" : h).toLowerCase().replace(/[^a-z0-9]/g, ""); }
  function str(v) { return v == null ? "" : String(v).trim(); }
  function letter(i) { var s = "", n = i + 1; while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
  /* "1,234.5" -> 1234.5 ; "1,5" is left alone (could be a decimal comma) and reads as NaN unless plain */
  function toNum(v) {
    if (v == null) return NaN;
    var t = String(v).trim();
    if (t === "") return NaN;
    if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, "");
    return Number(t);
  }
  function ddmmyyyy(iso) { var p = String(iso || "").split("-"); return p.length === 3 ? p[2] + "." + p[1] + "." + p[0] : ""; }
  function todayISO() { var d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  function fmt(n) { return Number(n).toLocaleString("en-US"); }
  function chunk(a, n) { var o = []; for (var i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }

  function detect(fields, headers, allowLegacy) {
    var nh = headers.map(norm), used = {}, out = {};
    fields.forEach(function (f) {
      var idx = -1, a, j;
      for (a = 0; a < f.alias.length && idx < 0; a++) { var i = nh.indexOf(f.alias[a]); if (i > -1 && !used[i]) idx = i; }
      if (idx < 0 && f.prefix) {
        for (a = 0; a < f.prefix.length && idx < 0; a++) {
          for (j = 0; j < nh.length; j++) { if (!used[j] && nh[j].indexOf(f.prefix[a]) === 0) { idx = j; break; } }
        }
      }
      var how = "name";
      if (idx < 0 && allowLegacy && f.legacy < headers.length && !used[f.legacy]) { idx = f.legacy; how = "legacy"; }
      if (idx > -1) { used[idx] = true; out[f.k] = { i: idx, how: how }; } else out[f.k] = { i: -1, how: "none" };
    });
    return out;
  }

  /* ---------- state ---------- */
  function freshFile(kind) {
    return { kind: kind, name: "", raw: null, headers: [], sel: {}, how: {}, parsed: null, log: [], prog: null, busy: false,
      dept: null, newName: "", date: todayISO(), exist: { state: "idle", map: {}, sig: "" } };
  }
  var UM = freshFile("m"), US = freshFile("s");
  var OF = { key: null, rows: [], loaded: false, loading: false, error: null };
  var token = 0;

  function fresh() { UM = freshFile("m"); US = freshFile("s"); OF = { key: null, rows: [], loaded: false, loading: false, error: null }; }

  /* ---------- reading a file ---------- */
  function readFile(kind, file) {
    var S = kind === "m" ? UM : US;
    if (S.busy) { App.toast("Wait for the running upload to finish.", "err"); return; }
    if (!window.XLSX) { App.toast("The Excel reader did not load. Check the connection and reload the page.", "err"); return; }
    var reader = new FileReader();
    reader.onerror = function () { App.toast("Could not read that file.", "err"); };
    reader.onload = function (e) {
      try {
        var wb = window.XLSX.read(new Uint8Array(e.target.result), { type: "array" });
        var sheet = wb.Sheets[wb.SheetNames[0]];
        var rows = window.XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
        if (rows.length < 2) { App.toast("That file looks empty.", "err"); return; }
        var fields = kind === "m" ? MASTER_FIELDS : SAP_FIELDS;
        S.name = file.name; S.raw = rows; S.headers = rows[0].map(str);
        var det = detect(fields, S.headers, kind === "s"); // MI24 falls back to its old layout; MASTER never guesses by position
        S.sel = {}; S.how = {};
        fields.forEach(function (f) { S.sel[f.k] = det[f.k].i > -1 ? String(det[f.k].i) : ""; S.how[f.k] = det[f.k].how; });
        S.log = []; S.prog = null;
        if (kind === "m") { S.exist = { state: "idle", map: {}, sig: "" }; }
        paintDrop(kind); paintMap(kind); paintInfo(kind); paintLog(kind);
        if (kind === "m") ensureExisting();
      } catch (err) {
        console.error(err);
        App.toast("Could not read that Excel file: " + ((err && err.message) || err), "err");
      }
    };
    reader.readAsArrayBuffer(file);
  }

  /* ---------- parsing with the chosen columns ---------- */
  function cell(row, sel, k) { var i = sel[k]; return i === "" || i == null ? "" : row[Number(i)]; }

  function parseMaster(M) {
    var out = { rows: [], blockers: [], warns: [], skipped: 0, dups: 0 };
    MASTER_FIELDS.forEach(function (f) { if (f.req && M.sel[f.k] === "") out.blockers.push("Choose the column for " + f.label + "."); });
    if (out.blockers.length) return out;
    var seen = {}, badNum = 0, numericUom = 0, emptyUom = 0;
    for (var i = 1; i < M.raw.length; i++) {
      var row = M.raw[i], barcode = str(cell(row, M.sel, "barcode"));
      if (!barcode) { if (str(cell(row, M.sel, "material"))) out.skipped++; continue; }
      var n = toNum(cell(row, M.sel, "numerator"));
      if (!(n > 0)) { n = 1; badNum++; }
      var uom = str(cell(row, M.sel, "uom"));
      if (!uom) emptyUom++; else if (/^[\d.,\-\s]+$/.test(uom)) numericUom++;
      if (seen[barcode]) out.dups++;
      seen[barcode] = { barcode: barcode, material: str(cell(row, M.sel, "material")), description: str(cell(row, M.sel, "description")),
        material_group: str(cell(row, M.sel, "material_group")), uom: uom, numerator: n };
    }
    out.rows = Object.keys(seen).map(function (k) { return seen[k]; });
    var total = out.rows.length || 1;
    if (numericUom / total > 0.2) out.blockers.push("The UOM column (" + hdr(M, "uom") + ") is mostly numbers. That looks like the wrong column, for example a cost. Pick the right one.");
    if (emptyUom / total > 0.5) out.warns.push("More than half of the rows have an empty UOM (" + hdr(M, "uom") + "). Check the column.");
    if (badNum) out.warns.push(badNum + " row(s) have no usable numerator and will be saved with numerator 1.");
    if (out.dups) out.warns.push(out.dups + " barcode(s) appear more than once in the file. The last occurrence is used.");
    if (out.skipped) out.warns.push(out.skipped + " row(s) with no barcode are skipped.");
    if (!out.rows.length) out.blockers.push("No rows with a barcode were found.");
    return out;
  }
  function hdr(S, k) { var i = S.sel[k]; return i === "" ? "none" : (S.headers[Number(i)] || "blank") + " / col " + letter(Number(i)); }

  function parseSap(S) {
    var out = { rows: [], blockers: [], warns: [], skipped: 0 };
    SAP_FIELDS.forEach(function (f) { if (f.req && S.sel[f.k] === "") out.blockers.push("Choose the column for " + f.label + "."); });
    if (out.blockers.length) return out;
    var badBook = 0, noMat = 0;
    for (var i = 1; i < S.raw.length; i++) {
      var row = S.raw[i];
      if (!str(cell(row, S.sel, "phys_inventory_doc")) && !str(cell(row, S.sel, "material"))) { out.skipped++; continue; }
      var material = str(cell(row, S.sel, "material"));
      if (!material) { noMat++; continue; }
      var bq = toNum(cell(row, S.sel, "book_quantity"));
      if (isNaN(bq)) badBook++;
      out.rows.push({
        phys_inventory_doc: cell(row, S.sel, "phys_inventory_doc"), item: cell(row, S.sel, "item"), material: cell(row, S.sel, "material"),
        description: cell(row, S.sel, "description"), batch: cell(row, S.sel, "batch"), plant: cell(row, S.sel, "plant"),
        storage_location: cell(row, S.sel, "storage_location"), special_stock: cell(row, S.sel, "special_stock"),
        base_uom: cell(row, S.sel, "base_uom"), book_quantity: isNaN(bq) ? null : bq
      });
    }
    if (noMat) out.warns.push(noMat + " row(s) with no material number are skipped.");
    if (badBook) out.warns.push(badBook + " row(s) have a blank or non-numeric book quantity. They are saved as blank, which reconciliation reads as 0.");
    if (!out.rows.length) out.blockers.push("No MI24 rows were found.");
    return out;
  }

  /* Barcodes from THIS file that already exist in the products table, to warn before one is moved to another
     department. Only the file's own barcodes are looked up (in small batches, a few at a time), never the whole
     products table. It re-runs whenever the file or the Barcode column changes. */
  function ensureExisting() {
    var M = UM, P = M.parsed;
    if (!P || !P.rows.length || P.blockers.length) return;
    var sig = P.rows.length + "|" + P.rows[0].barcode + "|" + P.rows[P.rows.length - 1].barcode;
    if (M.exist.sig === sig && M.exist.state !== "idle") return;
    loadExisting(M, P.rows.map(function (r) { return r.barcode; }), sig);
  }
  function loadExisting(M, codes, sig) {
    var map = {}, done = 0, i = 0, BATCH = 250, LANES = 4;
    M.exist = { state: "loading", map: map, sig: sig, done: 0, total: codes.length };
    paintExist();
    function stale() { return M !== UM || M.exist.sig !== sig || M.exist.state === "error"; }
    function lane() {
      if (stale() || i >= codes.length) return Promise.resolve();
      var part = codes.slice(i, i + BATCH); i += BATCH;
      return Promise.resolve(sb.from("products").select("barcode, department_id").in("barcode", part)).then(function (r) {
        if (r.error) throw r.error;
        (r.data || []).forEach(function (x) { map[String(x.barcode)] = x.department_id; });
        done += part.length;
        if (!stale()) { M.exist.done = done; paintExist(); }
        return lane();
      });
    }
    var lanes = [];
    for (var k = 0; k < LANES; k++) lanes.push(lane());
    Promise.all(lanes).then(function () {
      if (M !== UM || M.exist.sig !== sig) return;
      M.exist.state = "ready"; paintExist();
    }).catch(function () {
      if (M !== UM || M.exist.sig !== sig) return;
      M.exist = { state: "error", map: {}, sig: sig }; paintExist();
    });
  }
  function paintExist() {
    var el = $("#m-exist"); if (!el) return;
    var P = UM.parsed;
    el.innerHTML = P && P.rows.length ? existSummary(UM, P.rows) : "";
    paintBtn("m");
  }
  function masterDeptId() {
    var v = UM.dept == null ? String(App.deptId || "") : UM.dept;
    return v === "__new__" ? "" : v;
  }
  function existSummary(M, rows) {
    if (M.exist.state === "loading") return '<div class="note">' + icon("info") + "<span>Checking which barcodes already exist… " + fmt(M.exist.done || 0) + " of " + fmt(M.exist.total || 0) + "</span></div>";
    if (M.exist.state === "error") return '<div class="note warn">' + icon("alert") + "<span>Could not check existing barcodes. You can still upload, but barcodes that exist under another department would move.</span></div>";
    if (M.exist.state !== "ready") return "";
    var d = masterDeptId(), fresh = 0, same = 0, moved = {};
    rows.forEach(function (r) {
      var cur = M.exist.map[r.barcode];
      if (cur === undefined) fresh++;
      else if (d !== "" && String(cur) === d) same++;
      else if (d === "") same++;
      else { var nm = (App.depts.find(function (x) { return String(x.id) === String(cur); }) || {}).name || "another department"; moved[nm] = (moved[nm] || 0) + 1; }
    });
    var names = Object.keys(moved), mv = names.reduce(function (a, k) { return a + moved[k]; }, 0);
    var h = '<div class="note ok">' + icon("check") + "<span><b>" + fmt(fresh) + "</b> new · <b>" + fmt(same) + "</b> update in place" + (d === "" ? " (department not chosen yet)" : "") + ".</span></div>";
    if (mv) h += '<div class="note warn" style="margin-top:8px">' + icon("alert") + "<span><b>" + fmt(mv) + "</b> barcode(s) currently belong to another department and will MOVE to the one you chose: " +
      names.map(function (n) { return esc(n) + " (" + moved[n] + ")"; }).join(", ") + ".</span></div>";
    return h;
  }

  /* ---------- painting ---------- */
  function paintDrop(kind) {
    var S = kind === "m" ? UM : US, el = $("#" + kind + "-drop"); if (!el) return;
    var t = $(".drop-t", el);
    t.innerHTML = S.raw
      ? "<b>" + esc(S.name) + "</b><span>" + fmt(S.raw.length - 1) + " data rows · click or drop to choose another file</span>"
      : "<b>Drop the " + (kind === "m" ? "MASTER LIST" : "MI24") + " Excel file here</b><span>or click to choose a file (.xlsx / .xls)</span>";
    el.classList.toggle("has", !!S.raw);
  }
  function paintMap(kind) {
    var S = kind === "m" ? UM : US, el = $("#" + kind + "-map"); if (!el) return;
    if (!S.raw) { el.innerHTML = ""; return; }
    var fields = kind === "m" ? MASTER_FIELDS : SAP_FIELDS;
    var attention = fields.some(function (f) { return (S.sel[f.k] === "" && f.req) || S.how[f.k] === "legacy"; });
    var rows = fields.map(function (f) {
      var opts = '<option value="">— not used —</option>' + S.headers.map(function (h, i) {
        return '<option value="' + i + '"' + (S.sel[f.k] === String(i) ? " selected" : "") + ">" + letter(i) + " · " + esc(h || "(blank)") + "</option>";
      }).join("");
      var tag = S.sel[f.k] === "" ? (f.req ? '<span class="pill crit"><i></i>Choose a column</span>' : '<span class="pill info"><i></i>Optional</span>')
        : S.how[f.k] === "legacy" ? '<span class="pill warn"><i></i>Not found by name, using old column ' + letter(f.legacy) + "</span>"
        : S.how[f.k] === "manual" ? '<span class="pill info"><i></i>Chosen by you</span>'
        : Number(S.sel[f.k]) !== f.legacy ? '<span class="pill info"><i></i>By name (old layout used column ' + letter(f.legacy) + ")</span>"
        : '<span class="pill ok"><i></i>By name</span>';
      return '<div class="maprow"><span class="ml">' + esc(f.label) + (f.req ? " *" : "") + '</span><select data-up-map="' + kind + '" data-k="' + f.k + '" aria-label="Column for ' + esc(f.label) + '">' + opts + "</select>" + tag + "</div>";
    }).join("");
    el.innerHTML = '<details class="mapping"' + (attention ? " open" : "") + "><summary>Column mapping" + (attention ? " · check these" : " · all columns set") + "</summary>" + rows + "</details>";
  }
  function sampleTable(cols, rows) {
    return '<div class="tablewrap sample"><table class="dt compact"><thead><tr>' + cols.map(function (c) { return '<th class="plain' + (c.n ? " num" : "") + '">' + c.l + "</th>"; }).join("") +
      "</tr></thead><tbody>" + rows.map(function (r) {
        return "<tr>" + cols.map(function (c) { return '<td class="' + (c.n ? "num" : "") + '">' + esc(r[c.k] == null ? "" : r[c.k]) + "</td>"; }).join("") + "</tr>";
      }).join("") + "</tbody></table></div>";
  }
  function paintInfo(kind) {
    var S = kind === "m" ? UM : US, el = $("#" + kind + "-info"); if (!el) return;
    if (!S.raw) { el.innerHTML = ""; paintBtn(kind); return; }
    var P = kind === "m" ? parseMaster(S) : parseSap(S);
    S.parsed = P;
    var h = "";
    P.blockers.forEach(function (b) { h += '<div class="note err" style="margin-bottom:8px">' + icon("alert") + "<span>" + esc(b) + "</span></div>"; });
    P.warns.forEach(function (b) { h += '<div class="note warn" style="margin-bottom:8px">' + icon("alert") + "<span>" + esc(b) + "</span></div>"; });
    if (P.rows.length) {
      h += '<p class="muted small" style="margin:10px 0 6px"><b>' + fmt(P.rows.length) + "</b> rows ready. First rows as they will be saved:</p>";
      h += kind === "m"
        ? sampleTable([{ k: "barcode", l: "Barcode" }, { k: "material", l: "Material" }, { k: "description", l: "Description" }, { k: "uom", l: "UOM" }, { k: "numerator", l: "Numerator", n: 1 }, { k: "material_group", l: "Group" }], P.rows.slice(0, 5))
        : sampleTable([{ k: "material", l: "Material" }, { k: "description", l: "Description" }, { k: "base_uom", l: "Base UOM" }, { k: "book_quantity", l: "Book qty", n: 1 }, { k: "plant", l: "Plant" }, { k: "storage_location", l: "SLoc" }], P.rows.slice(0, 5));
      if (kind === "m") h += '<div id="m-exist" style="margin-top:10px"></div>';
    }
    el.innerHTML = h;
    if (kind === "m") paintExist();
    paintBtn(kind);
  }
  function paintBtn(kind) {
    var b = $("#" + kind + "-go"); if (!b) return;
    var S = kind === "m" ? UM : US, P = S.parsed, ok = !!(P && P.rows.length && !P.blockers.length) && !S.busy;
    if (kind === "m") {
      var d = UM.dept == null ? String(App.deptId || "") : UM.dept;
      ok = ok && (d === "__new__" ? UM.newName.trim() !== "" : d !== "") && (UM.exist.state === "ready" || UM.exist.state === "error");
      b.innerHTML = S.busy ? "Updating MASTER LIST…" : "Update MASTER LIST";
    } else {
      ok = ok && !!App.deptId && !!US.date;
      b.innerHTML = S.busy ? "Replacing MI24 data…" : "Replace MI24 data" + (App.deptId ? " for " + esc(App.deptName()) : "");
    }
    b.disabled = !ok;
  }
  function paintLog(kind) {
    var S = kind === "m" ? UM : US, el = $("#" + kind + "-log"), pr = $("#" + kind + "-prog"); if (!el) return;
    el.hidden = !S.log.length;
    el.innerHTML = S.log.map(function (l) { return '<div class="' + (l.c || "") + '">' + esc(l.m) + "</div>"; }).join("");
    el.scrollTop = el.scrollHeight;
    if (pr) {
      pr.hidden = !S.prog;
      if (S.prog) $("i", pr).style.width = Math.round(100 * S.prog[0] / Math.max(1, S.prog[1])) + "%";
    }
  }
  function say(S, msg, cls) { S.log.push({ m: msg, c: cls }); paintLog(S.kind); }

  /* ---------- page ---------- */
  function ctxChips(withDept) {
    return '<div class="ctx"><span>Outlet <b>' + esc(App.outletName()) + "</b></span>" +
      (withDept ? "<span>Department <b>" + esc(App.deptName() || "not chosen") + "</b></span>" : "") + "</div>";
  }
  function dropZone(kind) {
    return '<label class="drop" id="' + kind + '-drop" data-kind="' + kind + '"><input type="file" class="sr" accept=".xlsx,.xls" data-up-file="' + kind + '">' +
      icon("upload") + '<span class="drop-t"></span></label>';
  }
  function deptOptsHTML() {
    return '<option value="">Select department…</option>' + App.depts.map(function (d) { return '<option value="' + esc(d.id) + '">' + esc(d.name) + "</option>"; }).join("") +
      '<option value="__new__">+ Add new department…</option>';
  }
  /* After a department is created (or an existing one reused) the picker must show it and stop offering "new". */
  function syncDeptSelect() {
    var sel = $("#m-dept"); if (!sel) return;
    sel.innerHTML = deptOptsHTML();
    sel.value = UM.dept == null ? "" : UM.dept;
    $("#m-new-wrap").hidden = sel.value !== "__new__";
    if (sel.value !== "__new__") { UM.newName = ""; var nd = $("#m-newdept"); if (nd) nd.value = ""; }
  }
  function render(root) {
    var deptOpts = deptOptsHTML();
    var haveDept = !!App.deptId;
    root.innerHTML = App.pageHead("Uploads", "Load the reference data first: the MASTER LIST (shared), then the MI24 book list for one outlet and department.") +

      '<section class="panel"><div class="panel-h"><h2>1 · MASTER LIST</h2><p>The SAP material master for one department. Existing barcodes update in place, new ones are added.</p></div><div class="panel-b">' +
      '<div class="note warn" style="margin-bottom:14px">' + icon("alert") + "<span><b>Shared by every outlet.</b> Products have no outlet, so updating the MASTER LIST changes product details for all outlets, not only " + esc(App.outletName()) + ".</span></div>" +
      '<div class="grid2f"><label class="field"><span>Department for this file</span><select id="m-dept">' + deptOpts + "</select></label>" +
      '<label class="field" id="m-new-wrap" hidden><span>New department name</span><input type="text" id="m-newdept" placeholder="e.g. FROZEN" autocomplete="off" style="text-transform:uppercase"></label></div>' +
      dropZone("m") + '<div id="m-map"></div><div id="m-info"></div>' +
      '<div class="actions"><button type="button" class="btn btn-primary" id="m-go" data-up="go-m" disabled>Update MASTER LIST</button></div>' +
      '<div class="prog" id="m-prog" hidden><i></i></div><div class="log" id="m-log" hidden></div></div></section>' +

      '<section class="panel"><div class="panel-h"><h2>2 · MI24 book list</h2><p>Physical inventory data from SAP. Replaces the MI24 data on file for this outlet and department only.</p></div><div class="panel-b">' +
      ctxChips(true) +
      (haveDept ? "" : '<div class="note warn" style="margin-bottom:14px">' + icon("alert") + "<span>Choose a department in the bar above. MI24 always belongs to one outlet and one department.</span></div>") +
      '<label class="field" style="max-width:240px"><span>Count date (applies to every row)</span><input type="date" id="s-date"></label>' +
      '<div id="s-replace"></div>' + dropZone("s") + '<div id="s-map"></div><div id="s-info"></div>' +
      '<div class="actions"><button type="button" class="btn btn-primary" id="s-go" data-up="go-s" disabled>Replace MI24 data</button></div>' +
      '<div class="prog" id="s-prog" hidden><i></i></div><div class="log" id="s-log" hidden></div></div></section>' +

      '<section class="panel"><div class="panel-h"><h2>Data on file</h2><p>' + esc(App.outletName()) + ' only. MASTER items are shared by all outlets.</p></div><div class="tablewrap" id="of-table"></div></section>';

    $("#m-dept").value = UM.dept == null ? String(App.deptId || "") : UM.dept;
    $("#m-new-wrap").hidden = $("#m-dept").value !== "__new__";
    $("#m-newdept").value = UM.newName;
    $("#s-date").value = US.date;
    ["m", "s"].forEach(function (k) { paintDrop(k); paintMap(k); paintInfo(k); paintLog(k); });
    paintReplace();
    paintOnFile();
    if (OF.key !== String(App.outletId) || (!OF.loaded && !OF.loading)) loadOnFile();
  }
  function paintReplace() {
    var el = $("#s-replace"); if (!el) return;
    var row = App.deptId && OF.loaded ? OF.rows.find(function (r) { return String(r.id) === String(App.deptId); }) : null;
    el.innerHTML = row && row.sap > 0
      ? '<div class="note" style="margin-bottom:12px">' + icon("info") + "<span><b>" + fmt(row.sap) + "</b> MI24 rows are on file for " + esc(App.deptName()) + " (count date " + esc(row.date || "unknown") + "). Uploading replaces them.</span></div>" : "";
  }

  /* ---------- data on file ---------- */
  function loadOnFile() {
    var key = String(App.outletId), depts = App.depts.slice(), mine = ++token;
    OF.key = key; OF.loading = true; OF.error = null;
    paintOnFile();
    Promise.all(depts.map(function (d) {
      return Promise.all([
        sb.from("products").select("barcode", { count: "exact", head: true }).eq("department_id", d.id),
        Scoped.select("sap_uploads", "id", { count: "exact", head: true }).eq("department_id", d.id),
        Scoped.select("sap_uploads", "count_date").eq("department_id", d.id).limit(1),
        Scoped.select("gondola_sessions", "id", { count: "exact", head: true }).eq("department_id", d.id)
      ]).then(function (r) {
        var bad = r.find(function (x) { return x.error; });
        if (bad) throw bad.error;
        return { id: d.id, name: d.name, master: r[0].count || 0, sap: r[1].count || 0, date: r[2].data && r[2].data[0] ? r[2].data[0].count_date : "", sessions: r[3].count || 0 };
      });
    })).then(function (rows) {
      if (mine !== token || key !== String(App.outletId)) return;
      OF.rows = rows; OF.loaded = true; OF.loading = false;
      paintOnFile(); paintReplace();
    }).catch(function (e) {
      if (mine !== token) return;
      OF.loading = false; OF.error = (e && e.message) || String(e);
      paintOnFile();
    });
  }
  function paintOnFile() {
    var el = $("#of-table"); if (!el) return;
    if (OF.loading && !OF.loaded) { el.innerHTML = '<div class="empty">Loading…</div>'; return; }
    if (OF.error && !OF.loaded) { el.innerHTML = '<div class="empty">Could not load: ' + esc(OF.error) + ' <button type="button" class="btn sm" data-up="reload">Retry</button></div>'; return; }
    el.innerHTML = '<table class="dt"><thead><tr><th class="plain">Department</th><th class="plain num">MASTER items</th><th class="plain num">MI24 rows</th><th class="plain">MI24 count date</th><th class="plain num">Gondolas</th><th class="plain">Status</th></tr></thead><tbody>' +
      OF.rows.map(function (r) {
        var st = r.sap > 0 ? '<span class="pill ok"><i></i>MI24 loaded</span>' : (r.sessions > 0 ? '<span class="pill warn"><i></i>Scans but no MI24</span>' : '<span class="pill info"><i></i>Nothing loaded</span>');
        return '<tr class="' + (String(r.id) === String(App.deptId) ? "sel" : "") + '"><td>' + esc(r.name) + '</td><td class="num">' + fmt(r.master) + '</td><td class="num">' + fmt(r.sap) + "</td><td>" + esc(r.date || "—") + '</td><td class="num">' + fmt(r.sessions) + "</td><td>" + st + "</td></tr>";
      }).join("") + "</tbody></table>";
  }

  /* ---------- MASTER upload ---------- */
  function chain(S, work) { // runs work() with the scope locked; always unlocks
    S.busy = true; App.setBusy(true); paintBtn(S.kind);
    return Promise.resolve().then(work).then(function (v) { end(S); return v; }, function (e) { end(S); throw e; });
  }
  function end(S) { S.busy = false; App.setBusy(false); paintBtn(S.kind); }

  function goMaster() {
    var M = UM;
    if (M.busy || !M.parsed || !M.parsed.rows.length || M.parsed.blockers.length) return;
    var pick = M.dept == null ? String(App.deptId || "") : M.dept, rows = M.parsed.rows;
    if (!pick) { App.toast("Choose a department for this file.", "err"); return; }
    M.log = []; M.prog = [0, rows.length]; paintLog("m");
    chain(M, function () {
      var deptPromise;
      if (pick === "__new__") {
        var name = M.newName.trim().toUpperCase();
        if (!name) throw new Error("Enter the new department name.");
        var dup = App.depts.find(function (d) { return d.name.trim().toUpperCase() === name; });
        if (dup) { say(M, "Department " + dup.name + " already exists. Using it.", ""); deptPromise = Promise.resolve(dup.id); }
        else {
          // departments are shared reference data (no outlet), so this is the one place a non-scoped insert is right
          deptPromise = Promise.resolve(sb.from("departments").insert({ name: name }).select().single()).then(function (r) {
            if (r.error) throw r.error;
            say(M, "Created department " + name + ".", "ok");
            return App.refreshDepts().then(function () { return r.data.id; });
          });
        }
      } else deptPromise = Promise.resolve(pick);
      return deptPromise.then(function (deptId) {
        M.dept = String(deptId);
        var iso = new Date().toISOString();
        var payload = rows.map(function (r) { return Object.assign({}, r, { department_id: deptId, updated_at: iso }); });
        var chunks = chunk(payload, CHUNK), done = 0, failed = 0, i = 0;
        say(M, "Saving " + fmt(payload.length) + " products in " + chunks.length + " part(s)…", "");
        function next() {
          if (i >= chunks.length) return Promise.resolve();
          var c = chunks[i++];
          return Promise.resolve(sb.from("products").upsert(c, { onConflict: "barcode" })).then(function (r) {
            if (r.error) { failed += c.length; say(M, "Part " + i + " failed: " + r.error.message, "err"); } else done += c.length;
            M.prog = [done + failed, payload.length]; paintLog("m");
            return next();
          });
        }
        return next().then(function () {
          say(M, (failed ? "Finished with problems. " : "Done. ") + fmt(done) + " saved, " + fmt(failed) + " failed.", failed ? "err" : "ok");
          App.toast(failed ? "MASTER LIST updated with " + failed + " failed rows. See the log." : "MASTER LIST updated (" + fmt(done) + " products).", failed ? "err" : "ok");
          App.invalidateData("uploads");
          loadOnFile();
          syncDeptSelect();
          M.exist = { state: "idle", map: {}, sig: "" };
          ensureExisting();
        });
      });
    }).catch(function (e) { say(M, "Stopped: " + ((e && e.message) || e), "err"); App.handleError(e); });
  }

  /* ---------- MI24 upload ---------- */
  function goSap() {
    var S = US;
    if (S.busy || !S.parsed || !S.parsed.rows.length || S.parsed.blockers.length) return;
    var sc;
    try { sc = App.requireScope(true); } catch (e) { App.handleError(e); return; }
    if (!S.date) { App.toast("Enter the count date.", "err"); return; }
    var o = sc.outletId, d = sc.deptId, label = App.outletName() + " · " + App.deptName();
    var countDate = ddmmyyyy(S.date), rows = S.parsed.rows;
    function guard() { if (App.outletId !== o || String(App.deptId) !== String(d)) throw new Error("The outlet or department changed. Nothing more was written."); }
    S.log = []; S.prog = [0, rows.length]; paintLog("s");
    chain(S, function () {
      guard();
      say(S, "Removing the old MI24 data for " + label + "…", "");
      return Promise.resolve(Scoped.remove("sap_uploads", { department_id: d })).then(function (r) {
        if (r.error) throw r.error;
        var payload = rows.map(function (x) { return Object.assign({}, x, { department_id: d, count_date: countDate }); }); // outlet_id is stamped by Scoped.insert
        var chunks = chunk(payload, CHUNK), done = 0, failed = 0, i = 0;
        say(S, "Saving " + fmt(payload.length) + " rows in " + chunks.length + " part(s)…", "");
        function next() {
          if (i >= chunks.length) return Promise.resolve();
          guard();
          var c = chunks[i++];
          return Promise.resolve(Scoped.insert("sap_uploads", c)).then(function (r2) {
            if (r2.error) { failed += c.length; say(S, "Part " + i + " failed: " + r2.error.message, "err"); } else done += c.length;
            S.prog = [done + failed, payload.length]; paintLog("s");
            return next();
          });
        }
        return next().then(function () {
          return Promise.resolve(Scoped.select("sap_uploads", "id", { count: "exact", head: true }).eq("department_id", d)).then(function (v) {
            var onFile = v && !v.error ? v.count : null;
            if (failed) say(S, "Incomplete: " + fmt(done) + " of " + fmt(payload.length) + " rows saved for " + label + ". Upload the file again to replace the partial data.", "err");
            else say(S, "Done. " + fmt(done) + " rows saved for " + label + (onFile !== null ? " (" + fmt(onFile) + " on file)." : "."), "ok");
            App.toast(failed ? "MI24 upload incomplete. See the log." : "MI24 data replaced for " + App.deptName() + ".", failed ? "err" : "ok");
            App.invalidateData("uploads");
            loadOnFile();
          });
        });
      });
    }).catch(function (e) { say(S, "Stopped: " + ((e && e.message) || e), "err"); App.handleError(e); });
  }

  /* ---------- events ---------- */
  document.addEventListener("change", function (e) {
    var t = e.target;
    if (t.dataset && t.dataset.upFile) { if (t.files && t.files[0]) readFile(t.dataset.upFile, t.files[0]); t.value = ""; return; }
    if (t.dataset && t.dataset.upMap) {
      var S = t.dataset.upMap === "m" ? UM : US;
      S.sel[t.dataset.k] = t.value; S.how[t.dataset.k] = "manual";
      paintMap(t.dataset.upMap); paintInfo(t.dataset.upMap);
      if (t.dataset.upMap === "m") ensureExisting();
      return;
    }
    if (t.id === "m-dept") { UM.dept = t.value; $("#m-new-wrap").hidden = t.value !== "__new__"; paintInfo("m"); }
    else if (t.id === "s-date") { US.date = t.value; paintBtn("s"); }
  });
  document.addEventListener("input", function (e) {
    if (e.target.id === "m-newdept") { e.target.value = e.target.value.toUpperCase(); UM.newName = e.target.value; paintBtn("m"); }
  });
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-up]"); if (!t) return;
    if (t.dataset.up === "go-m") goMaster();
    else if (t.dataset.up === "go-s") goSap();
    else if (t.dataset.up === "reload") loadOnFile();
  });
  document.addEventListener("dragover", function (e) {
    if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") > -1) e.preventDefault();
  });
  document.addEventListener("drop", function (e) {
    if (!e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") < 0) return;
    e.preventDefault();
    var z = e.target.closest && e.target.closest(".drop");
    if (z && e.dataTransfer.files[0] && $("#" + z.dataset.kind + "-drop")) readFile(z.dataset.kind, e.dataTransfer.files[0]);
  });

  App.register("uploads", {
    render: render,
    reset: function () { token++; fresh(); },
    _test: { detect: detect, MASTER_FIELDS: MASTER_FIELDS, SAP_FIELDS: SAP_FIELDS }
  });
})();
