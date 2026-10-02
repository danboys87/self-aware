'use strict';
// Pakai: node backtest.js [PAIR] [BAR] [JUMLAH_BAR] [--preset=Crypto 24/7] [--tp=fixed|dynamic]
//        [--tqi=0.4] [--fee=0.001] [--source=close] [--ex=okx|bitget] [--csv=file.csv] [--debug=5]
// Spot long-only: BUY = masuk, SELL (flip down) = keluar sisa posisi di close.
const { runSATS } = require('./sats');
const { openTrade, stepTrade, closeAtPrice } = require('./trade');
const { fetchCandles, loadCSV, barMinutes } = require('./data');

const argv = process.argv.slice(2);
const args = Object.fromEntries(argv.filter(a => a.startsWith('--')).map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=') || 'true']; }));
const pos = argv.filter(a => !a.startsWith('--'));

function stats(trades) {
  const n = trades.length;
  if (!n) return null;
  const wins = trades.filter(x => x.R > 0);
  const gw = wins.reduce((s, x) => s + x.R, 0);
  const gl = -trades.filter(x => x.R <= 0).reduce((s, x) => s + x.R, 0);
  let cum = 0, peak = 0, dd = 0;
  for (const x of trades) { cum += x.R; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak); }
  const byReason = {};
  for (const x of trades) byReason[x.reason] = (byReason[x.reason] || 0) + 1;
  return { n, winRate: wins.length / n, avgR: cum / n, totalR: cum, pf: gl > 0 ? gw / gl : Infinity, maxDD: dd, byReason };
}

async function main() {
  const pair = pos[0] || 'BTC-USDT', bar = pos[1] || '1H', total = +(pos[2] || 1000);
  const fee = +(args.fee ?? 0.001), minTqi = +(args.tqi ?? 0);
  const candles = args.csv ? loadCSV(args.csv) : (await fetchCandles(args.ex || 'okx', pair, bar, total)).filter(c => c.confirmed);
  const cfg = { tfMinutes: barMinutes(bar), preset: args.preset || 'Crypto 24/7', tpMode: args.tp || 'fixed', source: args.source || 'close' };
  const { bars, warmup, params } = runSATS(candles, cfg);

  const trades = [];
  let tr = null, entryIdx = -1;
  const close = (res, i) => {
    const costR = (2 * fee * tr.entry) / tr.risk; // fee taker dua sisi
    trades.push({ ...res, R: res.R - costR, entryT: tr.entryT, exitT: candles[i].t, entry: tr.entry });
    tr = null;
  };
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (tr) {
      let res = stepTrade(tr, candles[i], i - entryIdx, 100);
      if (!res && b.flipDown) res = closeAtPrice(tr, candles[i].close, 'REVERSAL');
      if (res) close(res, i);
    }
    if (!tr && b.signal && b.signal.side === 'buy' && b.tqi >= minTqi) {
      tr = openTrade(b.signal, candles[i].t);
      entryIdx = i;
    }
  }

  const s = stats(trades);
  const d0 = new Date(candles[0].t).toISOString().slice(0, 10), d1 = new Date(candles[candles.length - 1].t).toISOString().slice(0, 10);
  console.log(`${args.csv || pair} ${bar} | ${candles.length} bar (${d0} -> ${d1}) | preset ${params.resolvedPreset} | TP ${params.tpMode} ${params.tp1R}R/${params.tp2R}R | fee ${fee * 100}%/sisi | min TQI ${minTqi}`);
  console.log(`warmup ${warmup} bar | sinyal buy: ${bars.filter(b => b.signal && b.signal.side === 'buy').length}`);
  if (!s) console.log('Belum ada trade.');
  else {
    console.log(`Trades ${s.n} | winrate ${(s.winRate * 100).toFixed(1)}% | avg ${s.avgR.toFixed(2)}R | total ${s.totalR.toFixed(2)}R | PF ${s.pf.toFixed(2)} | maxDD ${s.maxDD.toFixed(2)}R`);
    console.log('Exit:', JSON.stringify(s.byReason));
  }
  const dbg = +(args.debug || 0);
  if (dbg) {
    console.log('\nDebug (bandingkan dengan chart TradingView):');
    for (const b of bars.slice(-dbg)) {
      console.log(new Date(b.t).toISOString(), 'close', candles[b.i].close, 'stLine', b.stLine.toFixed(4), 'trend', b.trend, 'tqi', b.tqi.toFixed(3), 'er', b.er.toFixed(3));
    }
  }
}
main().catch(e => { console.error(e.message); process.exit(1); });
