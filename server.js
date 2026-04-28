// ═══════════════════════════════════════════════════════════
//  Crazy Time Live Scraper Server (v7)
//  STRATEGY: Intercept API/WebSocket traffic on casino.org
//  This catches the live data feed they use internally.
// ═══════════════════════════════════════════════════════════

const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer");

const app = express();
const PORT = process.env.PORT || 3000;
const TARGET_URL = "https://www.casino.org/casinoscores/crazy-time/";

app.use(cors());
app.use(express.json());

let cache = {
  lastResult: null,         // { result, time }
  lastUpdate: null,
  error: null,
  capturedURLs: [],         // for debugging — what API endpoints we found
  rawHistory: [],           // last 30 results
};

let browser = null;
let monitorPage = null;
let monitorRunning = false;

// Map raw outcome strings/codes from casino.org to our standard names
function mapOutcome(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  if (s === "1" || s === "one") return "1";
  if (s === "2" || s === "two") return "2";
  if (s === "5" || s === "five") return "5";
  if (s === "10" || s === "ten") return "10";
  if (/crazy[\s_-]*time|crazytime/.test(s)) return "Crazy Time";
  if (/coin[\s_-]*flip|coinflip/.test(s)) return "Coin Flip";
  if (/cash[\s_-]*hunt|cashhunt/.test(s)) return "Cash Hunt";
  if (/pachinko/.test(s)) return "Pachinko";
  return null;
}

// Parse JSON response body looking for spin results
function tryExtractFromJSON(jsonText, sourceUrl) {
  try {
    const data = JSON.parse(jsonText);
    return walkForResults(data, sourceUrl);
  } catch (e) {
    return [];
  }
}

function walkForResults(obj, sourceUrl, depth = 0) {
  if (depth > 6 || !obj) return [];
  const results = [];

  // If it's an array, check each item
  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (typeof item === "object" && item !== null) {
        // Common fields casino tracker APIs use
        const result = mapOutcome(
          item.result || item.outcome || item.slot_result ||
          item.slotResult || item.spin_result || item.spinResult ||
          item.value || item.winningSegment || item.segment ||
          item.symbol || item.name
        );
        if (result) {
          const time = item.timestamp || item.time || item.finished ||
                       item.finishedAt || item.startedAt || item.created || "";
          results.push({ result, time: String(time), source: sourceUrl });
          continue;
        }
        // Recurse if no direct match
        const nested = walkForResults(item, sourceUrl, depth + 1);
        if (nested.length) results.push(...nested);
      }
    }
    return results;
  }

  // Object — check fields and recurse
  if (typeof obj === "object") {
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (Array.isArray(val) || (typeof val === "object" && val !== null)) {
        const sub = walkForResults(val, sourceUrl, depth + 1);
        if (sub.length) results.push(...sub);
      }
    }
  }
  return results;
}

async function getBrowser() {
  if (browser && browser.connected) return browser;
  console.log("🚀 Launching headless Chrome...");
  browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage","--disable-gpu","--no-first-run"],
  });
  return browser;
}

