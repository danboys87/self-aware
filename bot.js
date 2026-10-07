'use strict';
// Paper-trading bot (spot, long-only). Eksekusi order sungguhan BELUM diimplementasikan.
// Bot TIDAK punya logika sinyal sendiri: ia mengeksekusi hasil scanner, jadi yang di tabel = yang diperdagangkan.
//   - Koin, exchange (+fallback), bar, preset, ambang filter (4H/1D, TQI, SnR) : semuanya dari scanner (coins.json, SCAN_*, TQI_*, ...)
//   - Candle: yang sama dengan scanner & dashboard (600 candle, hanya yang sudah close)
//   - Entry : koin berstatus ENTRY_CODES (default strong,valid) setelah tiap scan selesai (jam penuh +10 dtk, atau scan manual)
//   - SL/TP1/TP2 : level sinyal yang sama dengan tabel/chart; harga isi = close bar terakhir
//   - Exit  : TP1 (50%) lalu SL naik ke entry (BE), TP2 (50%), SL, flip turun (REVERSAL), atau TIMEOUT MAX_AGE bar
// Env: RISK_USD=5 MAX_NOTIONAL=100 MAX_AGE=100 ENTRY_CODES=strong,valid STATE_FILE=./state.json TELEGRAM_TOKEN= TELEGRAM_CHAT_ID=
const fs = require('fs');
const { runSATS } = require('./sats');
const { openTrade, stepTrade, closeAtPrice, W } = require('./trade');
const { fetchCandles, barMinutes } = require('./data');
const scanner = require('./scanner');

const env = process.env;
const MODE = env.MODE || 'paper';
const RISK_USD = +(env.RISK_USD || 5);
const MAX_NOTIONAL = +(env.MAX_NOTIONAL || 100);
const MAX_AGE = +(env.MAX_AGE || 100);
const ENTRY_CODES = (env.ENTRY_CODES || 'strong,valid').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const STATE_FILE = env.STATE_FILE || './state.json';

if (MODE !== 'paper') { console.error('Hanya MODE=paper yang tersedia. Eksekusi live belum dibuat.'); process.exit(1); }

let state = { lastBar: {}, positions: {}, closed: [], flips: {} };
try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch { /* mulai baru */ }
const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
const px = v => (v >= 100 ? v.toFixed(2) : v >= 1 ? v.toFixed(4) : v.toFixed(6));

async function notify(msg) {
  console.log(new Date().toISOString(), msg);
  if (env.TELEGRAM_TOKEN && env.TELEGRAM_CHAT_ID) {
    try {
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: msg }),
      });
    } catch (e) { console.error('telegram:', e.message); }
  }
}

// Kelola posisi terbuka: proses semua bar yang sudah close sejak terakhir diperiksa.
async function manage(pair, scan) {
  const p = state.positions[pair];
  const ex = p.exchange || scan.exchange, bar = p.bar || scan.bar, preset = p.preset || scan.preset;
  const tfMin = barMinutes(bar), barMs = tfMin * 60000;
  const candles = (await fetchCandles(ex, pair, bar, 600)).filter(c => c.confirmed);
  if (!candles.length) return;
  const { bars } = runSATS(candles, { tfMinutes: tfMin, preset });
  const since = p.lastT ?? state.lastBar[pair] ?? p.entryT;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (c.t <= since) continue;
    const age = Math.round((c.t - p.entryT) / barMs);
    const hit0 = p.hit[0];
    let res = stepTrade(p, c, age, MAX_AGE);
    if (!res && !hit0 && p.hit[0]) await notify(`[PAPER] TP1 ${pair} tercapai @ ${px(p.tp[0])} | 50% ditutup (+${(W * p.tpR[0]).toFixed(2)}R) | SL dipindah ke entry ${px(p.entry)}`);
    if (!res && bars[i].flipDown) res = closeAtPrice(p, c.close, 'REVERSAL'); // spot: SELL = keluar
    p.lastT = c.t;
    if (res) {
      const pnl = res.R * p.risk * p.qty;
      state.closed.push({ pair, reason: res.reason, R: res.R, pnl, entryT: p.entryT, exitT: c.t });
      state.positions[pair] = null;
      await notify(`[PAPER] CLOSE ${pair} ${res.reason} @ ${px(res.exit)} | ${res.R.toFixed(2)}R | ${pnl.toFixed(2)} USD`);
      break;
    }
  }
  state.lastBar[pair] = candles[candles.length - 1].t;
}

// Entry dari hasil scanner. SL/TP = level sinyal (sama dengan tabel/chart); harga isi = close bar terakhir.
// Jika sinyal sudah berumur >0 bar, R dihitung ulang dari harga isi yang sebenarnya.
async function enter(r, scan) {
  const L = r.levels, fill = r.price, risk = fill - L.sl, age = r.tf[scan.lad[0]].age;
  state.flips[r.pair] = r.flipT; // satu flip = satu kesempatan entry
  if (!(risk > 0) || fill >= L.tp1) {
    console.log(new Date().toISOString(), `[PAPER] SKIP ${r.pair}: harga ${px(fill)} ${risk > 0 ? 'sudah di atas TP1 ' + px(L.tp1) : 'tidak di atas SL ' + px(L.sl)} (sinyal ${age} bar lalu)`);
    return;
  }
  const tpR = [(L.tp1 - fill) / risk, (L.tp2 - fill) / risk];
  const sig = { side: 'buy', entry: fill, sl: L.sl, risk, tp: [L.tp1, L.tp2], tpR };
  const qty = Math.min(RISK_USD / risk, MAX_NOTIONAL / fill);
  state.positions[r.pair] = openTrade(sig, r.barT, { qty, exchange: r.exchange, bar: scan.bar, preset: scan.preset, lastT: r.barT, code: r.code });
  await notify(`[PAPER] BUY ${r.pair} (${r.exchange.toUpperCase()}) @ ${px(fill)} | SL ${px(L.sl)} | TP1 ${px(L.tp1)} (${tpR[0].toFixed(1)}R) | TP2 ${px(L.tp2)} (${tpR[1].toFixed(1)}R) | qty ${qty.toPrecision(4)} | ${r.code.toUpperCase()} TQI ${r.tf[scan.lad[0]].tqi.toFixed(2)} | flip ${age} bar lalu`);
}

async function handleScan(scan) {
  for (const pair of Object.keys(state.positions)) {
    if (!state.positions[pair]) continue;
    try { await manage(pair, scan); } catch (e) { console.error('kelola', pair, e.message); }
  }
  for (const r of scan.results || []) {
    if (!r.ok || r.side !== 'BUY' || !ENTRY_CODES.includes(r.code) || !r.levels) continue;
    if (state.positions[r.pair] || state.flips[r.pair] === r.flipT) continue;
    await enter(r, scan);
  }
  save();
}

let queue = Promise.resolve(); // proses scan satu per satu, tidak ada yang terlewat
scanner.onScan(scan => { queue = queue.then(() => handleScan(scan)).catch(e => console.error('bot:', e.message)); return queue; });
scanner.start(); // bot bergantung pada scanner; start() aman dipanggil dobel

console.log(`SATS paper bot | mengikuti scanner | entry: ${ENTRY_CODES.join('/')} | risk ${RISK_USD} USD | max ${MAX_NOTIONAL} USD`);

module.exports = { handleScan, getState: () => state };
