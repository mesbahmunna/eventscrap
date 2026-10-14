import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import dotenv from 'dotenv';
dotenv.config();

import { runDailyScraper, loadExistingEvents } from './daily_scraper.js';
import { isSupabaseReady, fetchEventsFromSupabase, getKnownEvents } from './supabase.js';

const app = express();
const PORT = process.env.PORT || 3000;
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '0 4 * * *';

app.use(cors());
app.use(express.json());

let isScrapingRunning = false;
let lastScrapeResult = null;

async function triggerScrapeJob(source = 'manual') {
  if (isScrapingRunning) {
    return { status: 'already_running', message: 'A scrape task is currently in progress.' };
  }

  isScrapingRunning = true;
  console.log(`🚀 Starting scraper job (triggered by: ${source})...`);

  try {
    const result = await runDailyScraper();
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
 * Healthcheck & Status
 */
app.get('/', async (req, res) => {
  const supaOnline = await isSupabaseReady();
  let totalEvents = 0;

  if (supaOnline) {
    const known = await getKnownEvents();
    totalEvents = known.knownIds.size;
  } else {
    const local = await loadExistingEvents();
    totalEvents = local.length;
  }

  res.json({
    service: 'AllEvents Scraper Service (Railway + Supabase)',
    status: 'online',
    database: supaOnline ? 'Supabase PostgreSQL (Connected)' : 'Local JSON Fallback',
    is_scraping_now: isScrapingRunning,
    cron_schedule: CRON_SCHEDULE,
    total_events: totalEvents,
    last_scrape_run: lastScrapeResult,
    endpoints: {
      all_events: '/api/events',
      filter_example: '/api/events?search=marathon&hasTicket=true',
      trigger_scrape: '/api/scrape-now'
    }
  });
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

  triggerScrapeJob('api_request');

  res.json({
    status: 'started',
    message: 'Scraper started in background. Check / to see live progress.'
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server listening on http://0.0.0.0:${PORT}`);
  console.log(`⏰ Cron schedule active: "${CRON_SCHEDULE}"`);
});
