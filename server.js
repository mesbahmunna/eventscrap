import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();

import { runDailyScraper, loadExistingEvents } from './daily_scraper.js';
import { isSupabaseReady, fetchEventsFromSupabase, getKnownEvents } from './supabase.js';
import { loadTargets, addTarget, removeTarget } from './targets.js';

const app = express();
const PORT = process.env.PORT || 3000;
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '0 4 * * *';

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

let isScrapingRunning = false;
let lastScrapeResult = null;

async function triggerScrapeJob(source = 'manual', specificUrls = null) {
  if (isScrapingRunning) {
    return { status: 'already_running', message: 'A scrape task is currently in progress.' };
  }

  isScrapingRunning = true;
  console.log(`🚀 Starting scraper job (triggered by: ${source})...`);

  try {
    const result = await runDailyScraper(specificUrls);
    lastScrapeResult = {
      ...result,
      triggered_by: source,
      completed_at: new Date().toISOString()
    };
    return lastScrapeResult;
  } catch (err) {
    console.error('❌ Scraper error:', err.message);
    lastScrapeResult = {
      status: 'error',
      error: err.message,
      triggered_by: source,
      failed_at: new Date().toISOString()
    };
    return lastScrapeResult;
  } finally {
    isScrapingRunning = false;
  }
}

// Scheduled Cron Job
cron.schedule(CRON_SCHEDULE, () => {
  console.log(`⏰ [CRON] Triggering scheduled daily scrape (${new Date().toISOString()})...`);
  triggerScrapeJob('cron_schedule');
});

// --- API ENDPOINTS ---

/**
 * System Status API
 */
app.get('/api/status', async (req, res) => {
  const supaOnline = await isSupabaseReady();
  let totalEvents = 0;

  if (supaOnline) {
    const known = await getKnownEvents();
    totalEvents = known.knownIds.size;
  } else {
    const local = await loadExistingEvents();
    totalEvents = local.length;
  }

  const targets = await loadTargets();

  res.json({
    service: 'AllEvents Scraper Service (Railway + Supabase)',
    status: 'online',
    database: supaOnline ? 'Supabase PostgreSQL' : 'Local JSON Fallback',
    is_supabase_connected: supaOnline,
    is_scraping_now: isScrapingRunning,
    cron_schedule: CRON_SCHEDULE,
    total_events: totalEvents,
    targets_count: targets.length,
    last_scrape_run: lastScrapeResult
  });
});

/**
 * Manage Target URLs
 */
app.get('/api/targets', async (req, res) => {
  const targets = await loadTargets();
  res.json({ targets });
});

app.post('/api/targets', async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string' || !url.includes('allevents.in')) {
    return res.status(400).json({ error: 'Please enter a valid AllEvents.in URL' });
  }

  const updated = await addTarget(url);
  res.json({ success: true, targets: updated });
});

app.delete('/api/targets', async (req, res) => {
  const url = req.body?.url || req.query?.url;
  if (!url) {
    return res.status(400).json({ error: 'URL required' });
  }

  const updated = await removeTarget(url);
  res.json({ success: true, targets: updated });
});

/**
 * Get events with query filters
 */
app.get('/api/events', async (req, res) => {
  try {
    const supaOnline = await isSupabaseReady();
    const { search, city, tag, hasTicket, limit = 100, offset = 0 } = req.query;

    if (supaOnline) {
      const result = await fetchEventsFromSupabase({
        search,
        city,
        tag,
        hasTicket,
        limit: parseInt(limit, 10),
        offset: parseInt(offset, 10)
      });

      if (result) {
        return res.json({
          source: 'Supabase',
          total: result.total,
          count: result.events.length,
          offset: parseInt(offset, 10),
          events: result.events
        });
      }
    }

    // Fallback: Local JSON
    let events = await loadExistingEvents();

    if (search) {
      const q = search.toLowerCase();
      events = events.filter((e) =>
        e.name?.toLowerCase().includes(q) ||
        e.venue?.toLowerCase().includes(q) ||
        e.address?.toLowerCase().includes(q)
      );
    }

    if (city) {
      const c = city.toLowerCase();
      events = events.filter((e) => e.city?.toLowerCase().includes(c));
    }

    if (hasTicket === 'true') {
      events = events.filter((e) => Boolean(e.external_ticket_url));
    }

    const start = parseInt(offset, 10);
    const count = parseInt(limit, 10);
    const paginated = events.slice(start, start + count);

    res.json({
      source: 'Local JSON',
      total: events.length,
      count: paginated.length,
      offset: start,
      events: paginated
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Manual Trigger Endpoint
 */
app.all(['/api/scrape', '/api/scrape-now'], (req, res) => {
  if (isScrapingRunning) {
    return res.status(409).json({
      status: 'busy',
      message: 'Scraping is already running in background.'
    });
  }

  const specificUrl = req.body?.url || req.query?.url || null;
  triggerScrapeJob('api_request', specificUrl);

  res.json({
    status: 'started',
    message: specificUrl
      ? `Scraper started for ${specificUrl}`
      : 'Scraper started for all target URLs.'
  });
});

// Explicitly send index.html for root path
app.get('/', (req, res) => {
  res.sendFile(path.resolve('public/index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server listening on http://0.0.0.0:${PORT}`);
  console.log(`⏰ Cron schedule active: "${CRON_SCHEDULE}"`);
});