async function startMonitor() {
  if (monitorRunning) return;
  monitorRunning = true;

  try {
    const br = await getBrowser();
    monitorPage = await br.newPage();
    await monitorPage.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
    await monitorPage.setViewport({ width: 1280, height: 900 });

    // Hook into ALL network responses
    monitorPage.on("response", async (response) => {
      const url = response.url();
      const ct = response.headers()["content-type"] || "";

      // Only care about JSON responses (likely API)
      if (!ct.includes("json")) return;
      // Skip obvious non-game endpoints
      if (/\.(png|jpg|webp|svg|css|woff)/.test(url)) return;
      if (/google|facebook|gtag|analytics|sentry|cloudflare/.test(url)) return;

      try {
        const text = await response.text();
        if (text.length < 30 || text.length > 200000) return;

        const found = tryExtractFromJSON(text, url);
        if (found.length > 0) {
          // Track the source URL once
          if (!cache.capturedURLs.includes(url)) {
            cache.capturedURLs.push(url);
            if (cache.capturedURLs.length > 5) cache.capturedURLs.shift();
            console.log(`🎯 Found data feed: ${url.slice(0, 100)}`);
          }

          // Update history with new results (newest first)
          for (const r of found) {
            const key = `${r.result}|${r.time}`;
            const existing = cache.rawHistory.find(h => `${h.result}|${h.time}` === key);
            if (!existing) {
              cache.rawHistory.unshift({ result: r.result, time: r.time });
            }
          }
          cache.rawHistory = cache.rawHistory.slice(0, 30);

          if (cache.rawHistory.length > 0) {
            cache.lastResult = cache.rawHistory[0];
            cache.lastUpdate = new Date().toISOString();
            cache.error = null;
            console.log(`✅ ${cache.rawHistory[0].result} @ ${cache.rawHistory[0].time}`);
          }
        }
      } catch (e) {
        // Ignore parsing errors
      }
    });

    // Also log WebSocket frames
    const client = await monitorPage.target().createCDPSession();
    await client.send("Network.enable");
    client.on("Network.webSocketFrameReceived", ({ response }) => {
      try {
        const payload = response.payloadData;
        if (!payload || payload.length < 20) return;
        const found = tryExtractFromJSON(payload, "websocket");
        if (found.length > 0) {
          if (!cache.capturedURLs.includes("websocket")) {
            cache.capturedURLs.push("websocket");
            console.log(`🎯 Live WebSocket data feed detected!`);
          }
          for (const r of found) {
            const key = `${r.result}|${r.time}`;
            const existing = cache.rawHistory.find(h => `${h.result}|${h.time}` === key);
            if (!existing) {
              cache.rawHistory.unshift({ result: r.result, time: r.time });
            }
          }
          cache.rawHistory = cache.rawHistory.slice(0, 30);
          if (cache.rawHistory.length > 0) {
            cache.lastResult = cache.rawHistory[0];
            cache.lastUpdate = new Date().toISOString();
            console.log(`📡 (WS) ${cache.rawHistory[0].result} @ ${cache.rawHistory[0].time}`);
          }
        }
      } catch (e) {}
    });

    console.log(`🔍 Loading ${TARGET_URL} and monitoring all network traffic...`);
    await monitorPage.goto(TARGET_URL, { waitUntil: "networkidle2", timeout: 45000 });
    console.log(`✅ Page loaded. Now passively monitoring for live updates.`);

    // Keep page alive — refresh every 5 min so it doesn't get stale
    setInterval(async () => {
      try {
        if (monitorPage && !monitorPage.isClosed()) {
          console.log("🔄 Refreshing monitor page...");
          await monitorPage.reload({ waitUntil: "networkidle2", timeout: 30000 });
        }
      } catch (e) { console.error("Refresh failed:", e.message); }
    }, 5 * 60 * 1000);

  } catch (err) {
    console.error("❌ Monitor failed:", err.message);
    cache.error = err.message;
    monitorRunning = false;
  }
}

// API endpoints
app.get("/", (req, res) => res.json({
  status: "ok",
  target: TARGET_URL,
  version: "v7-intercept",
  monitoring: monitorRunning,
}));

app.get("/api/results", (req, res) => res.json({
  results: cache.rawHistory,
  lastResult: cache.lastResult,
  lastUpdate: cache.lastUpdate,
  error: cache.error,
  capturedURLs: cache.capturedURLs,
}));

app.get("/api/health", (req, res) => res.json({
  status: "ok",
  uptime: process.uptime(),
  lastUpdate: cache.lastUpdate,
  resultCount: cache.rawHistory.length,
  capturedFeeds: cache.capturedURLs.length,
}));

app.listen(PORT, () => {
  console.log(`🎰 Crazy Time scraper v7 running on port ${PORT}`);
  console.log(`📡 Will intercept network traffic from: ${TARGET_URL}`);
  setTimeout(startMonitor, 3000);
});

process.on("SIGTERM", async () => { if (browser) await browser.close(); process.exit(0); });
