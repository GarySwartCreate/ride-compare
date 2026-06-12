// scraper.js — Puppeteer price scraping for Uber and Lyft
'use strict';

const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteerExtra.use(StealthPlugin());

const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';
const TIMEOUT_MS = 30000;

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
      '--window-size=390,844',
    ],
  });
  browser.on('disconnected', () => { browser = null; });
  return browser;
}

// ── Price extraction — runs inside the browser via page.evaluate ──────────────
function extractPrices(productNames) {
  const results = [];
  const seen = new Set();

  // Strategy 1: Walk all text nodes looking for price patterns
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;

  while ((node = walker.nextNode())) {
    const raw = node.textContent.trim();
    if (!raw.includes('$') || raw.length > 30) continue;

    const m = raw.match(/\$\s*\d+(\.\d{1,2})?(\s*[–\-]\s*\$?\s*\d+(\.\d{1,2})?)?/);
    if (!m) continue;

    const price = m[0].replace(/\s+/g, '');
    if (seen.has(price)) continue;

    // Climb DOM to find associated product name
    let el = node.parentElement;
    let name = null;

    for (let depth = 0; depth < 12 && el && el !== document.body; depth++) {
      const text = (el.innerText || '').slice(0, 400);
      for (const n of productNames) {
        if (text.includes(n)) { name = n; break; }
      }
      if (!name) {
        const hint = (el.getAttribute('data-testid') || '') +
                     (el.getAttribute('aria-label') || '') +
                     (el.getAttribute('class') || '');
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

  // Strategy 2: If nothing found with names, return all prices found (unnamed)
  if (results.length === 0) {
    const allPrices = [];
    const walker2 = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while ((node = walker2.nextNode())) {
      const raw = node.textContent.trim();
      if (!raw.includes('$') || raw.length > 20) continue;
      const m = raw.match(/^\$\d+(\.\d{1,2})?(\s*[–\-]\s*\$?\d+(\.\d{1,2})?)?$/);
      if (m && !seen.has(m[0])) {
        seen.add(m[0]);
        allPrices.push({ name: 'Ride', price: m[0] });
      }
    }
    return allPrices;
  }

  // Deduplicate by name
  const byName = {};
  for (const r of results) { if (!byName[r.name]) byName[r.name] = r; }
  return Object.values(byName);
}

// ── Wait for prices to appear ─────────────────────────────────────────────────
async function waitForPrices(page, productNames, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const prices = await page.evaluate(extractPrices, productNames).catch(() => []);
    if (prices.length > 0) return prices;
    await sleep(800);
  }
  return [];
}

// ── Check for login page ──────────────────────────────────────────────────────
async function isLoginPage(page) {
  const url = page.url();
  if (/login|signup|signin|authenticate|onboarding/i.test(url)) return true;
  return page.evaluate(() =>
    !!(document.querySelector('input[type="password"]') ||
       document.querySelector('[data-testid*="login"]') ||
       document.querySelector('[data-testid*="signin"]'))
  ).catch(() => false);
}

// ── Inject cookies ────────────────────────────────────────────────────────────
async function injectCookies(page, cookieString, domain) {
  if (!cookieString) return;
  const cookies = cookieString.split(';')
    .map(s => s.trim()).filter(Boolean)
    .map(pair => {
      const idx = pair.indexOf('=');
      return { name: pair.slice(0, idx).trim(), value: pair.slice(idx + 1).trim(), domain, path: '/' };
    }).filter(c => c.name && c.value);
  if (cookies.length) await page.setCookie(...cookies);
}

// ── Uber ──────────────────────────────────────────────────────────────────────
const UBER_PRODUCTS = [
  'UberX', 'Uber X', 'Comfort', 'UberXL', 'Uber XL',
  'Black', 'Black SUV', 'SUV', 'Share', 'Pool', 'Green', 'Flash', 'Uber',
];

async function getUberPrices(trip) {
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setViewport({ width: 390, height: 844, isMobile: true });
    await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    // Inject cookies before navigating
    const cookieStr = process.env.UBER_COOKIES || '';
    if (cookieStr) await injectCookies(page, cookieStr, '.uber.com');

    const url = buildUberUrl(trip);
    console.log('[Uber] Navigating to:', url.slice(0, 80));

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });
    await sleep(3000); // let React fully render

    const finalUrl = page.url();
    console.log('[Uber] Landed on:', finalUrl.slice(0, 80));

    if (await isLoginPage(page)) {
      console.log('[Uber] Login page detected');
      return { status: 'login-required', prices: [] };
    }

    // Log page title for debugging
    const title = await page.title().catch(() => '?');
    console.log('[Uber] Page title:', title);

    // Check page text for debug
    const bodySnippet = await page.evaluate(() =>
      (document.body.innerText || '').slice(0, 300)
    ).catch(() => '');
    console.log('[Uber] Body snippet:', bodySnippet.replace(/\n/g, ' ').slice(0, 200));

    // Try clicking "See prices" or similar CTAs if present
    try {
      const cta = await page.$('[data-testid*="price"], button[data-testid*="product"], [aria-label*="price"], [aria-label*="fare"]');
      if (cta) { await cta.click(); await sleep(2000); }
    } catch {}

    const prices = await waitForPrices(page, UBER_PRODUCTS, TIMEOUT_MS - 8000);
    console.log('[Uber] Prices found:', prices.length, prices.map(p => `${p.name}:${p.price}`).join(', '));

    return { status: prices.length > 0 ? 'ok' : 'no-prices', prices, url };
  } catch (err) {
    console.error('[Uber] Error:', err.message);
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
    await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    const cookieStr = process.env.LYFT_COOKIES || '';
    if (cookieStr) await injectCookies(page, cookieStr, '.lyft.com');

    const url = buildLyftUrl(trip);
    console.log('[Lyft] Navigating to:', url.slice(0, 80));

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });
    await sleep(3000);

    const finalUrl = page.url();
    console.log('[Lyft] Landed on:', finalUrl.slice(0, 80));

    if (await isLoginPage(page)) {
      console.log('[Lyft] Login page detected');
      return { status: 'login-required', prices: [] };
    }

    const title = await page.title().catch(() => '?');
    console.log('[Lyft] Page title:', title);

    const bodySnippet = await page.evaluate(() =>
      (document.body.innerText || '').slice(0, 300)
    ).catch(() => '');
    console.log('[Lyft] Body snippet:', bodySnippet.replace(/\n/g, ' ').slice(0, 200));

    const prices = await waitForPrices(page, LYFT_PRODUCTS, TIMEOUT_MS - 8000);
    console.log('[Lyft] Prices found:', prices.length, prices.map(p => `${p.name}:${p.price}`).join(', '));

    return { status: prices.length > 0 ? 'ok' : 'no-prices', prices, url };
  } catch (err) {
    console.error('[Lyft] Error:', err.message);
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
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { getUberPrices, getLyftPrices, getBrowser };
