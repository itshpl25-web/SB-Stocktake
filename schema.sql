-- ============================================================
-- StockTake App — Supabase / Postgres Schema (v1)
-- Run this in Supabase SQL Editor on your NEW, isolated project.
-- ============================================================


-- ────────────────────────────────────────────────────────────
-- DEPARTMENTS
-- Replaces: the implicit department list derived from MASTER LIST col G
-- ────────────────────────────────────────────────────────────
create table departments (
  id          bigint generated always as identity primary key,
  name        text not null unique,          -- e.g. "MILK POWDER", "TOBACCO"
  created_at  timestamptz not null default now()
);


-- ────────────────────────────────────────────────────────────
-- PRODUCTS
-- Replaces: MASTER LIST sheet
-- barcode is UNIQUE + indexed → lookupBarcode() becomes an
-- indexed query instead of a full-list scan or preload.
-- This is the fix for the 200k-row loading failures.
-- ────────────────────────────────────────────────────────────
create table products (
  id             bigint generated always as identity primary key,
  barcode        text not null unique,        -- EAN/UPC
  material       text not null,                -- SAP material code
  description    text not null,
  material_group text,
  uom            text not null,                -- Sales Unit
  numerator      numeric not null default 1,
  department_id  bigint not null references departments(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index idx_products_department on products(department_id);


-- ────────────────────────────────────────────────────────────
-- GONDOLA SESSIONS
-- Replaces: the bold "header row" of each gondola group
-- gondola_id is UNIQUE globally, matching how checkGondola()
-- currently searches across ALL department sheets for a match.
-- ────────────────────────────────────────────────────────────
create table gondola_sessions (
  id            bigint generated always as identity primary key,
  gondola_id    text not null unique,          -- e.g. "SM1"
  department_id bigint not null references departments(id),
  staff_name    text,
  status        text not null default 'in_progress'
                  check (status in ('in_progress','done')),
  started_at    timestamptz not null default now(),
  ended_at      timestamptz
);
create index idx_sessions_department on gondola_sessions(department_id);
create index idx_sessions_status on gondola_sessions(status);


-- ────────────────────────────────────────────────────────────
-- SCAN ITEMS
-- Replaces: the "child rows" under each gondola header
-- request_id is UNIQUE → this is what replaces the 6-hour
-- CacheService idempotency trick. A duplicate retry with the
-- same request_id simply fails the insert instead of creating
-- a duplicate row — no manual dedupe logic needed.
-- ────────────────────────────────────────────────────────────
create table scan_items (
  id          bigint generated always as identity primary key,
  session_id  bigint not null references gondola_sessions(id) on delete cascade,
  barcode     text not null,
  material    text not null,
  description text not null,
  uom         text not null,
  numerator   numeric not null default 1,
  qty         numeric not null check (qty >= 0),
  request_id  text not null unique,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index idx_scan_items_session on scan_items(session_id);
create index idx_scan_items_material on scan_items(material);


-- ────────────────────────────────────────────────────────────
-- SAP UPLOADS
-- Replaces: "UPLOAD - [DEPARTMENT]" sheets
-- Each new admin upload for a department REPLACES the old rows
-- (same "isFirst clears sheet" behavior you have today) —
-- handle that in the upload function, not here.
-- ────────────────────────────────────────────────────────────
create table sap_uploads (
  id                  bigint generated always as identity primary key,
  department_id       bigint not null references departments(id),
  phys_inventory_doc  text,
  item                text,
  material            text not null,
  description         text,
  batch               text,
  plant               text,
  storage_location    text,
  special_stock       text,
  count_date          text,
  book_quantity       numeric,
  base_uom            text,
  uploaded_at         timestamptz not null default now()
);
create index idx_sap_uploads_department on sap_uploads(department_id);
create index idx_sap_uploads_material on sap_uploads(material);


-- ════════════════════════════════════════════════════════════
-- LIVE RECONCILIATION VIEW
-- Replaces: reconcileDept() + updateDeptQtyCounted()
-- No stored numbers, no manual "run" step. Every time this is
-- queried, qty_counted is the CURRENT sum of scan_items for
-- that material/department — always accurate, ready to export.
-- ════════════════════════════════════════════════════════════
create view reconciliation as
select
  su.department_id,
  d.name as department,
  su.material,
  su.description,
  su.book_quantity,
  su.base_uom,
  coalesce(scanned.qty_counted, 0) as qty_counted,
  case when coalesce(scanned.qty_counted, 0) = 0 then 'X' else '' end as zero_count
from sap_uploads su
join departments d on d.id = su.department_id
left join (
  select gs.department_id, si.material, sum(si.qty) as qty_counted
  from scan_items si
  join gondola_sessions gs on gs.id = si.session_id
  group by gs.department_id, si.material
) scanned
  on scanned.department_id = su.department_id
  and scanned.material = su.material;


-- ────────────────────────────────────────────────────────────
-- SESSION SUMMARY VIEW
-- Powers the admin "Gondola Status Overview" — one row per
-- session with its live item count, no N+1 queries needed.
-- ────────────────────────────────────────────────────────────
create view session_summary as
select
  gs.id,
  gs.gondola_id,
  gs.department_id,
  d.name as department,
  gs.staff_name,
  gs.status,
  gs.started_at,
  gs.ended_at,
  count(si.id) as item_count
from gondola_sessions gs
join departments d on d.id = gs.department_id
left join scan_items si on si.session_id = gs.id
group by gs.id, gs.gondola_id, gs.department_id, d.name, gs.staff_name, gs.status, gs.started_at, gs.ended_at;


-- ────────────────────────────────────────────────────────────
-- SAP EXPORT VIEW
-- Replaces: manually downloading the UPLOAD sheet after reconcileDept().
-- Unlike the "reconciliation" view (which groups by material for a
-- summary), this preserves ONE ROW PER ORIGINAL SAP LINE — same
-- Phys.Doc/Batch/Plant granularity as the source file — with the
-- live counted quantity merged in, ready to write straight to .xlsx.
-- ────────────────────────────────────────────────────────────
create view sap_export as
select
  su.id,
  su.department_id,
  d.name as department,
  su.phys_inventory_doc,
  su.item,
  su.material,
  su.description,
  su.batch,
  su.plant,
  su.storage_location,
  su.special_stock,
  su.count_date,
  coalesce(scanned.qty_counted, 0) as qty_counted,
  su.base_uom,
  su.book_quantity,
  case when coalesce(scanned.qty_counted, 0) = 0 then 'X' else '' end as zero_count
from sap_uploads su
join departments d on d.id = su.department_id
left join (
  select gs.department_id, si.material, sum(si.qty) as qty_counted
  from scan_items si
  join gondola_sessions gs on gs.id = si.session_id
  group by gs.department_id, si.material
) scanned
  on scanned.department_id = su.department_id
  and scanned.material = su.material;
-- Replaces: the yellow-highlight "not in book list" flagging
-- in the old reconcileDept(). Anything scanned that has no
-- matching row in sap_uploads for that department shows up here.
-- ────────────────────────────────────────────────────────────
create view unmatched_scans as
select
  gs.department_id,
  d.name as department,
  si.material,
  si.description,
  sum(si.qty) as qty_counted
from scan_items si
join gondola_sessions gs on gs.id = si.session_id
join departments d on d.id = gs.department_id
left join sap_uploads su
  on su.department_id = gs.department_id
  and su.material = si.material
where su.id is null
group by gs.department_id, d.name, si.material, si.description;
