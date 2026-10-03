'use strict';
// Scanner konfluensi multi-timeframe (aturan sama dengan kartu "Rekomendasi Eksekusi" di dashboard).
//   node scanner.js            -> scan sekali, tampilkan tabel, tulis scan.json (tanpa notifikasi)
//   node scanner.js --watch    -> scan tiap jam, sesaat setelah bar close
// Daftar koin & exchange: coins.json (atau env COINS="ENA-USDT,SOL-USDT", SCAN_EXCHANGE=okx|bitget).
// "fallback": exchange cadangan; dipakai per koin jika exchange utama gagal (mis. pair tidak ada di spot exchange utama).
// Env lain: SCAN_PRESET=Auto TQI_MID=0.4 TQI_EX=0.4 TQI_STRONG=0.5 FRESH=3 SNR_ATR=1
//           D1_MODE=label|required (default label: 1D hanya label keyakinan, bukan syarat)  SUMMARY_HOUR=14 (-1 = nonaktif) SUMMARY_TZ=Asia/Jakarta SCAN_FILE SCAN_STATE_FILE SCAN_LOG_FILE
// Scanner hanya melaporkan; tidak membuka order. Aturan ini belum divalidasi backtest.
const fs = require('fs');
const { runSATS } = require('./sats');
const { fetchCandles, barMinutes } = require('./data');
const { notify } = require('./notify');

const env = process.env;
const SCAN_FILE = env.SCAN_FILE || './scan.json';
const STATE_FILE = env.SCAN_STATE_FILE || './scan_state.json';
const LOG_FILE = env.SCAN_LOG_FILE || './scan_log.json';
const LAD = { '15m': ['15m', '1H', '4H'], '30m': ['30m', '4H', '1D'], '1H': ['1H', '4H', '1D'], '4H': ['4H', '1D', null] }; // [eksekusi, struktur, mayor]
const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const px = v => (v >= 100 ? v.toFixed(2) : v >= 1 ? v.toFixed(4) : v >= 0.01 ? v.toFixed(5) : v.toPrecision(4));
const dirT = t => (t === 1 ? 'Bullish ▲' : 'Bearish ▼');
const arrow = t => (t === 1 ? '▲' : '▼');

function loadConfig() {
  const file = readJSON(env.COINS_FILE || './coins.json', {});
  const coins = (env.COINS ? env.COINS.split(',') : file.coins || []).map(s => s.trim()).filter(Boolean);
  return {
    exchange: (env.SCAN_EXCHANGE || file.exchange || 'okx').toLowerCase(),
    fallback: (env.SCAN_FALLBACK || file.fallback || '').toLowerCase(),
    bar: env.SCAN_BAR || file.bar || '1H',
    preset: env.SCAN_PRESET || file.preset || 'Auto',
    coins,
    P: { mid: +(env.TQI_MID || 0.4), ex: +(env.TQI_EX || 0.4), strong: +(env.TQI_STRONG || 0.5), fresh: +(env.FRESH || 3), snr: +(env.SNR_ATR || 1.0), d1: (env.D1_MODE || file.d1 || 'label').toLowerCase() },
    summaryHour: env.SUMMARY_HOUR === undefined ? 14 : +env.SUMMARY_HOUR,
    tz: env.SUMMARY_TZ || 'Asia/Jakarta',
  };
}

function tfInfo(cs, tfMinutes, preset) {
  const { bars, warmup } = runSATS(cs, { preset, tfMinutes });
  const n = bars.length, b = bars[n - 1];
  let k = n - 1;
  while (k > 0 && bars[k - 1].trend === b.trend) k--; // k = bar pertama tren sekarang
  const sig = bars[k].signal;
  return {
    b, cs, trend: b.trend, tqi: b.tqi, er: b.er, age: n - 1 - k, ready: n > warmup, flipT: cs[k].t,
    levels: sig && sig.side === (b.trend === 1 ? 'buy' : 'sell') ? sig : null,
  };
}

