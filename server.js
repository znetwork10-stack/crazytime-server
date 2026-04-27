// ═══════════════════════════════════════════════════════════
//  Crazy Time Live Scraper Server (v4)
//  CRITICAL FIX: reads SLOT RESULT (the actual wheel landing)
//  not "Spin Result" (which is post-bonus payout description).
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
      // Detect from cell — VERY conservative, requires explicit match
      function detectFromCell(cell) {
        if (!cell) return { result: null, raw: "" };

        // Gather every clue
        const clues = [];
        const text = (cell.textContent || "").trim();
        if (text) clues.push("TEXT:" + text);

        const imgs = cell.querySelectorAll("img");
        for (const img of imgs) {
          if (img.alt) clues.push("ALT:" + img.alt);
          if (img.title) clues.push("TITLE:" + img.title);
          if (img.src) clues.push("SRC:" + img.src);
        }

        const allChildren = cell.querySelectorAll("*");
        for (const c of allChildren) {
          const bg = window.getComputedStyle(c).backgroundImage;
          if (bg && bg !== "none") clues.push("BG:" + bg);
          if (c.className && typeof c.className === "string" && c.className.length < 100) clues.push("CLS:" + c.className);
          if (c.dataset) {
            for (const k of Object.keys(c.dataset)) clues.push("DATA:" + k + "=" + c.dataset[k]);
          }
        }

        const all = clues.join(" || ").toLowerCase();
        const result = matchResult(all, text);
        return { result, raw: clues.slice(0, 6).join(" || ").slice(0, 250) };
      }

      function matchResult(all, originalText) {
        if (!all) return null;

        // Bonus games: must have explicit indicator (longer names checked first)
        if (/(?:^|[^a-z])crazy[\s_-]*time(?:[^a-z]|$)/i.test(all) || /ico-crazytime/.test(all) || /crazytime\b/.test(all)) return "Crazy Time";
        if (/(?:^|[^a-z])coin[\s_-]*flip(?:[^a-z]|$)/i.test(all) || /ico-coinflip/.test(all) || /coinflip\b/.test(all)) return "Coin Flip";
        if (/(?:^|[^a-z])cash[\s_-]*hunt(?:[^a-z]|$)/i.test(all) || /ico-cashhunt/.test(all) || /cashhunt\b/.test(all)) return "Cash Hunt";
        if (/(?:^|[^a-z])pachinko(?:[^a-z]|$)/i.test(all) || /ico-pachinko/.test(all)) return "Pachinko";

        // Numbers — STRICT: prefer the cell's plain text first
        if (originalText) {
          const t = originalText.trim();
          if (/^10$/.test(t)) return "10";
          if (/^5$/.test(t)) return "5";
          if (/^2$/.test(t)) return "2";
          if (/^1$/.test(t)) return "1";
        }

        // From src/icon filenames — be strict, require "ico-N" or similar
        const ico = all.match(/ico-(\d+)/);
        if (ico && ["1","2","5","10"].includes(ico[1])) return ico[1];
        // url(.../N.webp) or url(.../N.png)
        const numUrl = all.match(/\/(\d+)\.(webp|png|svg|jpg)/);
        if (numUrl && ["1","2","5","10"].includes(numUrl[1])) return numUrl[1];
        // class name like "result-5" or "spin-10"
        const clsNum = all.match(/(?:result|slot|spin|seg|num)[-_](\d+)/);
        if (clsNum && ["1","2","5","10"].includes(clsNum[1])) return clsNum[1];

        return null;
      }

      // Find target table
      const tables = document.querySelectorAll("table");
      let targetTable = null;
      for (const tbl of tables) {
        const headers = Array.from(tbl.querySelectorAll("th, thead td")).map(h => h.textContent.toLowerCase());
        if (headers.some(h => h.includes("slot result")) || headers.some(h => h.includes("occurred"))) {
          targetTable = tbl; break;
        }
      }
      if (!targetTable) return { items: [], debug: { error: "No matching table" }, samples: [] };

      // Find columns — PREFER "Slot Result" (the actual wheel landing)
      const headerCells = Array.from(targetTable.querySelectorAll("th, thead td"));
      let timeCol = -1, slotCol = -1, spinCol = -1;
      headerCells.forEach((h, i) => {
        const t = h.textContent.toLowerCase();
        if (t.includes("occurred") || (t.includes("time") && timeCol === -1)) timeCol = i;
        if (t.includes("slot result")) slotCol = i;       // ✅ THE ACTUAL RESULT
        if (t.includes("spin result")) spinCol = i;       // (post-bonus, ignore)
      });

      const useCol = slotCol !== -1 ? slotCol : spinCol;

      const rows = targetTable.querySelectorAll("tbody tr");
      const out = [];
      const samples = [];

      for (let i = 0; i < rows.length; i++) {
        const cells = rows[i].querySelectorAll("td");
        if (cells.length === 0) continue;

        const timeText = timeCol >= 0 && cells[timeCol] ? cells[timeCol].textContent.trim() : "";
        const targetCell = useCol >= 0 ? cells[useCol] : null;
        const det = detectFromCell(targetCell);

        // Save first 3 rows as debug samples
        if (i < 3 && targetCell) {
          samples.push({
            rowIdx: i,
            time: timeText,
            cellHTML: targetCell.outerHTML.slice(0, 350),
            cellText: targetCell.textContent.trim(),
            imgCount: targetCell.querySelectorAll("img").length,
            firstImgSrc: (targetCell.querySelector("img") || {}).src || "",
            firstImgAlt: (targetCell.querySelector("img") || {}).alt || "",
            detected: det.result,
            rawClues: det.raw,
          });
        }

        if (det.result) out.push({ result: det.result, time: timeText });
        if (out.length >= 30) break;
      }

      return {
        items: out,
        debug: {
          tableCount: tables.length, rowCount: rows.length,
          timeCol, slotCol, spinCol, useCol,
          headers: headerCells.map(h => h.textContent.trim()),
        },
        samples,
      };
    });

    console.log(`✅ Scraped ${data.items.length} results`);
    if (data.samples && data.samples.length) {
      console.log(`   Samples:`, JSON.stringify(data.samples).slice(0, 800));
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

app.get("/", (req, res) => res.json({ status: "ok", target: TARGET_URL, version: "v4" }));
app.get("/api/results", (req, res) => res.json(cache));
app.get("/api/refresh", async (req, res) => res.json(await scrapeResults()));
app.get("/api/health", (req, res) => res.json({ status: "ok", uptime: process.uptime(), lastUpdate: cache.lastUpdate, resultsCount: cache.results.length }));

app.listen(PORT, () => {
  console.log(`🎰 Crazy Time scraper v4 running on port ${PORT}`);
  setTimeout(autoRefresh, 2000);
});

process.on("SIGTERM", async () => { if (browser) await browser.close(); process.exit(0); });
