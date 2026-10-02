'use strict';
// Port JavaScript dari "Self-Aware Trend System [WillyAlgoTrader]" v1.9.0 (Pine v6).
// Yang diport : SuperTrend adaptif, TQI, band asimetris, char-flip, SL, TP (Fixed/Dynamic, hanya TP1 & TP2).
// Tidak diport: skor sinyal (display only di Pine), self-learning/auto-calibration (default OFF), dashboard.
// Input = array candle yang SUDAH CLOSE: [{t, open, high, low, close, volume}] urut lama -> baru.

const PRESETS = {
  Scalping:      { atrLen: 10, baseMult: 1.5, erLen: 14, rsiLen: 9,  slMult: 1.0 },
  Default:       { atrLen: 14, baseMult: 2.0, erLen: 20, rsiLen: 14, slMult: 1.5 },
  Swing:         { atrLen: 21, baseMult: 2.5, erLen: 30, rsiLen: 21, slMult: 2.0 },
  'Crypto 24/7': { atrLen: 14, baseMult: 2.8, erLen: 20, rsiLen: 14, slMult: 2.5 },
};

const DEFAULTS = {
  preset: 'Crypto 24/7', tfMinutes: 60, source: 'close',
  // dipakai hanya jika preset = 'Custom'
  atrLen: 13, baseMult: 2.0, erLen: 20, rsiLen: 14, slMult: 1.5,
  atrBaselineLen: 100, useAdaptive: true, adaptStrength: 0.5,
  useTqi: true, qualityStrength: 0.4, qualityCurve: 1.5, multSmooth: true,
  useAsym: true, asymStrength: 0.5, useEffAtr: true,
  useCharFlip: true, charFlipMinAge: 5, charFlipHigh: 0.55, charFlipLow: 0.25,
  wEr: 0.35, wVol: 0.20, wStruct: 0.25, wMom: 0.20, structLen: 20, momLen: 10,
  volLen: 20, pivotLen: 3,
  tp1R: 1.0, tp2R: 2.0, tpMode: 'fixed', // 'fixed' | 'dynamic'
  dynTqiW: 0.6, dynVolW: 0.4, dynMin: 0.5, dynMax: 2.0, dynFloorR1: 0.5, dynCeilR: 8.0,
};

const MULT_SMOOTH_ALPHA = 0.15;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const safeDiv = (n, d, fb = 0) => (d !== 0 && Number.isFinite(n) && Number.isFinite(d) ? n / d : fb);
const mapClamp = (v, inLo, inHi, outLo, outHi) => {
  const t = clamp(safeDiv(v - inLo, inHi - inLo, 0), 0, 1);
  return outLo + t * (outHi - outLo);
};
const sma = (a, i, len) => {
  if (i < len - 1) return NaN;
  let s = 0;
  for (let k = i - len + 1; k <= i; k++) s += a[k];
  return s / len;
};
const stdev = (a, i, len) => { // populasi, sama seperti ta.stdev Pine
  const m = sma(a, i, len);
  if (!Number.isFinite(m)) return NaN;
  let s = 0;
  for (let k = i - len + 1; k <= i; k++) s += (a[k] - m) ** 2;
  return Math.sqrt(s / len);
};
const highest = (a, i, len) => { if (i < len - 1) return NaN; let m = -Infinity; for (let k = i - len + 1; k <= i; k++) m = Math.max(m, a[k]); return m; };
const lowest  = (a, i, len) => { if (i < len - 1) return NaN; let m = Infinity;  for (let k = i - len + 1; k <= i; k++) m = Math.min(m, a[k]); return m; };

// Pivot strict (selisih kecil dengan Pine mungkin muncul hanya jika ada harga yang persis sama)
function isPivot(a, ctr, L, high) {
  const v = a[ctr];
  for (let k = 1; k <= L; k++) {
    if (high ? !(v > a[ctr - k] && v > a[ctr + k]) : !(v < a[ctr - k] && v < a[ctr + k])) return false;
  }
  return true;
}

const SRC = {
  close: b => b.close,
  hl2: b => (b.high + b.low) / 2,
  hlc3: b => (b.high + b.low + b.close) / 3,
  ohlc4: b => (b.open + b.high + b.low + b.close) / 4,
};

function resolveParams(cfg) {
  const c = { ...DEFAULTS, ...cfg };
  let preset = c.preset;
  if (preset === 'Auto') preset = c.tfMinutes <= 5 ? 'Scalping' : (c.tfMinutes <= 240 ? 'Default' : 'Swing');
  c.resolvedPreset = preset;
  if (PRESETS[preset]) Object.assign(c, PRESETS[preset]);
  return c;
}

