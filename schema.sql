-- StockTake — Complete Schema Documentation
-- Reconstructed from live Supabase project (itshpl25-gang / Stocktake-App) on 2026-08-29.
-- This supersedes the earlier tables-only schema.sql, which did not capture
-- constraints, indexes, views, or the department_scan_trace function.

-- ═══════════════════════════════════════════════════
-- TABLES
-- ═══════════════════════════════════════════════════

CREATE TABLE public.departments (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  name text NOT NULL UNIQUE,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT departments_pkey PRIMARY KEY (id)
);

CREATE TABLE public.outlets (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  name text NOT NULL UNIQUE,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT outlets_pkey PRIMARY KEY (id)
);

CREATE TABLE public.products (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  barcode text NOT NULL UNIQUE,
  material text NOT NULL,
  description text NOT NULL,
  material_group text,
  uom text NOT NULL,
  numerator numeric NOT NULL DEFAULT 1,
  department_id bigint NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT products_pkey PRIMARY KEY (id),
  CONSTRAINT products_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.departments(id)
);

CREATE TABLE public.gondola_sessions (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  gondola_id text NOT NULL,
  department_id bigint NOT NULL,
  staff_name text,
  status text NOT NULL DEFAULT 'in_progress'::text CHECK (status = ANY (ARRAY['in_progress'::text, 'done'::text])),
  started_at timestamp with time zone NOT NULL DEFAULT now(),
  ended_at timestamp with time zone,
  outlet_id bigint NOT NULL,
  printed_at timestamp with time zone,
  CONSTRAINT gondola_sessions_pkey PRIMARY KEY (id),
  CONSTRAINT gondola_sessions_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.departments(id),
  CONSTRAINT gondola_sessions_outlet_id_fkey FOREIGN KEY (outlet_id) REFERENCES public.outlets(id),
  -- Enforces one gondola_id per outlet at a time. index.html relies on this: creating a session
  -- for a gondola_id already in use at that outlet raises a 23505 conflict, which checkAndStart()
  -- specifically catches ("Someone just started this gondola at this outlet").
  CONSTRAINT gondola_sessions_outlet_gondola_key UNIQUE (gondola_id, outlet_id)
);

CREATE TABLE public.scan_items (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  session_id bigint NOT NULL,
  barcode text NOT NULL,
  material text NOT NULL,
  description text NOT NULL,
  uom text NOT NULL,
  numerator numeric NOT NULL DEFAULT 1,
  qty numeric NOT NULL CHECK (qty >= 0::numeric),
  request_id text NOT NULL UNIQUE,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT scan_items_pkey PRIMARY KEY (id),
  -- ON DELETE CASCADE confirmed live (confdeltype = 'c'). This is what makes admin.html's
  -- "Clear Department Data" and index.html's "Cancel Count" work — both delete a
  -- gondola_sessions row directly and rely on its scan_items being removed automatically.
  CONSTRAINT scan_items_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.gondola_sessions(id) ON DELETE CASCADE
);

CREATE TABLE public.sap_uploads (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  department_id bigint NOT NULL,
  phys_inventory_doc text,
  item text,
  material text NOT NULL,
  description text,
  batch text,
  plant text,
  storage_location text,
  special_stock text,
  count_date text,
  book_quantity numeric,
  base_uom text,
  uploaded_at timestamp with time zone NOT NULL DEFAULT now(),
  outlet_id bigint NOT NULL,
  CONSTRAINT sap_uploads_pkey PRIMARY KEY (id),
  CONSTRAINT sap_uploads_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.departments(id),
  CONSTRAINT sap_uploads_outlet_id_fkey FOREIGN KEY (outlet_id) REFERENCES public.outlets(id)
);

-- ═══════════════════════════════════════════════════
-- INDEXES (beyond those auto-created by PRIMARY KEY / UNIQUE constraints above)
-- Confirmed live via pg_indexes on 2026-08-29, after removing exact duplicates.
-- ═══════════════════════════════════════════════════

CREATE INDEX idx_sessions_department ON public.gondola_sessions (department_id);
CREATE INDEX idx_gondola_sessions_outlet_id ON public.gondola_sessions (outlet_id);
CREATE INDEX idx_sessions_status ON public.gondola_sessions (status);

CREATE INDEX idx_products_department ON public.products (department_id);

CREATE INDEX idx_sap_uploads_department ON public.sap_uploads (department_id);
CREATE INDEX idx_sap_uploads_outlet_id ON public.sap_uploads (outlet_id);
CREATE INDEX idx_sap_uploads_material ON public.sap_uploads (material);

CREATE INDEX idx_scan_items_session ON public.scan_items (session_id);
CREATE INDEX idx_scan_items_material ON public.scan_items (material);

-- ═══════════════════════════════════════════════════
-- VIEWS
-- Definitions pulled live via pg_get_viewdef() on 2026-08-29.
-- ═══════════════════════════════════════════════════

