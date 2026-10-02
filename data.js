'use strict';
const fs = require('fs');

function barMinutes(bar) { // format OKX: 15m, 1H, 4H, 1D
  const m = /^(\d+)([mHDW])$/.exec(bar);
  if (!m) throw new Error('bar tidak dikenal: ' + bar);
  return +m[1] * { m: 1, H: 60, D: 1440, W: 10080 }[m[2]];
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Candle publik OKX (tanpa API key). 'candles' = ~1440 bar terakhir; >1400 otomatis pakai 'history-candles'.
async function fetchCandlesOKX(instId, bar = '1H', total = 600) {
  const deep = total > 1400;
  const path = deep ? 'history-candles' : 'candles';
  const limit = deep ? 100 : 300;
  const out = [];
  let after = '';
  while (out.length < total) {
    const url = `https://www.okx.com/api/v5/market/${path}?instId=${instId}&bar=${bar}&limit=${limit}${after ? `&after=${after}` : ''}`;
    const res = await fetch(url);
    const j = await res.json();
    if (j.code !== '0') throw new Error(`OKX ${j.code}: ${j.msg}`);
    const rows = j.data;
    if (!rows.length) break;
    for (const k of rows) {
      out.push({ t: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5], confirmed: k[8] === '1' });
    }
    after = rows[rows.length - 1][0]; // baris terakhir = paling lama
    if (rows.length < limit) break;
    await sleep(150);
  }
  out.sort((a, b) => a.t - b.t);
  return out.slice(-total);
}


// Bitget spot v2 (publik, tanpa API key). Baris: [ts, open, high, low, close, baseVol, quoteVol, usdtVol]
// Bitget tidak mengirim flag "confirm", jadi candle dianggap close jika t + durasi bar <= sekarang.
function toBitgetGran(bar) {
  const m = /^(\d+)([mHDW])$/.exec(bar);
  if (!m) throw new Error('bar tidak dikenal: ' + bar);
  return m[1] + { m: 'min', H: 'h', D: 'day', W: 'week' }[m[2]]; // 15m->15min, 1H->1h, 1D->1day
}

async function fetchCandlesBitget(symbol, bar = '1H', total = 600) {
  const gran = toBitgetGran(bar), ms = barMinutes(bar) * 60000;
  const out = [];
  let end = '';
  while (out.length < total) {
    const lim = Math.min(1000, total - out.length);
    const path = end ? 'history-candles' : 'candles'; // history-candles wajib endTime
    const url = `https://api.bitget.com/api/v2/spot/market/${path}?symbol=${symbol}&granularity=${gran}&limit=${lim}${end ? `&endTime=${end}` : ''}`;
    const res = await fetch(url);
    const j = await res.json();
    if (j.code !== '00000') throw new Error(`Bitget ${j.code}: ${j.msg}`);
    const rows = j.data || [];
    if (!rows.length) break;
    for (const k of rows) {
      out.push({ t: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5], confirmed: +k[0] + ms <= Date.now() });
    }
    end = String(Math.min(...rows.map(k => +k[0])));
    if (rows.length < lim) break;
    await sleep(100);
  }
  const seen = new Set();
  return out.filter(c => !seen.has(c.t) && seen.add(c.t)).sort((a, b) => a.t - b.t).slice(-total);
}

// Format pair: "BTC-USDT" / "BTCUSDT" / "btc/usdt" -> format masing-masing exchange.
function normPair(ex, pair) {
  const raw = pair.toUpperCase().replace(/[-/_]/g, '');
  if (ex === 'bitget') return raw;
  const q = /(USDT|USDC|USD)$/.exec(raw);
  return q ? `${raw.slice(0, -q[1].length)}-${q[1]}` : raw;
}

async function fetchCandles(ex, pair, bar = '1H', total = 600) {
  if (ex === 'bitget') return fetchCandlesBitget(normPair('bitget', pair), bar, total);
  if (ex === 'okx') return fetchCandlesOKX(normPair('okx', pair), bar, total);
  throw new Error('exchange tidak dikenal: ' + ex);
}

// CSV (mis. export chart TradingView): kolom time,open,high,low,close,volume
function loadCSV(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  const head = lines[0].split(',').map(s => s.trim().toLowerCase());
  const ix = k => head.indexOf(k);
  const [it, io, ih, il, ic, iv] = ['time', 'open', 'high', 'low', 'close', 'volume'].map(ix);
  return lines.slice(1).map(l => {
    const f = l.split(',');
    const raw = f[it].trim();
    const t = /^\d+$/.test(raw) ? (raw.length <= 10 ? +raw * 1000 : +raw) : Date.parse(raw);
    return { t, open: +f[io], high: +f[ih], low: +f[il], close: +f[ic], volume: iv >= 0 ? +f[iv] : 0, confirmed: true };
  });
}

module.exports = { fetchCandles, fetchCandlesOKX, fetchCandlesBitget, normPair, loadCSV, barMinutes };
