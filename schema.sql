-- Run this SQL in your Supabase SQL Editor (https://supabase.com/dashboard/project/ofqkiuesmfrjuynsqbbd/sql)

CREATE TABLE IF NOT EXISTS public.events (
  event_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT UNIQUE NOT NULL,
  external_ticket_url TEXT,
  organizer_id TEXT,
  start_date TEXT,
  end_date TEXT,
  currency TEXT,
  event_status TEXT,
  city TEXT,
  region TEXT,
  country TEXT,
  venue TEXT,
  address TEXT,
  coordinates JSONB,
  categories JSONB,
  tags JSONB,
  ticket_offers JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Enable Row Level Security (RLS)
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;

-- Allow anonymous read access (so anyone/frontend can read events)
CREATE POLICY "Allow public read access"
  ON public.events
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- Allow service role full access (so the scraper can insert/update)
CREATE POLICY "Allow service role full access"
  ON public.events
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
