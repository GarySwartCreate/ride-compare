// scraper.js — Puppeteer price scraping for Uber and Lyft
'use strict';

const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteerExtra.use(StealthPlugin());

const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';
const TIMEOUT_MS = 28000;

// ── Single shared browser instance ───────────────────────────────────────────
let browser = null;

async function getBrowser() {
  if (browser && browser.connected) return browser;
  browser = await puppeteerExtra.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-extensions',
    ],
  });
  browser.on('disconnected', () => { browser = null; });
  return browser;
}

// ── Price extraction (runs inside the browser page via page.evaluate) ─────────
function extractorFn(productNames) {
  const results = [];
  const seen = new Set();

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;

  while ((node = walker.nextNode())) {
    const raw = node.textContent.trim();
    if (!raw.includes('$') || raw.length > 25) continue;

    const m = raw.match(/\$\d+(\.\d{1,2})?(\s*[–\-]\s*\$?\d+(\.\d{1,2})?)?/);
    if (!m) continue;

    const price = m[0].replace(/\s+/g, '');
    if (seen.has(price)) continue;

    // Walk up the DOM to find a ride-type name nearby
    let el = node.parentElement;
    let name = null;

    for (let depth = 0; depth < 10 && el && el !== document.body; depth++) {
      const text = el.innerText || '';
      if (text.length > 350) break;

      for (const n of productNames) {
        if (text.includes(n)) { name = n; break; }
      }

      // Also check data-testid / aria-label
      const hint = (el.getAttribute('data-testid') || '') + (el.getAttribute('aria-label') || '');
      if (!name && hint) {
        for (const n of productNames) {
          if (hint.toLowerCase().includes(n.toLowerCase())) { name = n; break; }
        }
      }

      if (name) break;
      el = el.parentElement;
    }

    if (name) {
      seen.add(price);
      results.push({ name, price });
    }
  }

  // Deduplicate: keep one entry per name (first found)
  const byName = {};
  for (const r of results) {
    if (!byName[r.name]) byName[r.name] = r;
  }
  return Object.values(byName);
}

// ── Wait until prices appear (or timeout) ────────────────────────────────────
async function waitForPrices(page, productNames, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const prices = await page.evaluate(extractorFn, productNames).catch(() => []);
    if (prices.length > 0) return prices;
    await new Promise(r => setTimeout(r, 700));
  }
  return [];
}

// ── Check if we landed on a login page ───────────────────────────────────────
async function isLoginPage(page) {
  const url = page.url();
  if (/login|signup|signin|authenticate|onboarding/i.test(url)) return true;

  // Check for common login form indicators
  const hasLoginForm = await page.evaluate(() => {
    return !!(
      document.querySelector('input[type="password"]') ||
      document.querySelector('[data-testid*="login"]') ||
      document.querySelector('[data-testid*="signin"]')
    );
  }).catch(() => false);

  return hasLoginForm;
}

// ── Inject stored cookies ─────────────────────────────────────────────────────
async function injectCookies(page, cookieString, domain) {
  if (!cookieString) return;
  const pairs = cookieString.split(';').map(s => s.trim()).filter(Boolean);
  const cookies = pairs.map(pair => {
    const idx = pair.indexOf('=');
    return {
      name: pair.slice(0, idx).trim(),
      value: pair.slice(idx + 1).trim(),
      domain,
      path: '/',
    };
  }).filter(c => c.name);

  if (cookies.length) {
    await page.setCookie(...cookies);
  }
}

// ── Uber ──────────────────────────────────────────────────────────────────────
const UBER_PRODUCTS = [
  'UberX', 'Uber X', 'Comfort', 'UberXL', 'Uber XL',
  'Black', 'Black SUV', 'SUV', 'Share', 'Pool', 'Green', 'Flash',
];

