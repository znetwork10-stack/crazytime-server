// ═══════════════════════════════════════════════════════════
//  Crazy Time Live Scraper Server (v3)
//  Targets: https://trackcasinos.com/crazy-time/
//  Aggressive image-based detection for table cell results.
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
    await new Promise(r => setTimeout(r, 5000));

    const data = await page.evaluate(() => {
      // Aggressive result detection from anything inside a cell
      function detectFromCell(cell) {
        if (!cell) return { result: null, raw: "" };

        // Collect ALL hints from the cell
        const hints = [];
        const text = (cell.textContent || "").trim();
        if (text) hints.push(text);

        const imgs = cell.querySelectorAll("img");
        for (const img of imgs) {
          if (img.alt) hints.push(img.alt);
          if (img.title) hints.push(img.title);
          if (img.src) hints.push(img.src);
        }

        // Also check background-image of any child
        const allChildren = cell.querySelectorAll("*");
        for (const c of allChildren) {
          const bg = window.getComputedStyle(c).backgroundImage;
          if (bg && bg !== "none") hints.push(bg);
          if (c.dataset) {
            for (const k of Object.keys(c.dataset)) hints.push(c.dataset[k]);
          }
          if (c.className && typeof c.className === "string") hints.push(c.className);
        }

        const combined = hints.join(" | ").toLowerCase();
        const result = matchResult(combined, text);
        return { result, raw: hints.slice(0,3).join(" | ").slice(0,150) };
      }

      function matchResult(combined, originalText) {
        if (!combined) return null;

        // Bonus games (check first - longer names)
        if (combined.includes("crazy") && combined.includes("time")) return "Crazy Time";
        if (combined.includes("crazytime") || combined.includes("crazy_time") || combined.includes("crazy-time")) return "Crazy Time";
        if (combined.includes("coin") && combined.includes("flip")) return "Coin Flip";
        if (combined.includes("coinflip") || combined.includes("coin_flip") || combined.includes("coin-flip")) return "Coin Flip";
        if (combined.includes("cash") && combined.includes("hunt")) return "Cash Hunt";
        if (combined.includes("cashhunt") || combined.includes("cash_hunt") || combined.includes("cash-hunt")) return "Cash Hunt";
        if (combined.includes("pachinko")) return "Pachinko";

        // Numbers - prefer the original cell text
        if (originalText) {
          const t = originalText.trim();
          if (/^\s*10\s*$/.test(t)) return "10";
          if (/^\s*5\s*$/.test(t)) return "5";
          if (/^\s*2\s*$/.test(t)) return "2";
          if (/^\s*1\s*$/.test(t)) return "1";
        }

        // From src/url filenames
        const m = combined.match(/(?:^|[^a-z0-9])(10|5|2|1)(?:[^a-z0-9]|$)/);
        if (m) return m[1];

        return null;
      }

      // Find target table
      const tables = document.querySelectorAll("table");
      let targetTable = null;
      for (const tbl of tables) {
        const headers = Array.from(tbl.querySelectorAll("th, thead td")).map(h => h.textContent.toLowerCase());
        if (headers.some(h => h.includes("spin result")) || headers.some(h => h.includes("occurred"))) {
          targetTable = tbl; break;
        }
      }
      if (!targetTable) return { items: [], debug: { error: "No matching table" }, sample: null };

      // Find columns
      const headerCells = Array.from(targetTable.querySelectorAll("th, thead td"));
      let timeCol = -1, spinCol = -1;
      headerCells.forEach((h, i) => {
        const t = h.textContent.toLowerCase();
        if (t.includes("occurred") || (t.includes("time") && timeCol === -1)) timeCol = i;
        if (t.includes("spin result")) spinCol = i;
      });
      if (spinCol === -1) headerCells.forEach((h, i) => { if (h.textContent.toLowerCase().includes("slot result")) spinCol = i; });

      const rows = targetTable.querySelectorAll("tbody tr");
      const out = [];
      let firstRowSample = null;

      for (let i = 0; i < rows.length; i++) {
        const cells = rows[i].querySelectorAll("td");
        if (cells.length === 0) continue;

        const timeText = timeCol >= 0 && cells[timeCol] ? cells[timeCol].textContent.trim() : "";
        const spinCell = spinCol >= 0 ? cells[spinCol] : null;
        const det = detectFromCell(spinCell);

        // Save first row's debug info
        if (i === 0 && spinCell) {
          firstRowSample = {
            time: timeText,
            spinCellHTML: spinCell.outerHTML.slice(0, 400),
            spinCellText: spinCell.textContent.trim(),
            imgCount: spinCell.querySelectorAll("img").length,
            firstImgSrc: (spinCell.querySelector("img") || {}).src || "",
            firstImgAlt: (spinCell.querySelector("img") || {}).alt || "",
            detected: det.result,
            rawHints: det.raw,
          };
        }

        if (det.result) out.push({ result: det.result, time: timeText });
        if (out.length >= 30) break;
      }

      return {
        items: out,
        debug: {
          tableCount: tables.length, rowCount: rows.length,
          timeCol, spinCol,
          headers: headerCells.map(h => h.textContent.trim()),
        },
        sample: firstRowSample,
      };
    });

    console.log(`✅ Scraped ${data.items.length} results`);
    if (data.sample) console.log(`   Sample row:`, JSON.stringify(data.sample));
    console.log(`   Debug:`, JSON.stringify(data.debug));

    cache = {
      results: data.items,
      lastUpdate: new Date().toISOString(),
      error: data.items.length === 0 ? `No results extracted` : null,
      debug: data.debug,
      sample: data.sample,
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

app.get("/", (req, res) => res.json({ status: "ok", target: TARGET_URL }));
app.get("/api/results", (req, res) => res.json(cache));
app.get("/api/refresh", async (req, res) => res.json(await scrapeResults()));
app.get("/api/health", (req, res) => res.json({ status: "ok", uptime: process.uptime(), lastUpdate: cache.lastUpdate, resultsCount: cache.results.length }));

app.listen(PORT, () => {
  console.log(`🎰 Crazy Time scraper v3 running on port ${PORT}`);
  setTimeout(autoRefresh, 2000);
});

process.on("SIGTERM", async () => { if (browser) await browser.close(); process.exit(0); });
