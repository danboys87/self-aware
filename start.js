'use strict';
// Satu proses: dashboard + paper bot (berbagi STATE_FILE). RUN_BOT=false untuk dashboard saja.
if (process.env.RUN_BOT !== 'false') require('./bot');
require('./server');
