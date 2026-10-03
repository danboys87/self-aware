'use strict';
// Backtest multi-koin untuk membandingkan pemicu entry (spot, long-only, R-multiple setelah fee):
//   base = 1H flip tanpa filter timeframe lain (pembanding)
//   A    = 1H flip baru saat 4H sudah bullish                (aturan scanner sekarang)
//   B    = 4H baru flip bullish (<= k4 bar 4H) saat 1H bullish (awal tren; SL dari engine 4H, R dihitung dari harga masuk)
//   AB   = A atau B (jika keduanya menyala di bar yang sama: level A, ditandai A+B)
// 1D = LABEL: setiap trade ditandai "1D searah"/"1D berlawanan" dan dilaporkan per label.
// Pembanding: varian "+ 1D wajib" (1D bullish menjadi syarat entry).
// Aturan filter: --rule=none (hanya struktur), strong (TQI 4H >= 0.40, TQI 1H >= 0.50, SnR 1.0xATR 1D), both (default).
//
//   node backtest_mtf.js [--ex=okx] [--fallback=bitget] [--coins=ENA-USDT,LINK-USDT] [--bars=8000]
//        [--rule=both] [--fee=0.001] [--k4=2] [--maxrun=0.5] [--exit=own|1h] [--preset=Auto]
//        [--tqi-mid=0.4] [--tqi-ex=0.5] [--snr=1.0] [--per-coin] [--refresh]
// Data diambil dari exchange lalu disimpan di ./cache (pakai --refresh untuk mengunduh ulang).
// Tidak ada look-ahead: bar 4H/1D dipakai hanya jika sudah close pada saat close bar 1H yang dievaluasi.
const fs = require('fs');
const { runSATS } = require('./sats');
const { openTrade, stepTrade, closeAtPrice } = require('./trade');
const { fetchCandles } = require('./data');

