'use strict';
// Log ke console + Telegram (opsional: TELEGRAM_TOKEN dan TELEGRAM_CHAT_ID).
async function notify(msg) {
  console.log(new Date().toISOString(), msg.replace(/\n/g, ' | '));
  const { TELEGRAM_TOKEN: token, TELEGRAM_CHAT_ID: chat } = process.env;
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: msg }),
    });
  } catch (e) { console.error('telegram:', e.message); }
}
module.exports = { notify };
