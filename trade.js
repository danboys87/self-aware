'use strict';
// State machine satu trade, mengikuti logika hit-detection Pine tapi dengan TP bertingkat hanya sampai TP2.
// Posisi dibagi 2: 50% keluar di TP1, 50% di TP2. SL tetap di level awal (tidak digeser ke breakeven).
// Asumsi konservatif: jika SL tersentuh di bar yang sama dengan TP yang belum tercapai, TP bar itu TIDAK dihitung.

const W = 0.5; // bobot tiap TP

function openTrade(sig, entryT, extra = {}) {
  return {
    dir: sig.side === 'buy' ? 1 : -1, entry: sig.entry, sl: sig.sl, risk: sig.risk,
    tp: sig.tp.slice(), tpR: sig.tpR.slice(), hit: [false, false], entryT, ...extra,
  };
}

const takenR = t => t.hit.reduce((s, h, k) => s + (h ? W * t.tpR[k] : 0), 0);
const remaining = t => 1 - W * t.hit.filter(Boolean).length;

// age = jumlah bar sejak entry (bar entry = 0). Kembalikan null jika trade masih jalan.
function stepTrade(t, bar, age, maxAge = 100) {
  if (age <= 0) return null;
  const d = t.dir;
  const slHit = d === 1 ? bar.low <= t.sl : bar.high >= t.sl;
  if (!slHit) {
    for (let k = 0; k < 2; k++) {
      const reached = d === 1 ? bar.high >= t.tp[k] : bar.low <= t.tp[k];
      if (!t.hit[k] && reached) t.hit[k] = true;
    }
  }
  if (t.hit[1]) return { reason: 'TP2', R: takenR(t), exit: t.tp[1] };
  if (slHit) return { reason: 'SL', R: takenR(t) - remaining(t), exit: t.sl };
  if (age >= maxAge) return closeAtPrice(t, bar.close, 'TIMEOUT');
  return null;
}

// Tutup sisa posisi di harga tertentu (reversal / timeout).
function closeAtPrice(t, price, reason) {
  const openR = (t.dir * (price - t.entry)) / t.risk;
  return { reason, R: takenR(t) + remaining(t) * openR, exit: price };
}

module.exports = { openTrade, stepTrade, closeAtPrice };