const H = 3600000, H4 = 4 * H, HD = 24 * H;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- data ----------
async function getSeries(ex, pair, bar, total, refresh) {
  const f = `./cache/${ex}_${pair.replace(/[^A-Za-z0-9]/g, '')}_${bar}_${total}.json`;
  if (!refresh && fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  const cs = (await fetchCandles(ex, pair, bar, total)).filter(c => c.confirmed);
  fs.mkdirSync('./cache', { recursive: true });
  fs.writeFileSync(f, JSON.stringify(cs));
  return cs;
}

async function loadCoin(pair, a) {
  const order = [a.ex];
  if (a.fallback && a.fallback !== a.ex) order.push(a.fallback);
  const errs = [];
  for (const ex of order) {
    try {
      const c1 = await getSeries(ex, pair, '1H', a.bars, a.refresh);
      const c4 = await getSeries(ex, pair, '4H', Math.ceil(a.bars / 4) + 150, a.refresh);
      const cd = await getSeries(ex, pair, '1D', Math.ceil(a.bars / 24) + 120, a.refresh);
      if (c1.length < 600 || c4.length < 200 || cd.length < 120) throw new Error(`data terlalu sedikit (1H ${c1.length}, 4H ${c4.length}, 1D ${cd.length})`);
      return { ex, c1, c4, cd };
    } catch (e) { errs.push(`${ex}: ${e.message}`); await sleep(200); }
  }
  throw new Error(errs.join(' | '));
}

// Engine dijalankan sekali per timeframe (engine bersifat kausal: nilai bar j hanya bergantung pada bar <= j).
function prep(raw, preset = 'Auto') {
  const r1 = runSATS(raw.c1, { preset, tfMinutes: 60 });
  const r4 = runSATS(raw.c4, { preset, tfMinutes: 240 });
  const rd = runSATS(raw.cd, { preset, tfMinutes: 1440 });
  const runStart = bars => { const s = new Array(bars.length); for (let j = 0; j < bars.length; j++) s[j] = j > 0 && bars[j].trend === bars[j - 1].trend ? s[j - 1] : j; return s; };
  return { c1: raw.c1, c4: raw.c4, cd: raw.cd, b1: r1.bars, b4: r4.bars, bd: rd.bars, warm1: r1.warmup, warm4: r4.warmup, warmD: rd.warmup, start4: runStart(r4.bars) };
}

// Swing high 1D terdekat di atas harga (pivot 5 bar, 120 bar terakhir) dalam kelipatan ATR 1D; sama dengan scanner.
function snrNear(cd, ra, idx, price, mult) {
  const L = 5, n = idx + 1, from = Math.max(L, n - 120);
  let res = Infinity;
  for (let i = from; i < n - L; i++) {
    let ph = true;
    for (let k = 1; k <= L; k++) if (!(cd[i].high > cd[i - k].high && cd[i].high > cd[i + k].high)) { ph = false; break; }
    if (ph && cd[i].high > price) res = Math.min(res, cd[i].high);
  }
  return isFinite(res) && ra > 0 && (res - price) / ra <= mult;
}

// ---------- simulasi satu koin ----------
// V: base|A|B|AB   R: {mid, ex, snr} (0 = nonaktif)   o: {fee, k4, maxRun, exitMode, d1Req}
function simulate(D, V, R, o) {
  const n = D.c1.length, trades = [], stageMax = new Map(), used = new Set();
  let tr = null, entryIdx = -1, p4 = -1, pd = -1, t0 = null, t1 = null;
  const reach = (key, st) => { if ((stageMax.get(key) || 0) < st) stageMax.set(key, st); };
  const record = (res, i) => {
    const costR = (2 * o.fee * tr.entry) / tr.risk;
    trades.push({ tag: tr.tag, d1: tr.d1, riskPct: tr.riskPct, entryT: tr.entryT, exitT: D.c1[i].t + H, R: res.R - costR, reason: res.reason });
    tr = null;
  };

  for (let i = 0; i < n; i++) {
    const Ti = D.c1[i].t + H, prev4 = p4;
    while (p4 + 1 < D.c4.length && D.c4[p4 + 1].t + H4 <= Ti) p4++;
    while (pd + 1 < D.cd.length && D.cd[pd + 1].t + HD <= Ti) pd++;
    if (!(i >= D.warm1 && p4 + 1 > D.warm4 && pd + 1 > D.warmD)) continue; // semua timeframe siap
    if (t0 === null) t0 = D.c1[i].t;
    t1 = Ti;
    const bar = D.c1[i], b1 = D.b1[i], b4 = D.b4[p4], price = bar.close;

    // 1) kelola posisi terbuka
    if (tr) {
      let res = stepTrade(tr, bar, i - entryIdx, tr.maxAge);
      if (!res) {
        let flip = false;
        if (tr.own === '4h') { for (let k = prev4 + 1; k <= p4; k++) if (D.b4[k].flipDown) flip = true; } else flip = b1.flipDown;
        if (flip) res = closeAtPrice(tr, price, 'REVERSAL');
      }
      if (res) record(res, i);
    }

    // 2) kandidat entry di close bar ini
    const cands = [];
    if (V !== 'B' && b1.signal && b1.signal.side === 'buy') cands.push({ type: V === 'base' ? 'base' : 'A', key: 'A' + i, sig: b1.signal });
    if (V === 'B' || V === 'AB') {
      const st = D.start4[p4], s4 = D.b4[st].signal;
      if (b4.trend === 1 && p4 - st <= o.k4 - 1 && s4 && s4.side === 'buy') cands.push({ type: 'B', key: 'B' + st, s4 });
    }
    const passed = [];
    for (const c of cands) {
      reach(c.key, 1);
      if (c.type !== 'base') {
        const ok2 = c.type === 'A' ? b4.trend === 1 : b1.trend === 1 && price > c.s4.sl && (price - c.s4.entry) / c.s4.risk <= o.maxRun;
        if (!ok2) continue;
        reach(c.key, 2);
        if ((R.mid > 0 && b4.tqi < R.mid) || (R.ex > 0 && b1.tqi < R.ex)) continue;
        reach(c.key, 3);
        if (R.snr > 0 && snrNear(D.cd, D.bd[pd].ra, pd, price, R.snr)) continue;
      }
      reach(c.key, 4);
      if (o.d1Req && D.bd[pd].trend !== 1) continue;
      reach(c.key, 5);
      if (tr || used.has(c.key)) continue;
      reach(c.key, 6);
      passed.push(c);
    }

    // 3) buka posisi
    if (passed.length) {
      const c = passed.find(x => x.type !== 'B') || passed[0];
      let sig = c.sig;
      if (c.type === 'B') {
        const risk = price - c.s4.sl;
        sig = { side: 'buy', entry: price, sl: c.s4.sl, risk, tpR: c.s4.tpR, tp: c.s4.tpR.map(r => price + risk * r) };
      }
      tr = openTrade(sig, bar.t, {
        maxAge: c.type === 'B' ? 400 : 100, own: c.type === 'B' && o.exitMode !== 'fast' && o.exitMode !== '1h' ? '4h' : '1h',
        tag: passed.length > 1 ? 'A+B' : c.type, d1: D.bd[pd].trend === 1 ? 'searah' : 'berlawanan', riskPct: sig.risk / sig.entry,
      });
      entryIdx = i;
      for (const x of passed) { used.add(x.key); reach(x.key, 7); }
    }
  }
  if (tr) record(closeAtPrice(tr, D.c1[n - 1].close, 'END'), n - 1);

  const funnel = { A: Array(7).fill(0), B: Array(7).fill(0) };
  for (const [key, st] of stageMax) for (let k = 0; k < st; k++) funnel[key[0]][k]++;
  return { trades, funnel, t0, t1 };
}

// ---------- statistik ----------
function stats(tr, tSplit) {
  const n = tr.length;
  if (!n) return null;
  const R = tr.map(t => t.R), sum = R.reduce((a, b) => a + b, 0), avg = sum / n;
  const sd = Math.sqrt(R.reduce((a, b) => a + (b - avg) ** 2, 0) / Math.max(1, n - 1));
  const gw = R.filter(r => r > 0).reduce((a, b) => a + b, 0), gl = -R.filter(r => r <= 0).reduce((a, b) => a + b, 0);
  let cum = 0, pk = 0, dd = 0;
  for (const t of [...tr].sort((a, b) => a.exitT - b.exitT)) { cum += t.R; pk = Math.max(pk, cum); dd = Math.min(dd, cum - pk); }
  const half = x => { const s = x.map(t => t.R); return { n: s.length, avg: s.length ? s.reduce((a, b) => a + b, 0) / s.length : NaN }; };
  return {
    n, win: R.filter(r => r > 0).length / n, avg, ci: 1.96 * sd / Math.sqrt(n), sum, pf: gl > 0 ? gw / gl : Infinity, dd,
    risk: tr.reduce((a, t) => a + t.riskPct, 0) / n, h1: half(tr.filter(t => t.entryT < tSplit)), h2: half(tr.filter(t => t.entryT >= tSplit)),
  };
}

const f2 = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '-');
const sg = v => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(2) : '-');
function row(label, s) {
  if (!s) return label.padEnd(38) + '     0';
  return label.padEnd(38) + String(s.n).padStart(5) + String((s.win * 100).toFixed(0) + '%').padStart(6) + (sg(s.avg) + '±' + f2(s.ci)).padStart(13) +
    sg(s.sum).padStart(8) + f2(s.pf).padStart(6) + f2(s.dd).padStart(8) + (f2(s.risk * 100, 1) + '%').padStart(7) +
    (s.h1.n ? sg(s.h1.avg) : '-').padStart(7) + (s.h2.n ? sg(s.h2.avg) : '-').padStart(7);
}

