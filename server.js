// ═══════════════════════════════════════════════════════════
//  Crazy Time Live Scraper Server (v2)
//  Targets: https://trackcasinos.com/crazy-time/
//  Extracts the "Spin Result" column from the results table.
// ═══════════════════════════════════════════════════════════

const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer");

const app = express();
const PORT = process.env.PORT || 3000;
const TARGET_URL = "https://trackcasinos.com/crazy-time/";

app.use(cors());
app.use(express.json());

let cache = { results: [], lastUpdate: null, error: null, debug: null };
let browser = null;
let scrapingInProgress = false;

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

    // Wait for table to populate
    await new Promise(r => setTimeout(r, 5000));

    const data = await page.evaluate(() => {
      const out = [];

      // Helper: detect spin result from cell content
      function detectResult(cell) {
        if (!cell) return null;

        // Check img alt text first (icons often have alt="1", alt="Coin Flip" etc)
        const imgs = cell.querySelectorAll("img");
        for (const img of imgs) {
          const alt = (img.alt || "").trim();
          const src = (img.src || "").toLowerCase();
          if (alt) {
            const r = matchResult(alt);
            if (r) return r;
          }
          // Sometimes the result is in image filename (e.g. "coinflip.png")
          if (src) {
            if (src.includes("coinflip") || src.includes("coin-flip") || src.includes("coin_flip")) return "Coin Flip";
            if (src.includes("cashhunt") || src.includes("cash-hunt") || src.includes("cash_hunt")) return "Cash Hunt";
            if (src.includes("pachinko")) return "Pachinko";
            if (src.includes("crazytime") || src.includes("crazy-time") || src.includes("crazy_time")) return "Crazy Time";
          }
        }

        // Then check text content
        const text = (cell.textContent || "").trim();
        return matchResult(text);
      }

      function matchResult(text) {
        if (!text) return null;
        const lo = text.toLowerCase().trim();
        if (lo.includes("crazy") && lo.includes("time")) return "Crazy Time";
        if (lo.includes("coin") && lo.includes("flip")) return "Coin Flip";
        if (lo.includes("cash") && lo.includes("hunt")) return "Cash Hunt";
        if (lo.includes("pachinko")) return "Pachinko";
        // Numbers — match standalone "1", "2", "5", "10"
        const m = text.match(/^\s*(10|5|2|1)\s*$/);
        if (m) return m[1];
        // Or surrounded by basic punctuation
        const m2 = text.match(/\b(10|5|2|1)\b/);
        if (m2 && text.length < 8) return m2[1];
        return null;
      }

      // Find the results table
      const tables = document.querySelectorAll("table");
      let targetTable = null;

      for (const tbl of tables) {
        const headers = Array.from(tbl.querySelectorAll("th, thead td")).map(h => h.textContent.toLowerCase());
        if (headers.some(h => h.includes("spin result")) || headers.some(h => h.includes("occurred"))) {
          targetTable = tbl;
          break;
        }
      }

      if (!targetTable) {
        return { items: [], debug: { url: location.href, title: document.title, tableCount: tables.length, error: "No matching table found" } };
      }

      // Find column indices
      const headerCells = Array.from(targetTable.querySelectorAll("th, thead td"));
      let timeCol = -1, spinCol = -1;
      headerCells.forEach((h, i) => {
        const txt = h.textContent.toLowerCase();
        if (txt.includes("occurred") || txt.includes("time")) timeCol = i;
        if (txt.includes("spin result")) spinCol = i;
      });

      // Fallback if "Spin Result" not found, use Slot Result
      if (spinCol === -1) {
        headerCells.forEach((h, i) => {
          if (h.textContent.toLowerCase().includes("slot result")) spinCol = i;
        });
      }

      // Iterate rows
      const rows = targetTable.querySelectorAll("tbody tr");
      for (const row of rows) {
        const cells = row.querySelectorAll("td");
        if (cells.length === 0) continue;

        const timeText = timeCol >= 0 && cells[timeCol] ? cells[timeCol].textContent.trim() : "";
        const spinCell = spinCol >= 0 ? cells[spinCol] : null;
        const result = spinCell ? detectResult(spinCell) : null;

        if (result) {
          out.push({ result, time: timeText });
        }
        if (out.length >= 30) break;
      }

      return {
        items: out,
        debug: {
          url: location.href,
          title: document.title,
          tableCount: tables.length,
          rowCount: rows.length,
          timeCol, spinCol,
          headers: headerCells.map(h => h.textContent.trim()),
        },
      };
    });

    console.log(`✅ Scraped ${data.items.length} results`);
    console.log(`   Debug:`, JSON.stringify(data.debug));

    cache = {
      results: data.items,
      lastUpdate: new Date().toISOString(),
      error: data.items.length === 0 ? `No results extracted. Debug: ${JSON.stringify(data.debug)}` : null,
      debug: data.debug,
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

async function autoRefresh() {
  try { await scrapeResults(); }
  catch (e) { console.error("Auto-refresh error:", e.message); }
  setTimeout(autoRefresh, 8000);
}

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "Crazy Time Live Scraper v2",
    target: TARGET_URL,
    endpoints: { "/api/results": "...", "/api/refresh": "...", "/api/health": "..." },
  });
});

app.get("/api/results", (req, res) => res.json(cache));
app.get("/api/refresh", async (req, res) => res.json(await scrapeResults()));
app.get("/api/health", (req, res) => res.json({
  status: "ok", uptime: process.uptime(), lastUpdate: cache.lastUpdate, resultsCount: cache.results.length,
}));

app.listen(PORT, () => {
  console.log(`🎰 Crazy Time scraper running on port ${PORT}`);
  console.log(`📡 Targeting: ${TARGET_URL}`);
  setTimeout(autoRefresh, 2000);
});

process.on("SIGTERM", async () => {
  if (browser) await browser.close();
  process.exit(0);
});
