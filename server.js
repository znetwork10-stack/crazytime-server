// ═══════════════════════════════════════════════════════════
//  Crazy Time Live Scraper Server (v6)
//  NEW SOURCE: https://in.casino.org/india/casinoscores/crazy-time/
//  Returns rich debug info on first run so we can dial in selectors.
// ═══════════════════════════════════════════════════════════

const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer");

const app = express();
const PORT = process.env.PORT || 3000;
const TARGET_URL = "https://in.casino.org/india/casinoscores/crazy-time/";

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

function mapToken(token) {
  if (!token) return null;
  const t = String(token).trim().toLowerCase();

  // Bonus games
  if (/(crazy[\s_-]*time|crazytime)/.test(t)) return "Crazy Time";
  if (/(coin[\s_-]*flip|coinflip)/.test(t)) return "Coin Flip";
  if (/(cash[\s_-]*hunt|cashhunt)/.test(t)) return "Cash Hunt";
  if (/pachinko/.test(t)) return "Pachinko";

  // Numbers — exact match only
  if (/^10$/.test(t)) return "10";
  if (/^5$/.test(t)) return "5";
  if (/^2$/.test(t)) return "2";
  if (/^1$/.test(t)) return "1";

  return null;
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
    await new Promise(r => setTimeout(r, 6000));

    const data = await page.evaluate(() => {
      const out = [];
      const samples = [];

      // Helper: detect from anything
      function detectFromEl(el) {
        if (!el) return { result: null, raw: "" };
        const clues = [];
        const text = (el.textContent || "").trim();
        if (text) clues.push(text);
        if (el.alt) clues.push(el.alt);
        if (el.title) clues.push(el.title);
        if (el.src) clues.push(el.src);
        if (el.className && typeof el.className === "string") clues.push(el.className);
        if (el.dataset) {
          for (const k of Object.keys(el.dataset)) clues.push(el.dataset[k]);
        }
        // Children
        const imgs = el.querySelectorAll ? el.querySelectorAll("img") : [];
        for (const img of imgs) {
          if (img.alt) clues.push(img.alt);
          if (img.src) clues.push(img.src);
        }
        const allChildren = el.querySelectorAll ? el.querySelectorAll("*") : [];
        for (const c of allChildren) {
          if (c.className && typeof c.className === "string" && c.className.length < 80) clues.push(c.className);
          const bg = window.getComputedStyle(c).backgroundImage;
          if (bg && bg !== "none") clues.push(bg);
        }
        return { result: null, clues: clues.slice(0, 8), raw: clues.slice(0, 4).join(" || ").slice(0, 200) };
      }

      // ==== Strategy 1: Find a results table with Spin/Slot Result column ====
      const tables = document.querySelectorAll("table");
      let bestTable = null;
      for (const tbl of tables) {
        const headers = Array.from(tbl.querySelectorAll("th, thead td")).map(h => h.textContent.toLowerCase());
        if (headers.some(h => h.includes("result") || h.includes("spin") || h.includes("slot") || h.includes("outcome"))) {
          bestTable = tbl;
          break;
        }
      }

      if (bestTable) {
        const headerCells = Array.from(bestTable.querySelectorAll("th, thead td"));
        const headersStr = headerCells.map(h => h.textContent.trim());

        const rows = bestTable.querySelectorAll("tbody tr");
        for (let i = 0; i < rows.length; i++) {
          const cells = Array.from(rows[i].querySelectorAll("td"));
          if (cells.length === 0) continue;

          // Try every cell to find a result match
          let foundResult = null, foundIn = -1, foundClues = "";
          for (let c = 0; c < cells.length; c++) {
            const det = (function(cell){
              if (!cell) return null;
              const els = [cell, ...cell.querySelectorAll("*")];
              for (const el of els) {
                const tries = [];
                if (el.alt) tries.push(el.alt);
                if (el.title) tries.push(el.title);
                if (el.src) tries.push(el.src);
                if (el.className && typeof el.className === "string") tries.push(el.className);
                if (el.dataset) for (const k of Object.keys(el.dataset)) tries.push(el.dataset[k]);
                for (const t of tries) {
                  // From class names like "result-1", "outcome-coinflip", "icon-crazy-time"
                  const match = String(t).toLowerCase();
                  if (/crazy[\s_-]*time|crazytime/.test(match)) return "Crazy Time";
                  if (/coin[\s_-]*flip|coinflip/.test(match)) return "Coin Flip";
                  if (/cash[\s_-]*hunt|cashhunt/.test(match)) return "Cash Hunt";
                  if (/pachinko/.test(match)) return "Pachinko";
                  // From URLs / class endings: -1, -2, -5, -10
                  const numFromAttr = match.match(/(?:result|outcome|slot|spin|seg|number|num)[-_](\d+)/);
                  if (numFromAttr && ["1","2","5","10"].includes(numFromAttr[1])) return numFromAttr[1];
                  const slotFromUrl = match.match(/\/(\d+)\.(webp|png|svg|jpg)/);
                  if (slotFromUrl && ["1","2","5","10"].includes(slotFromUrl[1])) return slotFromUrl[1];
                }
              }
              // Plain text fallback
              const text = (cell.textContent || "").trim();
              if (/^(crazy\s*time|coin\s*flip|cash\s*hunt|pachinko)$/i.test(text)) {
                if (/crazy/i.test(text)) return "Crazy Time";
                if (/coin/i.test(text)) return "Coin Flip";
                if (/cash/i.test(text)) return "Cash Hunt";
                if (/pachinko/i.test(text)) return "Pachinko";
              }
              if (/^(10|5|2|1)$/.test(text)) return text;
              return null;
            })(cells[c]);
            if (det) {
              foundResult = det;
              foundIn = c;
              break;
            }
          }

          // Time: usually leftmost column or one labeled "time"/"finished"
          let timeText = "";
          const timeIdx = headersStr.findIndex(h => /time|finished|when|occurred/i.test(h));
          if (timeIdx >= 0 && cells[timeIdx]) {
            timeText = cells[timeIdx].textContent.trim();
          } else if (cells[0]) {
            timeText = cells[0].textContent.trim();
          }

          if (i < 4) {
            samples.push({
              row: i,
              time: timeText,
              cellCount: cells.length,
              cellsHTML: cells.map(c => c.outerHTML.slice(0, 200)),
              detected: foundResult,
              detectedInCol: foundIn,
            });
          }

          if (foundResult) out.push({ result: foundResult, time: timeText });
          if (out.length >= 30) break;
        }

        return {
          items: out,
          debug: {
            strategy: "table",
            url: location.href,
            title: document.title,
            tableCount: tables.length,
            rowCount: rows.length,
            headers: headersStr,
          },
          samples,
        };
      }

      // ==== Strategy 2: card/list layout (no table) ====
      // Look for repeated elements that contain result info
      const candidates = document.querySelectorAll("[class*='result'], [class*='spin'], [class*='outcome'], [class*='history'] > *, [class*='round']");
      const listSamples = [];
      for (const c of Array.from(candidates).slice(0, 30)) {
        const text = (c.textContent || "").trim();
        if (text.length > 100 || text.length < 1) continue;
        listSamples.push({ class: c.className, text: text.slice(0, 80), html: c.outerHTML.slice(0, 200) });
        if (listSamples.length >= 5) break;
      }

      return {
        items: [],
        debug: {
          strategy: "fallback",
          url: location.href,
          title: document.title,
          tableCount: tables.length,
          bodyHasText: (document.body.textContent || "").length,
          listCandidates: candidates.length,
        },
        samples: listSamples,
      };
    });

    console.log(`✅ Scraped ${data.items.length} results`);
    if (data.items.length > 0) {
      console.log(`   Latest: ${data.items.slice(0, 5).map(r => `${r.result}@${r.time}`).join(" | ")}`);
    } else {
      console.log(`   Debug:`, JSON.stringify(data.debug));
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
  setTimeout(autoRefresh, 5000); // faster: every 5 seconds
}

app.get("/", (req, res) => res.json({ status: "ok", target: TARGET_URL, version: "v6" }));
app.get("/api/results", (req, res) => res.json(cache));
app.get("/api/refresh", async (req, res) => res.json(await scrapeResults()));
app.get("/api/health", (req, res) => res.json({ status: "ok", uptime: process.uptime(), lastUpdate: cache.lastUpdate, resultsCount: cache.results.length }));

app.listen(PORT, () => {
  console.log(`🎰 Crazy Time scraper v6 running on port ${PORT}`);
  console.log(`📡 Targeting: ${TARGET_URL}`);
  setTimeout(autoRefresh, 2000);
});

process.on("SIGTERM", async () => { if (browser) await browser.close(); process.exit(0); });