// SnR (proksi terukur): swing high/low terdekat (pivot 5 bar kiri-kanan, 120 bar terakhir), jarak dalam ATR.
function snrOf(I, p0) { // p0 = harga terkini (close bar eksekusi terakhir), bukan close harian kemarin
  const cs = I.cs, n = cs.length, L = 5, from = Math.max(L, n - 120);
  let res = Infinity, sup = -Infinity;
  for (let i = from; i < n - L; i++) {
    let ph = true, pl = true;
    for (let k = 1; k <= L; k++) {
      if (!(cs[i].high > cs[i - k].high && cs[i].high > cs[i + k].high)) ph = false;
      if (!(cs[i].low < cs[i - k].low && cs[i].low < cs[i + k].low)) pl = false;
    }
    if (ph && cs[i].high > p0) res = Math.min(res, cs[i].high);
    if (pl && cs[i].low < p0) sup = Math.max(sup, cs[i].low);
  }
  const a = I.b.ra, hr = isFinite(res), hs = isFinite(sup);
  return { res: hr ? res : null, sup: hs ? sup : null, dRes: hr && a > 0 ? (res - p0) / a : null, dSup: hs && a > 0 ? (p0 - sup) / a : null };
}

// Aturan keputusan: identik dengan renderMTF() di public/index.html
function decide(I, lad, sn, P) {
  const [e, m, j] = I, dir = e.trend, side = dir === 1 ? 'BUY' : 'SELL', mi = lad[1];
  const sig = e.age <= P.fresh;
  const near = dir === 1 ? (sn.dRes !== null && sn.dRes <= P.snr) : (sn.dSup !== null && sn.dSup <= P.snr);
  const aligned = m.trend === dir, majOk = j ? j.trend === dir : true;
  let code, title;
  if (!sig) { code = 'wait'; title = 'WAIT / BELUM ADA SINYAL BARU'; }
  else if (!aligned) { code = 'rejected'; title = 'DITOLAK: MELAWAN TREN ' + mi.toUpperCase(); }
  else if (m.tqi < P.mid || e.tqi < P.ex) { code = 'weak'; title = 'KUALITAS LEMAH (TQI RENDAH)'; }
  else if (near) { code = 'near'; title = `HATI-HATI: DEKAT ${dir === 1 ? 'RESISTANCE' : 'SUPPORT'}`; }
  else if ((P.d1 === 'required' ? majOk : true) && e.tqi >= P.strong) { code = 'strong'; title = `KONFLUENSI KUAT ${side} ${arrow(dir)}`; }
  else { code = 'valid'; title = `VALID ${side} (RISIKO SEDANG)`; }
  return { code, title, side, dir, sig, d1: j ? (majOk ? 'searah' : 'berlawanan') : null };
}

async function analyzeCoin(ex, pair, cfg) {
  const lad = LAD[cfg.bar];
  if (!lad) throw new Error('bar scan tidak didukung: ' + cfg.bar);
  const labels = lad.filter(Boolean), data = {};
  for (const b of labels) {
    data[b] = (await fetchCandles(ex, pair, b, 600)).filter(c => c.confirmed);
    if (data[b].length < 80) throw new Error(`candle ${b} terlalu sedikit (${data[b].length})`);
    await sleep(120);
  }
  const I = lad.map(b => (b ? tfInfo(data[b], barMinutes(b), cfg.preset) : null));
  if (I.some(x => x && !x.ready)) throw new Error('data belum cukup untuk warmup indikator');
  const sn = snrOf(I[2] || I[1], I[0].cs[I[0].cs.length - 1].close);
  const d = decide(I, lad, sn, cfg.P);
  const e = I[0];
  return {
    pair, ok: true, exchange: ex, d1: d.d1, code: d.code, title: d.title, side: d.side, price: e.cs[e.cs.length - 1].close, snrTf: lad[2] || lad[1],
    tf: Object.fromEntries(lad.map((b, i) => b && [b, { trend: I[i].trend, tqi: I[i].tqi, er: I[i].er, age: I[i].age }]).filter(Boolean)),
    snr: sn, flipT: e.flipT,
    levels: d.side === 'BUY' && e.levels ? { entry: e.levels.entry, sl: e.levels.sl, tp1: e.levels.tp[0], tp2: e.levels.tp[1], r1: e.levels.tpR[0], r2: e.levels.tpR[1] } : null,
  };
}