function liveTpR(c, tqi, volRatio) {
  const f1 = Math.min(c.tp1R, c.tp2R), f2 = Math.max(c.tp1R, c.tp2R);
  if (c.tpMode !== 'dynamic') return [f1, f2];
  const volComp = mapClamp(volRatio, 0.5, 2.0, 0, 1);
  const wSum = c.dynTqiW + c.dynVolW;
  const raw = (clamp(tqi, 0, 1) * c.dynTqiW + volComp * c.dynVolW) / (wSum > 0 ? wSum : 1);
  const scale = c.dynMin + raw * (c.dynMax - c.dynMin);
  const floor1 = c.dynFloorR1, floor2 = c.dynFloorR1 * (f2 / Math.max(f1, 0.01));
  const a = clamp(f1 * scale, floor1, c.dynCeilR);
  const b = clamp(f2 * scale, floor2, c.dynCeilR);
  return [Math.min(a, b), Math.max(a, b)];
}

function runSATS(candles, cfg = {}) {
  const c = resolveParams(cfg);
  const n = candles.length;
  const H = candles.map(b => b.high), L = candles.map(b => b.low);
  const C = candles.map(b => b.close), V = candles.map(b => b.volume || 0);
  const S = candles.map(SRC[c.source] || SRC.close);

  // ATR (Wilder/RMA, seperti ta.atr)
  const tr = H.map((h, i) => (i === 0 ? h - L[i] : Math.max(h - L[i], Math.abs(h - C[i - 1]), Math.abs(L[i] - C[i - 1]))));
  const atr = new Array(n).fill(NaN);
  for (let i = c.atrLen - 1; i < n; i++) {
    if (i === c.atrLen - 1) { let s = 0; for (let k = 0; k <= i; k++) s += tr[k]; atr[i] = s / c.atrLen; }
    else atr[i] = (atr[i - 1] * (c.atrLen - 1) + tr[i]) / c.atrLen;
  }
  const rawAtr = atr.map(v => (Number.isFinite(v) ? v : 0));

  const warmup = Math.max(50, Math.max(c.atrLen, c.erLen, c.rsiLen, c.volLen, c.pivotLen * 2 + 1, c.momLen, c.structLen) + 10);

  const trend = new Array(n), lower = new Array(n), upper = new Array(n), tqiArr = new Array(n);
  let actSm = null, pasSm = null, trendStart = 0, lastPH = NaN, lastPL = NaN;
  const bars = [];

  for (let i = 0; i < n; i++) {
    // --- regime dasar ---
    const base = sma(rawAtr, i, c.atrBaselineLen);
    const volRatio = safeDiv(rawAtr[i], Number.isFinite(base) ? base : rawAtr[i], 1);

    let er = 0;
    if (i >= c.erLen) {
      let path = 0;
      for (let k = i - c.erLen + 1; k <= i; k++) path += Math.abs(C[k] - C[k - 1]);
      er = safeDiv(Math.abs(C[i] - C[i - c.erLen]), path, 0);
    }
    const atrValue = c.useEffAtr ? rawAtr[i] * (0.5 + 0.5 * er) : rawAtr[i];

    // --- TQI ---
    const tqiEr = clamp(er, 0, 1);
    const hasVol = V[i] > 0;
    const volZ = hasVol ? safeDiv(V[i] - sma(V, i, c.volLen), stdev(V, i, c.volLen), 0) : NaN;
    const tqiVol = hasVol ? mapClamp(volZ, -1, 2, 0, 1) : mapClamp(volRatio, 0.6, 1.8, 0, 1);

    const sHi = highest(H, i, c.structLen), sLo = lowest(L, i, c.structLen);
    const pricePos = safeDiv(C[i] - sLo, sHi - sLo, 0.5);
    const tqiStruct = clamp(Math.abs(pricePos - 0.5) * 2, 0, 1);

    let tqiMom = 0;
    if (i >= c.momLen) {
      const w = C[i] - C[i - c.momLen];
      let aligned = 0;
      for (let k = 0; k < c.momLen; k++) {
        const d = C[i - k] - C[i - k - 1];
        if ((w > 0 && d > 0) || (w < 0 && d < 0)) aligned++;
      }
      tqiMom = aligned / c.momLen;
    }
    const wSum = c.wEr + c.wVol + c.wStruct + c.wMom;
    const tqiRaw = c.useTqi
      ? (tqiEr * c.wEr + tqiVol * c.wVol + tqiStruct * c.wStruct + tqiMom * c.wMom) / (wSum > 0 ? wSum : 1)
      : 0.5;
    const tqi = clamp(tqiRaw, 0, 1);
    tqiArr[i] = tqi;

    // --- multiplier adaptif ---
    const legacy = c.useAdaptive ? 1 + c.adaptStrength * (0.5 - er) : 1;
    const qDev = c.useTqi ? Math.pow(1 - tqi, c.qualityCurve) : 0.5;
    const tqiMult = 1 - c.qualityStrength + c.qualityStrength * (0.6 + 0.8 * qDev);
    const symMult = c.baseMult * legacy * tqiMult;
    let actRaw = symMult, pasRaw = symMult;
    if (c.useTqi && c.useAsym) {
      actRaw = symMult * (1 - c.asymStrength * tqi * 0.3);
      pasRaw = symMult * (1 + c.asymStrength * tqi * 0.4);
    }
    actSm = actSm === null ? actRaw : (c.multSmooth ? actSm * (1 - MULT_SMOOTH_ALPHA) + actRaw * MULT_SMOOTH_ALPHA : actRaw);
    pasSm = pasSm === null ? pasRaw : (c.multSmooth ? pasSm * (1 - MULT_SMOOTH_ALPHA) + pasRaw * MULT_SMOOTH_ALPHA : pasRaw);

    // --- SuperTrend adaptif ---
    const prevTrend = i === 0 ? 1 : trend[i - 1];
    const lowerMult = prevTrend === 1 ? actSm : pasSm;
    const upperMult = prevTrend === 1 ? pasSm : actSm;
    const lowerRaw = S[i] - lowerMult * atrValue;
    const upperRaw = S[i] + upperMult * atrValue;
    lower[i] = i === 0 ? lowerRaw : (C[i - 1] > lower[i - 1] ? Math.max(lowerRaw, lower[i - 1]) : lowerRaw);
    upper[i] = i === 0 ? upperRaw : (C[i - 1] < upper[i - 1] ? Math.min(upperRaw, upper[i - 1]) : upperRaw);

    const priceFlipUp = i > 0 && prevTrend === -1 && C[i] > upper[i - 1];
    const priceFlipDown = i > 0 && prevTrend === 1 && C[i] < lower[i - 1];

    const trendAge = i - trendStart;
    const prevTqi = i > 0 ? tqiArr[i - 1] : 0.5;
    const cfBase = c.useCharFlip && c.useTqi && prevTqi > c.charFlipHigh && tqi < c.charFlipLow && trendAge >= c.charFlipMinAge;
    // CATATAN: dengan source = close, "C[i] < S[i]" selalu false -> char-flip praktis tidak pernah aktif (sama seperti di Pine asli).
    const charFlipDown = cfBase && prevTrend === 1 && C[i] < S[i];
    const charFlipUp = cfBase && prevTrend === -1 && C[i] > S[i];

    const flipUpNow = priceFlipUp || charFlipUp;
    const flipDownNow = priceFlipDown || charFlipDown;
    trend[i] = i === 0 ? 1 : (flipUpNow ? 1 : (flipDownNow ? -1 : prevTrend));
    if (trend[i] !== prevTrend) trendStart = i;

    const flipUp = i > 0 && trend[i] === 1 && trend[i - 1] === -1;
    const flipDown = i > 0 && trend[i] === -1 && trend[i - 1] === 1;

    // --- pivot (dikonfirmasi pivotLen bar setelahnya) ---
    const ctr = i - c.pivotLen;
    if (ctr - c.pivotLen >= 0) {
      if (isPivot(H, ctr, c.pivotLen, true)) lastPH = H[ctr];
      if (isPivot(L, ctr, c.pivotLen, false)) lastPL = L[ctr];
    }

    // --- sinyal + SL/TP (hanya TP1 & TP2) ---
    let signal = null;
    if ((flipUp || flipDown) && i >= warmup) {
      const [r1, r2] = liveTpR(c, tqi, volRatio);
      const entry = C[i];
      if (flipUp) {
        const slBase = Number.isFinite(lastPL) ? lastPL : L[i];
        const sl = Math.min(slBase - c.slMult * atrValue, entry - c.slMult * atrValue);
        const risk = entry - sl;
        signal = { side: 'buy', entry, sl, risk, tpR: [r1, r2], tp: [entry + risk * r1, entry + risk * r2] };
      } else {
        const slBase = Number.isFinite(lastPH) ? lastPH : H[i];
        const sl = Math.max(slBase + c.slMult * atrValue, entry + c.slMult * atrValue);
        const risk = sl - entry;
        signal = { side: 'sell', entry, sl, risk, tpR: [r1, r2], tp: [entry - risk * r1, entry - risk * r2] };
      }
    }

    bars.push({
      i, t: candles[i].t, trend: trend[i], tqi, er, volRatio, atr: atrValue,
      stLine: trend[i] === 1 ? lower[i] : upper[i], flipUp, flipDown, signal,
    });
  }
  return { bars, warmup, params: c };
}

module.exports = { runSATS, PRESETS, DEFAULTS };
