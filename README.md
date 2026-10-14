# AllEvents Scraper Service (Railway + Supabase Edition)

An automated daily event scraper for [AllEvents.in](https://allevents.in) deployed on **Railway** with persistent cloud storage in **Supabase (PostgreSQL)**.

## ✨ Features
- **Incremental Daily Scraping:** Scrapes new events and skips existing events automatically.
- **Supabase Cloud Database:** Automatically upserts events and tickets into PostgreSQL.
- **External Ticket URLs:** Extracts direct booking links (District, BookMyShow, Paytm Insider, etc.).
- **Cloudflare Stealth:** Built with `playwright-extra` and `puppeteer-extra-plugin-stealth` with persistent session profiles.
- **Automated Daily Cron:** Runs automatically via `node-cron` every morning (configurable).
- **Public REST API:** Exposes endpoints to search, filter, and fetch events as JSON.

---

## 🛠️ Step 1: Create Table in Supabase (1 Minute)

1. Open your [Supabase SQL Editor](https://supabase.com/dashboard/project/ofqkiuesmfrjuynsqbbd/sql).
2. Paste the contents of [`schema.sql`](./schema.sql) and click **Run**.
3. Your `events` table with RLS policies is created!

---

## 🚀 Step 2: Deploy to Railway

1. Push this project to your GitHub:
   ```bash
   git add .
   git commit -m "Deploy AllEvents scraper with Supabase"
   git push origin main
   ```
2. Go to [railway.com](https://railway.com) and click **"New Project"** -> **"Deploy from GitHub repo"**.
3. In Railway **Variables** tab, add your environment variables:
   * `SUPABASE_URL` = `https://ofqkiuesmfrjuynsqbbd.supabase.co`
   * `SUPABASE_SERVICE_ROLE_KEY` = `<your-service-role-key>`
   * `CRON_SCHEDULE` = `0 4 * * *`
   * `SCRAPE_URL` = `https://allevents.in/new-delhi/all`
4. In Railway **Volumes** tab, add a volume with mount path `/app/data`.

---

## 📡 API Endpoints

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/` | `GET` | Health status, database status, last scrape result |
| `/api/events` | `GET` | Fetch all events from Supabase |
| `/api/events?hasTicket=true` | `GET` | Filter events with external booking tickets |
| `/api/events?search=marathon` | `GET` | Full-text search events |
| `/api/scrape-now` | `GET/POST` | Manually trigger a scrape run |
