// ═══════════════════════════════════════════════════════════
//  Crazy Time Live Scraper Server (v5)
//  KEY FIX: parses 'ico-crazytime-slot-X' class names correctly:
//    slot-1, slot-2, slot-5, slot-10 → number
//    slot-ct → Crazy Time
//    slot-cf → Coin Flip
//    slot-ch → Cash Hunt
//    slot-pa → Pachinko
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
    args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage","--disable-gpu","--no-first-run","--single-process"],
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
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
    await page.setViewport({ width: 1280, height: 900 });

    console.log(`🔍 Navigating to ${TARGET_URL}...`);
    await page.goto(TARGET_URL, { waitUntil: "networkidle2", timeout: 30000 });
    await new Promise(r => setTimeout(r, 5500));

    const data = await page.evaluate(() => {
      // PRIMARY DETECTION: parse the slot class name
      // Examples: "ico-crazytime-slot-1", "ico-crazytime-slot-ct", "ico-crazytime-slot-cf"
      function detectFromCell(cell) {
        if (!cell) return { result: null, raw: "" };

        // Look for any element with class containing "ico-crazytime-slot-X"
        const allEls = cell.querySelectorAll("*");
        let foundClass = "";
        for (const el of allEls) {
          if (el.className && typeof el.className === "string") {
            const m = el.className.match(/ico-crazytime-slot-([a-z0-9]+)/i);
            if (m) {
              foundClass = m[0];
              const code = m[1].toLowerCase();
              const result = mapSlotCode(code);
              if (result) {
                return { result, raw: foundClass };
              }
            }
          }
        }

        // Fallback: parse image src for "/slot-X.webp"
        const imgs = cell.querySelectorAll("img");
        for (const img of imgs) {
          const src = img.src || "";
          const m = src.match(/\/slot-([a-z0-9]+)\.(?:webp|png|svg|jpg)/i);
          if (m) {
            const result = mapSlotCode(m[1].toLowerCase());
            if (result) return { result, raw: src };
          }
        }

        // No match
        return { result: null, raw: cell.textContent.trim().slice(0, 50) };
      }

      function mapSlotCode(code) {
        const map = {
          "1": "1", "2": "2", "5": "5", "10": "10",
          "ct": "Crazy Time",
          "cf": "Coin Flip",
          "ch": "Cash Hunt",
          "pa": "Pachinko",
        };
        return map[code] || null;
      }

      // Find target table (it has 'Slot Result' header)
      const tables = document.querySelectorAll("table");
      let targetTable = null;
      for (const tbl of tables) {
        const headers = Array.from(tbl.querySelectorAll("th, thead td")).map(h => h.textContent.toLowerCase());
        if (headers.some(h => h.includes("slot result"))) {
          targetTable = tbl; break;
        }
      }
      if (!targetTable) return { items: [], debug: { error: "No matching table" }, samples: [] };

      // Find columns
      const headerCells = Array.from(targetTable.querySelectorAll("th, thead td"));
      let timeCol = -1, slotCol = -1;
      headerCells.forEach((h, i) => {
        const t = h.textContent.toLowerCase();
        if (t.includes("occurred") || (t.includes("time") && timeCol === -1)) timeCol = i;
        if (t.includes("slot result")) slotCol = i;
      });

      const rows = targetTable.querySelectorAll("tbody tr");
      const out = [];
      const samples = [];

      for (let i = 0; i < rows.length; i++) {
        const cells = rows[i].querySelectorAll("td");
        if (cells.length === 0) continue;

        const timeText = timeCol >= 0 && cells[timeCol] ? cells[timeCol].textContent.trim() : "";
        const slotCell = slotCol >= 0 ? cells[slotCol] : null;
        const det = detectFromCell(slotCell);

        if (i < 3 && slotCell) {
          samples.push({
            row: i,
            time: timeText,
            cellHTML: slotCell.outerHTML.slice(0, 250),
            detected: det.result,
            classFound: det.raw,
          });
        }

        if (det.result) out.push({ result: det.result, time: timeText });
        if (out.length >= 30) break;
      }

      return {
        items: out,
        debug: { tableCount: tables.length, rowCount: rows.length, timeCol, slotCol },
        samples,
      };
    });

    console.log(`✅ Scraped ${data.items.length} results`);
    if (data.items.length > 0) {
      const summary = data.items.map(r => r.result).join(", ");
      console.log(`   Results: ${summary}`);
    }
    if (data.samples && data.samples.length) {
      console.log(`   Samples:`, JSON.stringify(data.samples).slice(0, 600));
    }

    cache = {
      results: data.items,
      lastUpdate: new Date().toISOString(),
      error: data.items.length === 0 ? `No results extracted` : null,
      debug: data.debug,
      samples: data.samples,
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
  try { await scrapeResults(); } catch (e) { console.error("Auto-refresh:", e.message); }
  setTimeout(autoRefresh, 8000);
}

app.get("/", (req, res) => res.json({ status: "ok", target: TARGET_URL, version: "v5" }));
app.get("/api/results", (req, res) => res.json(cache));
app.get("/api/refresh", async (req, res) => res.json(await scrapeResults()));
app.get("/api/health", (req, res) => res.json({ status: "ok", uptime: process.uptime(), lastUpdate: cache.lastUpdate, resultsCount: cache.results.length }));

app.listen(PORT, () => {
  console.log(`🎰 Crazy Time scraper v5 running on port ${PORT}`);
  setTimeout(autoRefresh, 2000);
});

process.on("SIGTERM", async () => { if (browser) await browser.close(); process.exit(0); });
