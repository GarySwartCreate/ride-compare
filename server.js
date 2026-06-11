// server.js — RideCompare
'use strict';

const express = require('express');
const path = require('path');
const { getUberPrices, getLyftPrices, getBrowser } = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

// ── Price comparison — Server-Sent Events ─────────────────────────────────────
// Results stream in as each service responds, so the UI updates immediately
// when Uber or Lyft comes back first.
app.get('/api/compare', async (req, res) => {
  const { pickupLat, pickupLng, pickupName,
          dropoffLat, dropoffLng, dropoffName,
          rideType, lyftRideId } = req.query;

  if (!pickupLat || !pickupLng || !dropoffLat || !dropoffLng) {
    return res.status(400).json({ error: 'Missing trip parameters.' });
  }

  const trip = {
    pickupLat:  parseFloat(pickupLat),
    pickupLng:  parseFloat(pickupLng),
    pickupName: pickupName  || 'Pickup',
    dropoffLat: parseFloat(dropoffLat),
    dropoffLng: parseFloat(dropoffLng),
    dropoffName: dropoffName || 'Dropoff',
    rideType:   rideType   || 'standard',
    lyftRideId: lyftRideId || 'lyft',
  };

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable Nginx buffering
  res.flushHeaders();

  const send = (event, data) => {
    if (!res.writableEnded) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  };

  let done = 0;
  const finish = () => { if (++done === 2 && !res.writableEnded) res.end(); };

  // Run Uber + Lyft in parallel; each streams its result as soon as it lands
  getUberPrices(trip)
    .then(result => { send('uber', result); finish(); })
    .catch(err   => { send('uber', { status: 'error', prices: [], error: err.message }); finish(); });

  getLyftPrices(trip)
    .then(result => { send('lyft', result); finish(); })
    .catch(err   => { send('lyft', { status: 'error', prices: [], error: err.message }); finish(); });

  // Safety timeout — end stream after 35s regardless
  setTimeout(() => { if (!res.writableEnded) res.end(); }, 35000);

  // Clean up if client disconnects early
  req.on('close', () => res.end());
});

// ── Serve SPA for all other routes ────────────────────────────────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`RideCompare → http://localhost:${PORT}`);
  getBrowser()
    .then(() => console.log('Browser warmed up.'))
    .catch(e  => console.error('Browser warmup failed:', e.message));
});

process.on('SIGTERM', () => process.exit(0));
