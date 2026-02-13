import fetch from 'node-fetch';

const ALPACA_API_KEY = process.env.ALPACA_API_KEY;
const ALPACA_SECRET_KEY = process.env.ALPACA_SECRET_KEY;
const SYMBOLS = ['AAPL', 'MSFT', 'GOOGL', 'NVDA', 'META', 'TSLA', 'AMD'];
const alpacaHeaders = {
  "APCA-API-KEY-ID": ALPACA_API_KEY,
  "APCA-API-SECRET-KEY": ALPACA_SECRET_KEY
};

// Thresholds
const SURGE_THRESHOLD = 2.0;   // +2% in current session = surge
const CRASH_THRESHOLD = -2.0;  // -2% = crash

async function getSnapshot(symbol) {
  try {
    const res = await fetch(
      `https://data.alpaca.markets/v2/stocks/${symbol}/snapshot?feed=iex`,
      { headers: alpacaHeaders }
    );
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.error(`[SURGE] ${symbol} fetch error:`, e.message);
    return null;
  }
}

async function sendTelegramAlert(message) {
  try {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!botToken || !chatId) return;
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML'
      })
    });
  } catch (e) {
    console.error('[TELEGRAM] Error:', e.message);
  }
}

async function triggerLLM(jobName) {
  try {
    // Use Google Auth to trigger Cloud Run Job
    const { GoogleAuth } = await import('google-auth-library');
    const auth = new GoogleAuth();
    const client = await auth.getClient();
    const url = `https://asia-northeast1-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/screen-share-459802/jobs/${jobName}:run`;
    const res = await client.request({ url, method: 'POST' });
    console.log(`[SURGE] Triggered ${jobName}: ${res.status}`);
    return true;
  } catch (e) {
    console.error(`[SURGE] Failed to trigger ${jobName}:`, e.message);
    return false;
  }
}

async function main() {
  console.log('[SURGE DETECTOR] Starting scan...');
  const alerts = [];

  for (const symbol of SYMBOLS) {
    const snap = await getSnapshot(symbol);
    if (!snap) continue;

    const dailyBar = snap.dailyBar;
    const prevClose = snap.prevDailyBar?.c;
    const currentPrice = snap.latestTrade?.p || dailyBar?.c;

    if (!prevClose || !currentPrice) continue;

    const changePct = ((currentPrice - prevClose) / prevClose) * 100;
    const volume = dailyBar?.v || 0;

    console.log(`[SURGE] ${symbol}: ${currentPrice} (${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%) vol=${volume}`);

    if (changePct >= SURGE_THRESHOLD) {
      alerts.push({ symbol, changePct, currentPrice, prevClose, direction: 'SURGE', volume });
    } else if (changePct <= CRASH_THRESHOLD) {
      alerts.push({ symbol, changePct, currentPrice, prevClose, direction: 'CRASH', volume });
    }
  }

  if (alerts.length > 0) {
    console.log(`[SURGE] ${alerts.length} alert(s) detected!`);

    // Send Telegram notification
    const alertText = alerts.map(a =>
      `${a.direction === 'SURGE' ? '🚀' : '💥'} <b>${a.symbol}</b>: ${a.changePct >= 0 ? '+' : ''}${a.changePct.toFixed(2)}% ($${a.currentPrice})`
    ).join('\n');

    await sendTelegramAlert(
      `⚡ <b>MAGI SURGE ALERT</b>\n${alertText}\n\nTriggering rapid analysis...`
    );

    // Trigger fastest LLM (Groq) for immediate analysis
    // Pass surge info via environment or let LLM discover via get_price
    const triggered = await triggerLLM('magi-core-groq');

    if (triggered) {
      await sendTelegramAlert(`🤖 Groq (ANIMA) triggered for rapid response.`);
    }

    // If multiple surges, also trigger Gemini for second opinion
    if (alerts.length >= 2) {
      await triggerLLM('magi-core-gemini');
      await sendTelegramAlert(`🤖 Gemini (MELCHIOR-1) also triggered (multiple surges).`);
    }
  } else {
    console.log('[SURGE] No significant moves detected.');
  }

  console.log('[SURGE DETECTOR] Scan complete.');
}

main().catch(console.error);