// Coba exchange utama; jika gagal dan ada fallback, coba exchange cadangan. Error hanya jika keduanya gagal.
async function analyzeWithFallback(pair, cfg) {
  try { return await analyzeCoin(cfg.exchange, pair, cfg); }
  catch (e) {
    if (!cfg.fallback || cfg.fallback === cfg.exchange) throw e;
    try { return await analyzeCoin(cfg.fallback, pair, cfg); }
    catch (e2) { throw new Error(`${cfg.exchange}: ${e.message} | ${cfg.fallback}: ${e2.message}`); }
  }
}

const signalMsg = (r, cfg) => {
  const lad = LAD[cfg.bar], L = r.levels, t = r.tf;
  return [
    `🟢 KONFLUENSI KUAT BUY — ${r.pair} (${cfg.bar}, ${r.exchange.toUpperCase()})`,
    `Flip ${lad[0]}: ${t[lad[0]].age} bar lalu | harga kini ${px(r.price)}`,
    L ? `Entry (close flip) ${px(L.entry)} | SL ${px(L.sl)} | TP1 ${px(L.tp1)} (${L.r1.toFixed(1)}R) | TP2 ${px(L.tp2)} (${L.r2.toFixed(1)}R)` : 'Level entry/SL/TP tidak tersedia (flip sebelum warmup)',
    ...(r.d1 ? [`1D: ${r.d1 === 'searah' ? 'searah (keyakinan lebih tinggi)' : 'BERLAWANAN (counter-trend harian: pertimbangkan posisi lebih kecil)'}`] : []),
    `Tren: ${lad.filter(Boolean).map(b => `${b} ${arrow(t[b].trend)}`).join(' · ')} | TQI ${lad[0]} ${t[lad[0]].tqi.toFixed(2)}, ${lad[1]} ${t[lad[1]].tqi.toFixed(2)}`,
    `SnR ${r.snrTf}: resistance ${r.snr.res ? `${px(r.snr.res)} (${r.snr.dRes.toFixed(1)}×ATR)` : '-'} · support ${r.snr.sup ? `${px(r.snr.sup)} (${r.snr.dSup.toFixed(1)}×ATR)` : '-'}`,
    'Aturan belum divalidasi backtest. Bukan saran keuangan.',
  ].join('\n');
};

function localParts(tz) {
  const now = new Date();
  const hour = +new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: tz }).format(now);
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
  return { hour, date };
}

let running = null;
function runScan(opts = {}) {
  if (running) return running;
  running = doScan(opts).finally(() => { running = null; });
  return running;
}