async function getUberPrices(trip) {
  const b = await getBrowser();
  const page = await b.newPage();

  try {
    await page.setViewport({ width: 390, height: 844, isMobile: true });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    const url = buildUberUrl(trip);

    // First try: no auth
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await new Promise(r => setTimeout(r, 2500)); // let React render

    if (await isLoginPage(page)) {
      // Try injecting stored cookies
      const cookieStr = process.env.UBER_COOKIES || '';
      if (cookieStr) {
        await injectCookies(page, cookieStr, '.uber.com');
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await new Promise(r => setTimeout(r, 2500));

        if (await isLoginPage(page)) {
          return { status: 'login-required', prices: [] };
        }
      } else {
        return { status: 'login-required', prices: [] };
      }
    }

    const prices = await waitForPrices(page, UBER_PRODUCTS, TIMEOUT_MS - 5000);

    return {
      status: prices.length > 0 ? 'ok' : 'no-prices',
      prices,
      url,
    };
  } catch (err) {
    console.error('Uber scrape error:', err.message);
    return { status: 'error', prices: [], error: err.message };
  } finally {
    await page.close().catch(() => {});
  }
}

// ── Lyft ──────────────────────────────────────────────────────────────────────
const LYFT_PRODUCTS = [
  'Lyft XL', 'Lyft Lux Black XL', 'Lyft Lux Black', 'Lyft Lux',
  'Lyft', 'Lux Black XL', 'Lux Black', 'Lux', 'Standard', 'Shared', 'Priority',
];

async function getLyftPrices(trip) {
  const b = await getBrowser();
  const page = await b.newPage();

  try {
    await page.setViewport({ width: 390, height: 844, isMobile: true });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    const url = buildLyftUrl(trip);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await new Promise(r => setTimeout(r, 2500));

    if (await isLoginPage(page)) {
      const cookieStr = process.env.LYFT_COOKIES || '';
      if (cookieStr) {
        await injectCookies(page, cookieStr, '.lyft.com');
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await new Promise(r => setTimeout(r, 2500));

        if (await isLoginPage(page)) {
          return { status: 'login-required', prices: [] };
        }
      } else {
        return { status: 'login-required', prices: [] };
      }
    }

    const prices = await waitForPrices(page, LYFT_PRODUCTS, TIMEOUT_MS - 5000);

    return {
      status: prices.length > 0 ? 'ok' : 'no-prices',
      prices,
      url,
    };
  } catch (err) {
    console.error('Lyft scrape error:', err.message);
    return { status: 'error', prices: [], error: err.message };
  } finally {
    await page.close().catch(() => {});
  }
}

// ── URL builders ──────────────────────────────────────────────────────────────
function buildUberUrl(t) {
  return `https://m.uber.com/ul/?action=setPickup` +
    `&pickup[latitude]=${t.pickupLat}&pickup[longitude]=${t.pickupLng}&pickup[nickname]=${enc(t.pickupName)}` +
    `&dropoff[latitude]=${t.dropoffLat}&dropoff[longitude]=${t.dropoffLng}&dropoff[nickname]=${enc(t.dropoffName)}`;
}

function buildLyftUrl(t) {
  return `https://ride.lyft.com/ridetype?id=${t.lyftRideId || 'lyft'}` +
    `&pickup[latitude]=${t.pickupLat}&pickup[longitude]=${t.pickupLng}&pickup[address]=${enc(t.pickupName)}` +
    `&destination[latitude]=${t.dropoffLat}&destination[longitude]=${t.dropoffLng}&destination[address]=${enc(t.dropoffName)}`;
}

function enc(s) { return encodeURIComponent(s || ''); }

// ── Exported comparison runner ────────────────────────────────────────────────
async function comparePrices(trip) {
  const [uber, lyft] = await Promise.all([
    getUberPrices(trip),
    getLyftPrices(trip),
  ]);
  return { uber, lyft };
}

module.exports = { comparePrices, getBrowser, getUberPrices, getLyftPrices };
