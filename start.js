'use strict';
// Satu proses: dashboard + paper bot + scanner (berbagi file state/scan).
// Bot mengikuti hasil scanner (koin, preset, filter), jadi RUN_BOT aktif otomatis menyalakan scanner juga.
// Matikan bot: RUN_BOT=false. Mematikan scanner saja (RUN_SCANNER=false) hanya berlaku jika bot juga mati.
if (process.env.RUN_BOT !== 'false') require('./bot');
if (process.env.RUN_SCANNER !== 'false') require('./scanner').start();
require('./server');
