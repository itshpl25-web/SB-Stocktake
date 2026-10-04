# Changelog

All notable changes to the StockTake Admin. Newest first.

## 2.1.0 - 2026-10-04

Brings back features of the previous admin page that the 2.0.0 rebuild left out. The previous page is the "legacy" `admin.html`.

### Restored

- **Gondola Trace in Reconciliation:** a summary per material of which gondolas it was scanned in, and a Trace button that lists every scan with gondola, barcode, quantity and time (uses the existing `department_scan_trace` function, always for the selected outlet).
- **Barcode column** in Reconciliation (all barcodes actually scanned, or the numerator-1 barcode when nothing was scanned).
- **Delete a single gondola** from the Sessions detail panel. Frees a gondola ID that was started under the wrong department.
- **Reconciliation Excel export** with the 16 working-paper columns, including Var Qty, Barcode and Gondola Trace.
- **SAP columns** (document, item, batch, plant, storage location, special stock, count date) in Reconciliation, behind a toggle.
- **Warning when all book quantities are empty or 0** (pre-posting MI24).
- **MASTER LIST last updated** date, per department, in Uploads.
- **Departments still holding data** list on the Clear page, for the selected outlet.

### Changed

- Reconciliation search also matches barcode and gondola ID.
- Reconciliation now reads the `sap_export` view, so the on-screen lines and the Export file come from the same source.

## 2.0.0 - 2026-10-03

A full rebuild of the admin page. The single-file `admin.html` is replaced by a small set of files (see the README file map). The PIN gate, the 4-character Clear confirm code and the `printed_at` print stamp behave as before.

### Added

- **Dashboard** as the home page: outlet-wide tiles, a "needs attention" list, progress per department.
- **Shared stocktake checklist** per outlet and department, six steps. Three are checked automatically from live data, three need a manual check and are saved in the new `checklist_progress` table so every supervisor sees the same state. Ticks that contradict the data are allowed but flagged. Clear resets the checklist.
- **Sidebar and a sticky top bar**: outlet and department are chosen once and apply to every page. The last outlet used is remembered on the browser.
- **Search, filters and sortable columns** on Sessions and Reconciliation.
- **Auto-refresh every 30 seconds** on Dashboard, Sessions and Reconciliation, with Pause and an "updated Ns ago" indicator.
- **Detail panel** in Sessions to correct or delete scanned items.
- **Print button on every gondola row**, with a preview. A4 Zone Count Report with the Verified by box on the last page only, page numbers that include the gondola ID (`SM1 · Page 1 of 2`) and no repeated table header.
- **Column-mapping panel and sample rows** before any upload is saved, with blockers and warnings.
- **Export re-check**: Download re-reads the latest data line by line and makes no file if any count changed.
- **Clear safety report**: counts other outlets and departments before and after and reports whether they stayed unchanged.
- Toast notifications for results and errors.
- `noindex` tag so search engines skip the admin page.
- Fallback message when a section file fails to load.

### Changed

- **Uploads find columns by header name** instead of fixed positions. MASTER LIST never guesses by position. MI24 can still fall back to the old layout, with a warning.
- **MASTER LIST UOM** is read from the `Sales unit` column. Base Unit of Measure (always `EA`) is not used for UOM.
- Repeated identical MASTER LIST barcodes (the same item listed for two plants) are saved once with an information note. Only conflicting copies raise a warning. Rows with no barcode are skipped with a notice.
- A UOM column that is mostly numbers is blocked, which prevents mapping Cost as the unit.
- MI24 replace removes the old rows for the selected outlet and department only, then saves the new rows in parts of 500.
- Clear confirmation is typed on the page instead of a browser pop-up. The code itself is unchanged (4 characters, no `0`, `O`, `1`, `I`) and now works once.
- Counted quantities are shown in base units (`qty × numerator`) everywhere.
- Large lists are fetched page by page, so the 1,000-row limit of Supabase can no longer cut a list short.
- Code split into `admin.html`, `admin.css` and one script per area.

### Safety

- Every read and write goes through one outlet-scoped helper. Updates and deletes without an extra filter are refused, and rows tagged for another outlet are refused.
- Scanned items are only touched after the gondola is proven to belong to the selected outlet.
- Outlet and department pickers are locked while a save is running, and leaving the page mid-save asks for confirmation.
- After a data-changing action, other pages drop what they had loaded so they never show stale numbers.

### Database

- New table `checklist_progress` (see the README for the SQL).

### Unchanged

- Admin PIN gate (checked in the browser, asked on every load).
- Staff scanner `index.html`.
- `printed_at` stamping when a gondola report is printed.
- Existing tables and views.
