'use strict';
// Paper-trading bot (spot, long-only) berbasis SATS. Eksekusi order sungguhan BELUM diimplementasikan.
// Env: EXCHANGE=okx|bitget PAIRS=BTC-USDT,ETH-USDT BAR=1H RISK_USD=5 MAX_NOTIONAL=100 MIN_TQI=0 PRESET="Crypto 24/7"
//      TP_MODE=fixed|dynamic STATE_FILE=./state.json TELEGRAM_TOKEN= TELEGRAM_CHAT_ID=
const fs = require('fs');
const { runSATS } = require('./sats');
const { openTrade, stepTrade, closeAtPrice } = require('./trade');
const { fetchCandles, barMinutes } = require('./data');

const env = process.env;
const PAIRS = (env.PAIRS || 'BTC-USDT,ETH-USDT,SOL-USDT').split(',').map(s => s.trim());
const EXCHANGE = (env.EXCHANGE || 'okx').toLowerCase();
const BAR = env.BAR || '1H';
const MODE = env.MODE || 'paper';
const RISK_USD = +(env.RISK_USD || 5);
const MAX_NOTIONAL = +(env.MAX_NOTIONAL || 100);
const MIN_TQI = +(env.MIN_TQI || 0);
const MAX_AGE = +(env.MAX_AGE || 100);
const STATE_FILE = env.STATE_FILE || './state.json';
const BAR_MS = barMinutes(BAR) * 60000;
const CFG = { tfMinutes: barMinutes(BAR), preset: env.PRESET || 'Crypto 24/7', tpMode: env.TP_MODE || 'fixed' };

if (MODE !== 'paper') { console.error('Hanya MODE=paper yang tersedia. Eksekusi live belum dibuat.'); process.exit(1); }

let state = { lastBar: {}, positions: {}, closed: [] };
try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch { /* mulai baru */ }
const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

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

async function processPair(pair) {
  const last = state.lastBar[pair] || 0;
  if (last && Date.now() < last + 2 * BAR_MS + 3000) return; // belum ada bar baru yang close

  const candles = (await fetchCandles(EXCHANGE, pair, BAR, 500)).filter(c => c.confirmed);
  const { bars } = runSATS(candles, CFG);
  const lastIdx = candles.length - 1;

  for (let i = 0; i <= lastIdx; i++) {
    const bar = candles[i], b = bars[i];
    if (bar.t <= last) continue;

    let p = state.positions[pair];
    if (p) {
      const age = Math.round((bar.t - p.entryT) / BAR_MS);
      let res = stepTrade(p, bar, age, MAX_AGE);
      if (!res && b.flipDown) res = closeAtPrice(p, bar.close, 'REVERSAL'); // spot: SELL = keluar
      if (res) {
        const pnl = res.R * p.risk * p.qty;
        state.closed.push({ pair, reason: res.reason, R: res.R, pnl, entryT: p.entryT, exitT: bar.t });
        state.positions[pair] = null;
        await notify(`[PAPER] CLOSE ${pair} ${res.reason} @ ${res.exit} | ${res.R.toFixed(2)}R | ${pnl.toFixed(2)} USD`);
        p = null;
      }
    }
    // hanya entry di bar terbaru (hindari sinyal basi setelah restart)
    if (!p && i === lastIdx && b.signal && b.signal.side === 'buy' && b.tqi >= MIN_TQI) {
      const s = b.signal;
      const qty = Math.min(RISK_USD / s.risk, MAX_NOTIONAL / s.entry);
      state.positions[pair] = openTrade(s, bar.t, { qty });
      await notify(`[PAPER] BUY ${pair} @ ${s.entry} | SL ${s.sl.toFixed(4)} | TP1 ${s.tp[0].toFixed(4)} (${s.tpR[0].toFixed(1)}R) | TP2 ${s.tp[1].toFixed(4)} (${s.tpR[1].toFixed(1)}R) | qty ${qty.toPrecision(4)} | TQI ${b.tqi.toFixed(2)}`);
    }
  }
  state.lastBar[pair] = candles[lastIdx].t;
}

let running = false;
async function tick() {
  if (running) return;
  running = true;
  for (const pair of PAIRS) {
    try { await processPair(pair); } catch (e) { console.error(pair, e.message); }
  }
  save();
  running = false;
}

console.log(`SATS paper bot | ${EXCHANGE} | ${PAIRS.join(',')} | ${BAR} | risk ${RISK_USD} USD | max ${MAX_NOTIONAL} USD`);
tick();
setInterval(tick, 30000);
