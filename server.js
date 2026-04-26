// ═══════════════════════════════════════════════════════════
//  Crazy Time Live Scraper Server
//  Scrapes trackcasinos.com using headless Chrome (Puppeteer)
//  and exposes a clean JSON API for the frontend dashboard.
// ═══════════════════════════════════════════════════════════

const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer");

const app = express();
const PORT = process.env.PORT || 3000;
const TARGET_URL = "https://trackcasinos.com/casino/live-crazy-time";

app.use(cors());
app.use(express.json());

// ── Cache ──────────────────────────────────────────────────
let cache = { results: [], lastUpdate: null, error: null };
let browser = null;
let scrapingInProgress = false;

// ── Puppeteer setup ────────────────────────────────────────
async function getBrowser() {
  if (browser && browser.connected) return browser;
  console.log("🚀 Launching headless Chrome...");
  browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--single-process",
    ],
  });
  return browser;
}

// ── Scraping logic ─────────────────────────────────────────
async function scrapeResults() {
  if (scrapingInProgress) return cache;
  scrapingInProgress = true;
  let page = null;

  try {
    const br = await getBrowser();
    page = await br.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );
    await page.setViewport({ width: 1280, height: 900 });

    console.log(`🔍 Navigating to ${TARGET_URL}...`);
    await page.goto(TARGET_URL, { waitUntil: "networkidle2", timeout: 30000 });

    // Wait for the results table/list to load
    await new Promise(r => setTimeout(r, 4000));

    // Extract results - tries multiple selectors
    const results = await page.evaluate(() => {
      const out = [];

      // Strategy 1: Look for table rows
      const rows = document.querySelectorAll(
        "table tr, .history-table tr, [class*='history'] [class*='row'], [class*='spin'], [class*='result-item']"
      );

      const SEGMENTS = {
        "1": "1", "2": "2", "5": "5", "10": "10",
        "coin flip": "Coin Flip", "coinflip": "Coin Flip",
        "cash hunt": "Cash Hunt", "cashhunt": "Cash Hunt",
        "pachinko": "Pachinko",
        "crazy time": "Crazy Time", "crazytime": "Crazy Time",
      };

      function findResult(text) {
        const lo = text.toLowerCase().trim();
        for (const [key, val] of Object.entries(SEGMENTS)) {
          if (lo.includes(key)) return val;
        }
        // Standalone numbers
        const m = text.match(/\b(10|5|2|1)\b/);
        if (m) return m[1];
        return null;
      }

      for (const row of rows) {
        const text = row.textContent || "";
        if (text.length > 200) continue; // skip giant containers
        const result = findResult(text);
        if (result) {
          const timeMatch = text.match(/\d{1,2}:\d{2}(:\d{2})?/);
          out.push({
            result,
            time: timeMatch ? timeMatch[0] : "",
            raw: text.trim().slice(0, 80),
          });
        }
        if (out.length >= 30) break;
      }

      // Strategy 2: Look for divs with data attributes
      if (out.length === 0) {
        const dataEls = document.querySelectorAll(
          "[data-result], [data-outcome], [data-spin], [data-segment]"
        );
        for (const el of dataEls) {
          const raw = el.dataset.result || el.dataset.outcome || el.dataset.spin || el.dataset.segment || "";
          const result = findResult(raw);
          if (result) out.push({ result, time: "", raw });
          if (out.length >= 30) break;
        }
      }

      // Strategy 3: Look for image alt text in result icons
      if (out.length === 0) {
        const imgs = document.querySelectorAll("img[alt]");
        for (const img of imgs) {
          const result = findResult(img.alt);
          if (result) out.push({ result, time: "", raw: img.alt });
          if (out.length >= 30) break;
        }
      }

      return {
        items: out,
        debug: {
          url: window.location.href,
          title: document.title,
          rowCount: rows.length,
          bodyLength: document.body.innerHTML.length,
        },
      };
    });

    console.log(`✅ Scraped ${results.items.length} results`);
    console.log(`   Debug: ${JSON.stringify(results.debug)}`);

    cache = {
      results: results.items,
      lastUpdate: new Date().toISOString(),
      error: null,
      debug: results.debug,
    };
  } catch (err) {
    console.error("❌ Scrape failed:", err.message);
    cache.error = err.message;
    cache.lastUpdate = new Date().toISOString();
  } finally {
    if (page) await page.close().catch(() => {});
    scrapingInProgress = false;
  }

  return cache;
}

// ── Auto-refresh every 8 seconds ───────────────────────────
async function autoRefresh() {
  try {
    await scrapeResults();
  } catch (e) {
    console.error("Auto-refresh error:", e.message);
  }
  setTimeout(autoRefresh, 8000);
}

// ── API ENDPOINTS ──────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "Crazy Time Live Scraper",
    endpoints: {
      "/api/results": "Get cached latest spins",
      "/api/refresh": "Force a fresh scrape",
      "/api/health": "Health check",
    },
  });
});

app.get("/api/results", (req, res) => {
  res.json(cache);
});

app.get("/api/refresh", async (req, res) => {
  const data = await scrapeResults();
  res.json(data);
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    lastUpdate: cache.lastUpdate,
    resultsCount: cache.results.length,
  });
});

// ── Start ──────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🎰 Crazy Time scraper running on port ${PORT}`);
  console.log(`📡 Targeting: ${TARGET_URL}`);
  // Start auto-refresh after initial delay
  setTimeout(autoRefresh, 2000);
});

// ── Graceful shutdown ──────────────────────────────────────
process.on("SIGTERM", async () => {
  console.log("Shutting down...");
  if (browser) await browser.close();
  process.exit(0);
});