// ---------- main ----------
function parseArgs() {
  const argv = process.argv.slice(2);
  return Object.fromEntries(argv.filter(a => a.startsWith('--')).map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=') || 'true']; }));
}

async function main() {
  const args = parseArgs();
  let file = {};
  try { file = JSON.parse(fs.readFileSync('./coins.json', 'utf8')); } catch { /* opsional */ }
  const a = {
    ex: (args.ex || file.exchange || 'okx').toLowerCase(), fallback: (args.fallback || file.fallback || '').toLowerCase(),
    bars: +(args.bars || 8000), refresh: !!args.refresh,
  };
  const coins = (args.coins ? args.coins.split(',') : file.coins || []).map(s => s.trim()).filter(Boolean);
  const preset = args.preset || file.preset || 'Auto';
  const o = { fee: +(args.fee ?? 0.001), k4: +(args.k4 || 2), maxRun: +(args['maxrun'] ?? 0.5), exitMode: args.exit || 'own' };
  const rules = { none: { mid: 0, ex: 0, snr: 0 }, strong: { mid: +(args['tqi-mid'] ?? 0.4), ex: +(args['tqi-ex'] ?? 0.5), snr: +(args.snr ?? 1.0) } };
  const which = (args.rule || 'both') === 'both' ? ['none', 'strong'] : [args.rule];
  if (!coins.length) { console.error('Tidak ada koin (coins.json atau --coins=...)'); process.exit(1); }

  const data = [];
  for (const pair of coins) {
    try {
      const raw = await loadCoin(pair, a);
      const D = prep(raw, preset);
      D.pair = pair; D.ex = raw.ex;
      data.push(D);
      const d = t => new Date(t).toISOString().slice(0, 10);
      console.log(`${pair.padEnd(14)} ${raw.ex.padEnd(7)} 1H ${raw.c1.length} bar (${d(raw.c1[0].t)} -> ${d(raw.c1[raw.c1.length - 1].t)}) | 4H ${raw.c4.length} | 1D ${raw.cd.length}`);
    } catch (e) { console.log(`${pair.padEnd(14)} DILEWATI: ${e.message}`); }
  }
  if (!data.length) process.exit(1);

  const run = (V, R, d1Req) => {
    let trades = [], funnel = { A: Array(7).fill(0), B: Array(7).fill(0) }, t0 = Infinity, t1 = 0;
    const per = {};
    for (const D of data) {
      const r = simulate(D, V, R, { ...o, d1Req });
      per[D.pair] = r.trades;
      trades = trades.concat(r.trades.map(t => ({ ...t, pair: D.pair })));
      for (const k of ['A', 'B']) r.funnel[k].forEach((v, i) => { funnel[k][i] += v; });
      if (r.t0 !== null) { t0 = Math.min(t0, r.t0); t1 = Math.max(t1, r.t1); }
    }
    return { trades, funnel, t0, t1, per };
  };
  const base0 = run('base', rules.none, false);
  const tSplit = (base0.t0 + base0.t1) / 2;

  console.log(`\nPreset ${preset} | fee ${(o.fee * 100).toFixed(2)}%/sisi | k4=${o.k4} bar 4H | maxrun=${o.maxRun}R | exit B: ${o.exitMode === 'own' ? 'flip bearish 4H' : 'flip bearish 1H'} | ${data.length} koin`);
  console.log(`Periode evaluasi ${new Date(base0.t0).toISOString().slice(0, 10)} -> ${new Date(base0.t1).toISOString().slice(0, 10)}; H1/H2 = paruh pertama/kedua periode (konsistensi)`);
  const head = 'Varian'.padEnd(38) + '    n  win%' + '      avgR±CI'.padStart(13) + '  totalR'.padStart(8) + '    PF'.padStart(6) + '   maxDD'.padStart(8) + '  SL%'.padStart(7) + '   H1R'.padStart(7) + '   H2R'.padStart(7);

  for (const rn of which) {
    const R = rules[rn];
    console.log(`\n=== ${rn === 'none' ? 'Struktur saja (tanpa filter TQI/SnR)' : `Aturan strong (TQI 4H >= ${R.mid}, TQI 1H >= ${R.ex}, SnR ${R.snr}xATR 1D)`} ===`);
    console.log(head);
    console.log('-'.repeat(head.length));
    const funnels = {};
    for (const V of ['base', 'A', 'B', 'AB']) {
      const lab = run(V, R, false), req = run(V, R, true);
      const name = { base: 'base (1H flip saja)', A: 'A  (1H flip + 4H bull)', B: 'B  (awal tren 4H)', AB: 'A+B (gabungan)' }[V];
      console.log(row(name + ' [1D label]', stats(lab.trades, tSplit)));
      console.log(row('  - 1D searah', stats(lab.trades.filter(t => t.d1 === 'searah'), tSplit)));
      console.log(row('  - 1D berlawanan', stats(lab.trades.filter(t => t.d1 === 'berlawanan'), tSplit)));
      console.log(row(name.split(' ')[0] + ' + 1D wajib', stats(req.trades, tSplit)));
      if (V === 'AB') {
        const by = tag => stats(lab.trades.filter(t => t.tag === tag), tSplit);
        console.log(row('  - masuk via A saja', by('A'))); console.log(row('  - masuk via B saja', by('B'))); console.log(row('  - A dan B bersamaan', by('A+B')));
      }
      funnels[V] = lab;
      if (args['per-coin'] && V === 'AB') {
        console.log('  per koin (A+B, 1D label):');
        for (const D of data) { const s = stats(lab.per[D.pair], tSplit); console.log('   ' + D.pair.padEnd(14) + (s ? `n=${String(s.n).padStart(3)} avgR ${sg(s.avg)}` : 'n=  0')); }
      }
    }
    const names = ['kandidat', 'searah TF lain', 'TQI', 'SnR', '1D', 'bebas posisi', 'trade'];
    const fun = (k, F) => names.map((nm, i) => `${nm} ${F[k][i]}`).join(' > ');
    console.log('\nFunnel (jumlah kandidat yang lolos tiap saringan):');
    console.log('  A: ' + fun('A', funnels.A.funnel));
    console.log('  B: ' + fun('B', funnels.B.funnel));
  }
  console.log('\nCatatan: avgR memakai R setelah fee; ± adalah selang kepercayaan 95% kasar (n kecil = tidak bermakna). Entry di close bar sinyal, tanpa slippage.');
  console.log('Koin saling berkorelasi, jadi jumlah trade efektif lebih kecil dari n. Jangan memilih varian hanya karena kebetulan terbaik di satu periode.');
}

module.exports = { prep, simulate, stats, loadCoin, snrNear };
if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
