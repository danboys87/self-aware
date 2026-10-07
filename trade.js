'use strict';
// State machine satu trade, mengikuti logika hit-detection Pine tapi dengan TP bertingkat hanya sampai TP2.
// Posisi dibagi 2: 50% keluar di TP1, 50% di TP2.
// Setelah TP1 tercapai, SL naik ke titik entry (breakeven). Pergeseran berlaku mulai bar BERIKUTNYA,
// karena urutan harga di dalam satu candle tidak diketahui. Sisa posisi yang kena SL-BE keluar di entry (0R).
// Asumsi konservatif: jika SL tersentuh di bar yang sama dengan TP yang belum tercapai, TP bar itu TIDAK dihitung.

const W = 0.5; // bobot tiap TP

function openTrade(sig, entryT, extra = {}) {
  return {
    dir: sig.side === 'buy' ? 1 : -1, entry: sig.entry, sl: sig.sl, slInit: sig.sl, risk: sig.risk,
    tp: sig.tp.slice(), tpR: sig.tpR.slice(), hit: [false, false], be: false, entryT, ...extra,
  };
}

const takenR = t => t.hit.reduce((s, h, k) => s + (h ? W * t.tpR[k] : 0), 0);
const remaining = t => 1 - W * t.hit.filter(Boolean).length;

// Pindahkan SL ke entry setelah TP1 (juga untuk posisi lama yang sudah kena TP1 sebelum fitur ini ada).
function armBreakeven(t) {
  if (t.hit[0] && !t.be) { t.be = true; if (t.slInit === undefined) t.slInit = t.sl; t.sl = t.entry; }
}

// age = jumlah bar sejak entry (bar entry = 0). Kembalikan null jika trade masih jalan.
function stepTrade(t, bar, age, maxAge = 100) {
  if (age <= 0) return null;
  armBreakeven(t); // SL = entry jika TP1 sudah tercapai di bar sebelumnya
  const d = t.dir;
  const slHit = d === 1 ? bar.low <= t.sl : bar.high >= t.sl;
  if (!slHit) {
    for (let k = 0; k < 2; k++) {
      const reached = d === 1 ? bar.high >= t.tp[k] : bar.low <= t.tp[k];
      if (!t.hit[k] && reached) t.hit[k] = true;
    }
  }
  if (t.hit[1]) return { reason: 'TP2', R: takenR(t), exit: t.tp[1] };
  if (slHit) return t.be ? { reason: 'BE', R: takenR(t), exit: t.sl } : { reason: 'SL', R: takenR(t) - remaining(t), exit: t.sl };
  armBreakeven(t); // TP1 baru tercapai di bar ini: SL pindah ke entry, berlaku dari bar berikutnya
  if (age >= maxAge) return closeAtPrice(t, bar.close, 'TIMEOUT');
  return null;
}

// Tutup sisa posisi di harga tertentu (reversal / timeout).
function closeAtPrice(t, price, reason) {
  const openR = (t.dir * (price - t.entry)) / t.risk;
  return { reason, R: takenR(t) + remaining(t) * openR, exit: price };
}

module.exports = { openTrade, stepTrade, closeAtPrice, W };
