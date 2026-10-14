import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

export const supabase = (SUPABASE_URL && SUPABASE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

/**
 * Checks if Supabase connection and table are ready
 */
export async function isSupabaseReady() {
  if (!supabase) return false;
  try {
    const { error } = await supabase.from('events').select('event_id').limit(1);
    return !error;
  } catch (e) {
    return false;
  }
}

/**
 * Gets set of all known event IDs and URLs for ultra-fast skip checking
 */
export async function getKnownEvents() {
  const knownIds = new Set();
  const knownUrls = new Set();

  if (!supabase) return { knownIds, knownUrls };

  try {
    const { data, error } = await supabase
      .from('events')
      .select('event_id, url');

    if (!error && Array.isArray(data)) {
      for (const row of data) {
        if (row.event_id) knownIds.add(row.event_id);
        if (row.url) knownUrls.add(row.url);
      }
    }
  } catch (err) {
    console.warn('⚠️ Could not fetch existing events from Supabase:', err.message);
  }

  return { knownIds, knownUrls };
}

/**
 * Inserts or updates an event in Supabase
 */
export async function upsertEvent(event) {
  if (!supabase) return false;

  const record = {
    event_id: event.event_id || (event.url.match(/\/(\d{10,20})$/)?.[1] || null),
    name: event.name,
    url: event.url,
    external_ticket_url: event.external_ticket_url || null,
    organizer_id: event.organizer_id || null,
    start_date: event.startDate || null,
    end_date: event.endDate || null,
    currency: event.currency || null,
    event_status: event.event_status || null,
    city: event.city || null,
    region: event.region || null,
    country: event.country || null,
    venue: event.venue || null,
    address: event.address || null,
    coordinates: event.coordinates || null,
    categories: event.categories || [],
    tags: event.tags || [],
    ticket_offers: event.ticket_offers || []
  };

  if (!record.event_id) {
    console.warn(`⚠️ Skipped Supabase insert: Missing event_id for "${record.name}"`);
    return false;
  }

  const { error } = await supabase
    .from('events')
    .upsert(record, { onConflict: 'event_id' });

  if (error) {
    console.error(`❌ Supabase error inserting ${record.name}:`, error.message);
    return false;
  }

  return true;
}

/**
 * Reads events from Supabase with filters and pagination
 */
export async function fetchEventsFromSupabase({ search, city, tag, hasTicket, limit = 100, offset = 0 } = {}) {
  if (!supabase) return null;

  let query = supabase.from('events').select('*', { count: 'exact' });

  if (search) {
    query = query.ilike('name', `%${search}%`);
  }
  if (city) {
    query = query.ilike('city', `%${city}%`);
  }
  if (hasTicket === 'true') {
    query = query.not('external_ticket_url', 'is', null);
  }

  query = query.order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  const { data, count, error } = await query;
  if (error) {
    console.error('Supabase fetch error:', error.message);
    return null;
  }

  return { events: data || [], total: count || 0 };
}