async function doScan({ notify: doNotify = true, summary = true } = {}) {
  const cfg = loadConfig();
  const results = [];
  for (const pair of cfg.coins) {
    try { results.push(await analyzeWithFallback(pair, cfg)); }
    catch (e) { results.push({ pair, ok: false, error: e.message }); }
    await sleep(150);
  }
  const scan = { updated: Date.now(), exchange: cfg.exchange, fallback: cfg.fallback, bar: cfg.bar, preset: cfg.preset, lad: LAD[cfg.bar], thresholds: cfg.P, results };
  fs.writeFileSync(SCAN_FILE, JSON.stringify(scan, null, 2));

  if (doNotify) {
    const st = readJSON(STATE_FILE, { notified: {}, lastSummary: '' });
    const weekAgo = Date.now() - 7 * 86400000;
    for (const k of Object.keys(st.notified)) if (st.notified[k] < weekAgo) delete st.notified[k];
    const log = readJSON(LOG_FILE, []);
    for (const r of results) {
      if (!r.ok || r.side !== 'BUY' || (r.code !== 'strong' && r.code !== 'valid')) continue;
      const key = `${r.exchange}|${r.pair}|${cfg.bar}|${r.flipT}`;
      if (st.notified[key]) continue; // dedupe: satu notifikasi per flip
      st.notified[key] = Date.now();
      log.push({ t: scan.updated, key, pair: r.pair, exchange: r.exchange, code: r.code, price: r.price, levels: r.levels, tqi: r.tf[LAD[cfg.bar][0]].tqi });
      if (r.code === 'strong') await notify(signalMsg(r, cfg));
    }
    if (summary && cfg.summaryHour >= 0) {
      const { hour, date } = localParts(cfg.tz);
      if (hour === cfg.summaryHour && st.lastSummary !== date) {
        st.lastSummary = date;
        const lines = results.map(r => (r.ok ? `${r.pair}${r.exchange !== cfg.exchange ? ` [${r.exchange.toUpperCase()}]` : ''}: ${r.title} | ${LAD[cfg.bar].filter(Boolean).map(b => `${b}${arrow(r.tf[b].trend)}`).join(' ')} TQI ${r.tf[LAD[cfg.bar][0]].tqi.toFixed(2)}${r.d1 ? ` 1D${r.d1 === 'searah' ? '✓' : '✗'}` : ''}` : `${r.pair}: ERROR ${r.error}`));
        await notify(`📋 Ringkasan scan ${cfg.summaryHour}:00 (${cfg.bar}, ${cfg.exchange.toUpperCase()}, preset ${cfg.preset})\n${lines.join('\n')}`);
      }
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2));
    fs.writeFileSync(LOG_FILE, JSON.stringify(log.slice(-1000), null, 2));
  }
  return scan;
}

// Jalankan tepat sesaat setelah jam penuh (bar 1H baru close). delay memberi waktu exchange memfinalkan candle.
const msToNextHour = (now = Date.now(), delay = 10000) => (Math.floor(now / 3600000) + 1) * 3600000 + delay - now;
function start() {
  const tick = () => runScan().catch(e => console.error('scan:', e.message)).finally(() => setTimeout(tick, msToNextHour()));
  const cfg = loadConfig();
  console.log(`Scanner aktif: ${cfg.coins.join(', ') || '(belum ada koin)'} | ${cfg.exchange}${cfg.fallback ? '+' + cfg.fallback : ''} | ${cfg.bar} | preset ${cfg.preset} | scan berikutnya tiap jam penuh`);
  tick();
}

module.exports = { analyzeCoin, runScan, start, loadConfig, msToNextHour, decide, tfInfo, snrOf, LAD };

if (require.main === module) {
  if (process.argv.includes('--watch')) start();
  else runScan({ notify: false }).then(scan => {
    const lad = scan.lad.filter(Boolean);
    console.log(`Scan ${new Date(scan.updated).toISOString()} | ${scan.exchange}${scan.fallback ? ' (cadangan: ' + scan.fallback + ', ditandai *)' : ''} | ${scan.bar} | preset ${scan.preset}`);
    for (const r of scan.results) {
      console.log(r.ok
        ? `${(r.pair + (r.exchange !== scan.exchange ? '*' : '')).padEnd(14)} ${r.title.padEnd(34)} ${lad.map(b => `${b}${arrow(r.tf[b].trend)}${r.tf[b].age}b`).join(' ')} | TQI ${r.tf[lad[0]].tqi.toFixed(2)} | ${px(r.price)}`
        : `${r.pair.padEnd(14)} ERROR ${r.error}`);
    }
  }).catch(e => { console.error(e.message); process.exit(1); });
}
