-- WARNING: This schema is for context only and is not meant to be run.
-- Table order and constraints may not be valid for execution.

CREATE TABLE public.departments (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  name text NOT NULL UNIQUE,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT departments_pkey PRIMARY KEY (id)
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
  CONSTRAINT gondola_sessions_outlet_id_fkey FOREIGN KEY (outlet_id) REFERENCES public.outlets(id)
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
  CONSTRAINT scan_items_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.gondola_sessions(id)
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
CREATE TABLE public.outlets (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  name text NOT NULL UNIQUE,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT outlets_pkey PRIMARY KEY (id)
);