-- reconciliation: one row per (department, outlet, material) from the SAP book list,
-- with qty_counted summed from scan_items. A material scanned but never present in
-- sap_uploads will NOT appear here — that gap is covered by unmatched_scans below.
CREATE VIEW public.reconciliation AS
SELECT su.department_id,
    d.name AS department,
    su.outlet_id,
    o.name AS outlet,
    su.material,
    su.description,
    su.book_quantity,
    su.base_uom,
    COALESCE(scanned.qty_counted, 0::numeric) AS qty_counted,
    CASE
        WHEN COALESCE(scanned.qty_counted, 0::numeric) = 0::numeric THEN 'X'::text
        ELSE ''::text
    END AS zero_count
FROM sap_uploads su
JOIN departments d ON d.id = su.department_id
JOIN outlets o ON o.id = su.outlet_id
LEFT JOIN (
    SELECT gs.department_id,
        gs.outlet_id,
        si.material,
        sum(si.qty) AS qty_counted
    FROM scan_items si
    JOIN gondola_sessions gs ON gs.id = si.session_id
    GROUP BY gs.department_id, gs.outlet_id, si.material
) scanned ON scanned.department_id = su.department_id
  AND scanned.outlet_id = su.outlet_id
  AND scanned.material = su.material;

-- sap_export: same shape as reconciliation, plus the full SAP upload columns needed
-- to re-export a .xlsx for SAP GUI upload (admin.html's Export tab).
CREATE VIEW public.sap_export AS
SELECT su.id,
    su.department_id,
    d.name AS department,
    su.outlet_id,
    o.name AS outlet,
    su.phys_inventory_doc,
    su.item,
    su.material,
    su.description,
    su.batch,
    su.plant,
    su.storage_location,
    su.special_stock,
    su.count_date,
    COALESCE(scanned.qty_counted, 0::numeric) AS qty_counted,
    su.base_uom,
    su.book_quantity,
    CASE
        WHEN COALESCE(scanned.qty_counted, 0::numeric) = 0::numeric THEN 'X'::text
        ELSE ''::text
    END AS zero_count
FROM sap_uploads su
JOIN departments d ON d.id = su.department_id
JOIN outlets o ON o.id = su.outlet_id
LEFT JOIN (
    SELECT gs.department_id,
        gs.outlet_id,
        si.material,
        sum(si.qty) AS qty_counted
    FROM scan_items si
    JOIN gondola_sessions gs ON gs.id = si.session_id
    GROUP BY gs.department_id, gs.outlet_id, si.material
) scanned ON scanned.department_id = su.department_id
  AND scanned.outlet_id = su.outlet_id
  AND scanned.material = su.material;

-- session_summary: one row per gondola session with a live item count.
-- Powers admin.html's Status Overview table and Session dropdown.
CREATE VIEW public.session_summary AS
SELECT gs.id,
    gs.gondola_id,
    gs.department_id,
    d.name AS department,
    gs.outlet_id,
    o.name AS outlet,
    gs.staff_name,
    gs.status,
    gs.started_at,
    gs.ended_at,
    gs.printed_at,
    count(si.id) AS item_count
FROM gondola_sessions gs
JOIN departments d ON d.id = gs.department_id
JOIN outlets o ON o.id = gs.outlet_id
LEFT JOIN scan_items si ON si.session_id = gs.id
GROUP BY gs.id, gs.gondola_id, gs.department_id, d.name, gs.outlet_id, o.name, gs.staff_name, gs.status, gs.started_at, gs.ended_at, gs.printed_at;

-- unmatched_scans: materials that were scanned but never appeared in the SAP upload
-- for that department + outlet. reconciliation starts FROM sap_uploads, so these
-- items would otherwise be invisible there rather than showing as zero.
CREATE VIEW public.unmatched_scans AS
SELECT gs.department_id,
    d.name AS department,
    gs.outlet_id,
    o.name AS outlet,
    si.material,
    si.description,
    sum(si.qty) AS qty_counted
FROM scan_items si
JOIN gondola_sessions gs ON gs.id = si.session_id
JOIN departments d ON d.id = gs.department_id
JOIN outlets o ON o.id = gs.outlet_id
LEFT JOIN sap_uploads su ON su.department_id = gs.department_id
  AND su.outlet_id = gs.outlet_id
  AND su.material = si.material
WHERE su.id IS NULL
GROUP BY gs.department_id, d.name, gs.outlet_id, o.name, si.material, si.description;

-- ═══════════════════════════════════════════════════
-- FUNCTIONS
-- ═══════════════════════════════════════════════════

-- department_scan_trace: every individual scan_items row (gondola, qty, timestamp) for
-- a department + outlet, unsummed. admin.html fetches this once per Load Report and
-- groups it client-side into both the inline "Gondola Trace" summary column and the
-- 🔍 detail modal — one batched call instead of a query per material row.
CREATE OR REPLACE FUNCTION department_scan_trace(p_department_id bigint, p_outlet_id bigint)
RETURNS TABLE (
  material text,
  gondola_id text,
  qty numeric,
  scanned_at timestamptz
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    si.material,
    gs.gondola_id,
    si.qty,
    si.created_at AS scanned_at
  FROM scan_items si
  JOIN gondola_sessions gs ON gs.id = si.session_id
  WHERE gs.department_id = p_department_id
    AND gs.outlet_id = p_outlet_id
  ORDER BY si.material, si.created_at;
$$;
