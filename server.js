'use strict';
// Server dashboard SATS (tanpa dependency): menyajikan public/index.html + API candle OKX/Bitget + posisi bot.
// Env: PORT=3000 DASH_TOKEN=rahasia STATE_FILE=./state.json
//   GET /                      -> dashboard
//   GET /api/candles?ex=okx|bitget&pair=BTC-USDT&bar=1H&limit=600   (hanya candle yang sudah close)
//   GET /api/positions         -> posisi & histori dari state.json milik bot
// Jika DASH_TOKEN diisi, semua /api/* butuh ?token=... atau header x-token.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fetchCandles } = require('./data');
const scanner = require('./scanner');

const PORT = +(process.env.PORT || 3000);
const TOKEN = process.env.DASH_TOKEN || '';
const STATE_FILE = process.env.STATE_FILE || './state.json';
const BARS = new Set(['5m', '15m', '30m', '1H', '4H', '1D']);
const EXS = new Set(['okx', 'bitget']);
const SCAN_FILE = process.env.SCAN_FILE || './scan.json';
let lastManualScan = 0;
const CACHE_MS = 20000;
const VENDOR = { 'lightweight-charts.standalone.production.js': 'application/javascript; charset=utf-8', 'LICENSE-lightweight-charts.txt': 'text/plain; charset=utf-8' };
const cache = new Map(); // key -> { ts, p: Promise }

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};

function authorized(url, req) {
  if (!TOKEN) return true;
  const given = url.searchParams.get('token') || req.headers['x-token'] || '';
  const a = Buffer.from(String(given)), b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function getCandles(ex, pair, bar, limit) {
  const key = `${ex}|${pair}|${bar}|${limit}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_MS) return hit.p;
  const p = fetchCandles(ex, pair, bar, limit).then(cs => cs.filter(c => c.confirmed));
  cache.set(key, { ts: Date.now(), p });
  p.catch(() => cache.delete(key)); // jangan cache error
  return p;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return send(res, 200, fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8'), 'text/html; charset=utf-8');
    }
    if (url.pathname.startsWith('/vendor/')) {
      const name = path.basename(url.pathname);
      if (VENDOR[name]) {
        res.writeHead(200, { 'Content-Type': VENDOR[name], 'Cache-Control': 'public, max-age=86400' });
        return res.end(fs.readFileSync(path.join(__dirname, 'public', 'vendor', name)));
      }
    }
    if (url.pathname.startsWith('/api/')) {
      if (!authorized(url, req)) return send(res, 401, { error: 'token salah atau belum diisi (?token=...)' });

      if (url.pathname === '/api/candles') {
        const ex = (url.searchParams.get('ex') || 'okx').toLowerCase();
        const pair = url.searchParams.get('pair') || 'BTC-USDT';
        const bar = url.searchParams.get('bar') || '1H';
        const limit = Math.min(1000, Math.max(100, +(url.searchParams.get('limit') || 600)));
        if (!EXS.has(ex)) return send(res, 400, { error: 'ex harus okx atau bitget' });
        if (!BARS.has(bar)) return send(res, 400, { error: 'bar harus salah satu: ' + [...BARS].join(', ') });
        if (!/^[A-Za-z0-9\-/_]{3,20}$/.test(pair)) return send(res, 400, { error: 'format pair tidak valid' });
        const candles = await getCandles(ex, pair, bar, limit);
        return send(res, 200, { ex, pair, bar, serverTime: Date.now(), candles });
      }

      if (url.pathname === '/api/positions') {
        let st = {};
        try { st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { /* belum ada state */ }
        const positions = Object.entries(st.positions || {}).filter(([, v]) => v).map(([pair, v]) => ({ pair, ...v }));
        return send(res, 200, { positions, closed: (st.closed || []).slice(-20).reverse(), lastBar: st.lastBar || {} });
      }

      if (url.pathname === '/api/scan' && req.method === 'GET') {
        let scan = { results: [] };
        try { scan = JSON.parse(fs.readFileSync(SCAN_FILE, 'utf8')); } catch { /* belum ada hasil scan */ }
        return send(res, 200, scan);
      }
      if (url.pathname === '/api/scan/run' && req.method === 'POST') {
        if (Date.now() - lastManualScan < 30000) return send(res, 429, { error: 'tunggu 30 detik antar scan manual' });
        lastManualScan = Date.now();
        return send(res, 200, await scanner.runScan({ summary: false }));
      }
    }
    send(res, 404, { error: 'tidak ditemukan' });
  } catch (e) {
    send(res, 502, { error: e.message });
  }
}).listen(PORT, () => console.log(`SATS dashboard di http://localhost:${PORT}${TOKEN ? '/?token=...' : ''}`));
