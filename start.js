'use strict';
// Satu proses: dashboard + paper bot + scanner (berbagi file state/scan).
// Matikan salah satunya: RUN_BOT=false, RUN_SCANNER=false
if (process.env.RUN_BOT !== 'false') require('./bot');
if (process.env.RUN_SCANNER !== 'false') require('./scanner').start();
require('./server');
