import fetch from 'node-fetch';
import { BigQuery } from '@google-cloud/bigquery';
import { v4 as uuidv4 } from 'uuid';
const PROMPT_VERSION = "5.0-constitution";
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const TOGETHER_API_KEY = process.env.TOGETHER_API_KEY;
const QWEN_API_KEY = process.env.QWEN_API_KEY;
const XAI_API_KEY = process.env.XAI_API_KEY;
const ALPACA_API_KEY = process.env.ALPACA_API_KEY;
const ALPACA_SECRET_KEY = process.env.ALPACA_SECRET_KEY;

// Telegram通知
async function sendTelegramNotification(message) {
  try {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!botToken || !chatId) {
      console.log("[TELEGRAM] Token or Chat ID not configured");
      return;
    }
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML'
      })
    });
    if (response.ok) {
      console.log("[TELEGRAM] Notification sent");
    } else {
      console.log("[TELEGRAM] Failed:", await response.text());
    }
  } catch (error) {
    console.log("[TELEGRAM] Error:", error.message);
  }
}

function getLLMProvider() { return (process.env.LLM_PROVIDER || 'mistral').trim().toLowerCase(); }
// ===== 按分設定（自動計算）=====
// 新LLM追加時は「1」を追加するだけで自動按分！
const BUDGET_WEIGHTS = {
  'mistral_NORMAL': 1,     // SOPHIA-5
  'google_NORMAL': 1,      // MELCHIOR-1
  'groq_NORMAL': 1,        // ANIMA
  'deepseek_NORMAL': 1,      // CASPER
  'xai_NORMAL': 1            // BALTHASAR (Grok)
  // 例: 'openai_NORMAL': 1  ← 追加すると自動で5等分(20%)になる
};

// 合計から自動計算（編集不要）
const TOTAL_WEIGHT = Object.values(BUDGET_WEIGHTS).reduce((a, b) => a + b, 0);
function getAllocation(provider, mode) {
  const key = provider + '_' + mode;
  return (BUDGET_WEIGHTS[key] || 1) / TOTAL_WEIGHT;
}
// =====================================
const bigquery = new BigQuery({ projectId: 'screen-share-459802' });
const dataset = bigquery.dataset('magi_core');
const analyticsDataset = bigquery.dataset('magi_analytics');
let sessionId = null;
let lastReasoning = null;  // ISABEL: 直前のreasoning保持
let startingEquity = null;

// === VIX REGIME DETECTION ===
// Uses VIXY (VIX Short-Term Futures ETF) as VIX proxy
// VIXY price ≈ VIX level (close correlation)
let currentVixRegime = null;

async function getVixRegime() {
  try {
    const response = await fetch(
      "https://data.alpaca.markets/v2/stocks/VIXY/bars?timeframe=1Day&limit=1&feed=iex",
      { headers: { "APCA-API-KEY-ID": ALPACA_API_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET_KEY } }
    );
    if (!response.ok) throw new Error("VIXY fetch failed: " + response.status);
    const data = await response.json();
    const bars = data.bars || [];
    if (bars.length === 0) {
      console.log("[VIX] No VIXY data available, defaulting to NORMAL regime");
      return { level: "NORMAL", vixEstimate: null, vixyPrice: null, buyAllowed: true, sellAllowed: true, description: "No VIX data" };
    }

    const vixyPrice = bars[bars.length - 1].c;
    const vixyHigh = bars[bars.length - 1].h;
    const vixyLow = bars[bars.length - 1].l;
    const intraRange = vixyHigh - vixyLow;
    
    // VIXY price -> VIX regime mapping
    // VIXY tracks VIX short-term futures, price roughly equals VIX level
    let level, buyAllowed, sellAllowed, description;
    
    if (vixyPrice < 18) {
      level = "LOW_FEAR";
      buyAllowed = true;
      sellAllowed = true;  // allowed but not recommended
      description = "Market calm (VIX~" + Math.round(vixyPrice) + "). LONG positions favored. Bull market conditions.";
    } else if (vixyPrice < 25) {
      level = "NORMAL";
      buyAllowed = true;
      sellAllowed = true;
      description = "Normal volatility (VIX~" + Math.round(vixyPrice) + "). Trade both directions selectively.";
    } else if (vixyPrice < 35) {
      level = "HIGH_FEAR";
      buyAllowed = true;  // allowed but with warning
      sellAllowed = true;
      description = "Elevated fear (VIX~" + Math.round(vixyPrice) + "). SHORT positions favored. Be cautious with LONG.";
    } else if (vixyPrice < 50) {
      level = "EXTREME_FEAR";
      buyAllowed = false;  // BLOCKED
      sellAllowed = true;
      description = "EXTREME FEAR (VIX~" + Math.round(vixyPrice) + "). BUY BLOCKED. Only SHORT or CASH.";
    } else {
      level = "PANIC";
      buyAllowed = false;  // BLOCKED
      sellAllowed = true;
      description = "MARKET PANIC (VIX~" + Math.round(vixyPrice) + "). BUY BLOCKED. Maximum SHORT exposure or stay CASH.";
    }

    const regime = { level, vixEstimate: Math.round(vixyPrice), vixyPrice, intraRange: Math.round(intraRange * 100) / 100, buyAllowed, sellAllowed, description };
    console.log("[VIX] Regime detected:", JSON.stringify(regime));
    currentVixRegime = regime;
    return regime;
  } catch (e) {
    console.error("[VIX] Error fetching regime:", e.message);
    return { level: "NORMAL", vixEstimate: null, vixyPrice: null, buyAllowed: true, sellAllowed: true, description: "VIX data unavailable, proceed with caution" };
  }
}

// === ISABEL: Dynamic Stats from BigQuery ===
let isabelStats = null;

async function getIsabelStats() {
  try {
    console.log('[ISABEL] Fetching latest stats from BigQuery...');
    const [dirRows] = await bigquery.query({ query: `
      SELECT llm_provider, side,
        COUNTIF(result = 'WIN') as wins,
        COUNTIF(result = 'LOSE') as loses,
        ROUND(SAFE_DIVIDE(COUNTIF(result = 'WIN'), COUNTIF(result = 'WIN') + COUNTIF(result = 'LOSE')) * 100, 1) as win_rate
      FROM magi_core.trades
      WHERE result IS NOT NULL AND side IS NOT NULL
      GROUP BY llm_provider, side
    ` });
    const [symRows] = await bigquery.query({ query: `
      SELECT symbol,
        COUNTIF(result = 'WIN') as wins,
        COUNTIF(result = 'LOSE') as loses,
        ROUND(SAFE_DIVIDE(COUNTIF(result = 'WIN'), COUNTIF(result = 'WIN') + COUNTIF(result = 'LOSE')) * 100, 1) as win_rate
      FROM magi_core.trades
      WHERE result IS NOT NULL AND side IS NOT NULL
      GROUP BY symbol
      HAVING (COUNTIF(result = 'WIN') + COUNTIF(result = 'LOSE')) >= 2
      ORDER BY win_rate DESC
    ` });
    const dirMap = {};
    for (const r of dirRows) {
      if (!dirMap[r.llm_provider]) dirMap[r.llm_provider] = {};
      dirMap[r.llm_provider][r.side] = { wins: Number(r.wins), loses: Number(r.loses), win_rate: Number(r.win_rate) || 0 };
    }
    const symbols = symRows.map(r => ({ symbol: r.symbol, wins: Number(r.wins), loses: Number(r.loses), win_rate: Number(r.win_rate) || 0 }));
    isabelStats = { directions: dirMap, symbols };
    console.log('[ISABEL] Stats loaded:', JSON.stringify({ providers: Object.keys(dirMap), symbolCount: symbols.length }));
    return isabelStats;
  } catch (e) {
    console.error('[ISABEL] Failed to load stats:', e.message);
    return null;
  }
}


// === ISABEL: Thought Pattern Analysis ===
let isabelPatterns = null;

async function getIsabelPatterns() {
  try {
    console.log('[ISABEL] Analyzing thought patterns...');
    const [rows] = await bigquery.query({ query: `
      SELECT t.result, th.reasoning, th.confidence
      FROM magi_core.trades t
      JOIN magi_core.thoughts th ON t.session_id = th.session_id AND t.symbol = th.symbol
      WHERE t.result IN ('WIN', 'LOSE') AND th.reasoning IS NOT NULL AND LENGTH(th.reasoning) > 10
    ` });
    if (!rows || rows.length < 10) { console.log('[ISABEL] Not enough data'); return null; }
    const winKeywords = {}, loseKeywords = {};
    const keywordList = ['momentum', 'upward', 'downward', 'trend', 'bullish', 'bearish', 'support', 'resistance', 'breakout', 'pullback', 'bounce', 'contrarian', 'reversal', 'oversold', 'overbought', 'RSI', 'SMA', 'volume', 'strong', 'weak', 'growth', 'decline', 'potential', 'risk', 'caution'];
    let winCount = 0, loseCount = 0;
    for (const row of rows) {
      const reasoning = (row.reasoning || '').toLowerCase();
      const isWin = row.result === 'WIN';
      if (isWin) winCount++; else loseCount++;
      for (const kw of keywordList) {
        if (reasoning.includes(kw.toLowerCase())) {
          if (isWin) winKeywords[kw] = (winKeywords[kw] || 0) + 1;
          else loseKeywords[kw] = (loseKeywords[kw] || 0) + 1;
        }
      }
    }
    const shortWins = rows.filter(r => r.result === 'WIN' && r.reasoning.length < 50).length;
    const shortLoses = rows.filter(r => r.result === 'LOSE' && r.reasoning.length < 50).length;
    const keywordWinRates = {};
    for (const kw of keywordList) {
      const w = winKeywords[kw] || 0, l = loseKeywords[kw] || 0;
      if (w + l >= 3) keywordWinRates[kw] = { winRate: Math.round(w * 100 / (w + l)), wins: w, loses: l };
    }
    const winPatterns = Object.entries(keywordWinRates).filter(([k, v]) => v.winRate >= 65).sort((a, b) => b[1].winRate - a[1].winRate).slice(0, 5);
    const losePatterns = Object.entries(keywordWinRates).filter(([k, v]) => v.winRate <= 40).sort((a, b) => a[1].winRate - b[1].winRate).slice(0, 5);
    isabelPatterns = { winPatterns, losePatterns, shortAnalysisWinRate: shortWins + shortLoses > 0 ? Math.round(shortWins * 100 / (shortWins + shortLoses)) : null, totalWins: winCount, totalLoses: loseCount };
    console.log('[ISABEL] Patterns:', JSON.stringify({ win: winPatterns.length, lose: losePatterns.length }));
    return isabelPatterns;
  } catch (e) { console.error('[ISABEL] Pattern error:', e.message); return null; }
}

function generatePatternText() {
  if (!isabelPatterns) return '';
  const lines = [];
  if (isabelPatterns.winPatterns.length > 0) {
    lines.push('[WINNING_PATTERNS]');
    for (const [kw, s] of isabelPatterns.winPatterns) lines.push('- "' + kw + '" → ' + s.winRate + '% (' + s.wins + 'W/' + s.loses + 'L)');
  }
  if (isabelPatterns.losePatterns.length > 0) {
    lines.push('[LOSING_PATTERNS - AVOID THESE]');
    for (const [kw, s] of isabelPatterns.losePatterns) lines.push('- "' + kw + '" → ' + s.winRate + '% (' + s.wins + 'W/' + s.loses + 'L) DANGER');
  }
  if (isabelPatterns.shortAnalysisWinRate !== null && isabelPatterns.shortAnalysisWinRate < 40) {
    lines.push('ALERT: Short reasoning (<50 chars) has only ' + isabelPatterns.shortAnalysisWinRate + '% win rate. Write detailed analysis.');
  }
  return lines.join('\n');
}


// === ISABEL Level 3: Quality Structure Analysis ===
let isabelQuality = null;

function analyzeReasoningQuality(reasoning, hypothesis, confidence) {
  const r = (reasoning || '').toLowerCase();
  const h = (hypothesis || '').toLowerCase();
  
  const score = {
    // 具体的なテクニカル指標の有無
    hasIndicator: /rsi|sma|ema|macd|bollinger|moving average|移動平均/.test(r) ? 1 : 0,
    // 数値データの有無（価格、%、倍率など）
    hasNumericData: /\d+(\.\d+)?%|\$\d+|\d+x|\d+倍/.test(r) ? 1 : 0,
    // 時間軸の明示
    hasTimeframe: /short.?term|long.?term|1\s?(day|week|month)|日|週|月|hours?|分/.test(r) ? 1 : 0,
    // 十分な長さ（100文字以上）
    sufficientLength: reasoning && reasoning.length >= 100 ? 1 : 0,
    // 仮説の有無と質
    hasHypothesis: hypothesis && hypothesis.length >= 20 ? 1 : 0,
    // 危険ワード（希望的観測）の不在
    noHopefulWords: !/hope|wish|should reverse|due for|might bounce|maybe/.test(r) ? 1 : 0,
    // 逆張りワードの不在
    noContrarianWords: !/contrarian|against.?trend|底|天井/.test(r) ? 1 : 0,
    // リスク認識の有無
    hasRiskAwareness: /risk|caution|concern|注意|リスク|懸念/.test(r) ? 1 : 0,
    // 具体的な価格目標/損切りの言及
    hasPriceTarget: /target|stop.?loss|利確|損切|目標/.test(r) ? 1 : 0,
    // トレンドフォローの言及
    trendFollowing: /trend|momentum|upward|上昇|継続/.test(r) ? 1 : 0
  };
  
  const total = Object.values(score).reduce((a, b) => a + b, 0);
  return { score, total, maxScore: 10 };
}

async function getIsabelQuality() {
  try {
    console.log('[ISABEL] Analyzing reasoning quality...');
    const [rows] = await bigquery.query({ query: `
      SELECT t.result, th.reasoning, th.hypothesis, th.confidence
      FROM magi_core.trades t
      JOIN magi_core.thoughts th ON t.session_id = th.session_id AND t.symbol = th.symbol
      WHERE t.result IN ('WIN', 'LOSE') AND th.reasoning IS NOT NULL AND LENGTH(th.reasoning) > 10
    ` });
    if (!rows || rows.length < 10) { console.log('[ISABEL] Not enough quality data'); return null; }
    
    // 各取引の品質スコアを計算
    const qualityResults = { win: [], lose: [] };
    const factorWinRates = {};
    
    for (const row of rows) {
      const q = analyzeReasoningQuality(row.reasoning, row.hypothesis, row.confidence);
      const isWin = row.result === 'WIN';
      qualityResults[isWin ? 'win' : 'lose'].push(q.total);
      
      // 各ファクターの勝率を計算
      for (const [factor, value] of Object.entries(q.score)) {
        if (!factorWinRates[factor]) factorWinRates[factor] = { with: { win: 0, lose: 0 }, without: { win: 0, lose: 0 } };
        if (value === 1) {
          factorWinRates[factor].with[isWin ? 'win' : 'lose']++;
        } else {
          factorWinRates[factor].without[isWin ? 'win' : 'lose']++;
        }
      }
    }
    
    // 平均品質スコア
    const avgWinQuality = qualityResults.win.length > 0 ? (qualityResults.win.reduce((a, b) => a + b, 0) / qualityResults.win.length).toFixed(1) : 0;
    const avgLoseQuality = qualityResults.lose.length > 0 ? (qualityResults.lose.reduce((a, b) => a + b, 0) / qualityResults.lose.length).toFixed(1) : 0;
    
    // 各ファクターの影響度を計算
    const factorImpact = [];
    for (const [factor, data] of Object.entries(factorWinRates)) {
      const withTotal = data.with.win + data.with.lose;
      const withoutTotal = data.without.win + data.without.lose;
      if (withTotal >= 3 && withoutTotal >= 3) {
        const withWinRate = Math.round(data.with.win * 100 / withTotal);
        const withoutWinRate = Math.round(data.without.win * 100 / withoutTotal);
        const impact = withWinRate - withoutWinRate;
        factorImpact.push({ factor, withWinRate, withoutWinRate, impact, withTotal, withoutTotal });
      }
    }
    factorImpact.sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
    
    isabelQuality = { avgWinQuality, avgLoseQuality, factorImpact, totalSamples: rows.length };
    console.log('[ISABEL] Quality:', JSON.stringify({ avgWin: avgWinQuality, avgLose: avgLoseQuality, factors: factorImpact.length }));
    return isabelQuality;
  } catch (e) { console.error('[ISABEL] Quality error:', e.message); return null; }
}

function generateQualityText() {
  if (!isabelQuality) return '';
  const lines = [];
  
  lines.push('【Analysis Quality Insights】');
  lines.push('Average quality score: WIN=' + isabelQuality.avgWinQuality + '/10, LOSE=' + isabelQuality.avgLoseQuality + '/10');
  
  // 影響度の高いファクターを表示
  const positive = isabelQuality.factorImpact.filter(f => f.impact >= 15).slice(0, 3);
  const negative = isabelQuality.factorImpact.filter(f => f.impact <= -15).slice(0, 3);
  
  if (positive.length > 0) {
    lines.push('【Quality factors that INCREASE win rate】');
    for (const f of positive) {
      const label = f.factor.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());
      lines.push('- ' + label + ': +' + f.impact + '% (' + f.withWinRate + '% vs ' + f.withoutWinRate + '%)');
    }
  }
  
  if (negative.length > 0) {
    lines.push('【Quality factors that DECREASE win rate】');
    for (const f of negative) {
      const label = f.factor.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());
      lines.push('- Missing ' + label + ': ' + f.impact + '% impact');
    }
  }
  
  lines.push('【Quality Checklist - Include in your analysis】');
  lines.push('□ Technical indicator (RSI, SMA, MACD)');
  lines.push('□ Specific numbers (price targets, %)');
  lines.push('□ Timeframe (short/long term)');
  lines.push('□ Risk awareness');
  lines.push('□ Avoid hopeful words (should, might, hope)');
  
  return lines.join('\n');
}

function generateStrengthText(provider) {
  if (!isabelStats) return 'Data collecting. Decide freely.';
  const dir = isabelStats.directions[provider];
  if (!dir) return 'Data collecting. Decide freely.';
  const lines = [];
  if (dir.buy) lines.push('BUY win rate: ' + dir.buy.win_rate + '% (' + dir.buy.wins + 'W ' + dir.buy.loses + 'L)');
  if (dir.sell) lines.push('SELL win rate: ' + dir.sell.win_rate + '% (' + dir.sell.wins + 'W ' + dir.sell.loses + 'L)');
  const buyRate = dir.buy ? dir.buy.win_rate : 0;
  const sellRate = dir.sell ? dir.sell.win_rate : 0;
  if (buyRate >= 70 && sellRate < 50) lines.push('-> You excel at BUY. Prioritize BUY. Be cautious with SELL.');
  else if (sellRate >= 70 && buyRate < 50) lines.push('-> You excel at SELL. Prioritize SELL. Be cautious with BUY.');
  else if (buyRate >= 70 && sellRate >= 70) lines.push('-> Strong at both BUY and SELL.');
  if (dir.buy && dir.buy.win_rate <= 30 && dir.buy.loses >= 3) lines.push('WARNING: BUY win rate is ' + dir.buy.win_rate + '%. Avoid BUY.');
  if (dir.sell && dir.sell.win_rate <= 30 && dir.sell.loses >= 3) lines.push('WARNING: SELL win rate is ' + dir.sell.win_rate + '%. Avoid SELL.');
  return lines.join('\n');
}

function generateSymbolText() {
  if (!isabelStats || !isabelStats.symbols.length) return 'Data collecting.';
  const good = isabelStats.symbols.filter(s => s.win_rate >= 65);
  const bad = isabelStats.symbols.filter(s => s.win_rate <= 30 && s.loses >= 2);
  const mid = isabelStats.symbols.filter(s => s.win_rate > 30 && s.win_rate < 65);
  const lines = [];
  if (good.length) lines.push('High win rate: ' + good.map(s => s.symbol + '(' + s.win_rate + '%)').join(', '));
  if (mid.length) lines.push('Caution: ' + mid.map(s => s.symbol + '(' + s.win_rate + '%)').join(', '));
  if (bad.length) lines.push('Avoid: ' + bad.map(s => s.symbol + '(' + s.win_rate + '%) - DO NOT TRADE').join(', '));
  return lines.join('\n');
}

function generateAvoidText(provider) {
  if (!isabelStats) return '';
  const lines = [];
  const bad = isabelStats.symbols.filter(s => s.win_rate <= 20 && s.loses >= 2);
  for (const s of bad) lines.push('- ' + s.symbol + ': win rate ' + s.win_rate + '%. Do not trade.');
  const dir = isabelStats.directions[provider];
  if (dir && dir.buy && dir.buy.win_rate <= 30 && dir.buy.loses >= 3) lines.push('- Your BUY decisions correlate with losses.');
  if (dir && dir.sell && dir.sell.win_rate <= 30 && dir.sell.loses >= 3) lines.push('- Your SELL decisions correlate with losses.');
  lines.push('- Never trade without data. Always reference get_price_history indicators.');
  return lines.join('\n');
}

let tradeMode = null;


// ISABELインサイト取得（参考情報としてLLMに提供）


// === Volume Spike Detection (Algo Whale Detector) ===
function detectVolumeSpike(volumeRatio, change1d, symbol) {
  const ratio = parseFloat(volumeRatio);
  const priceChange = parseFloat(change1d);
  
  if (ratio >= 3.0) {
    // 出来高が平均の3倍以上 = 大口の動き
    const direction = priceChange > 0 ? 'BULLISH' : priceChange < 0 ? 'BEARISH' : 'NEUTRAL';
    const signal = {
      type: 'VOLUME_SPIKE',
      symbol,
      volumeRatio: ratio,
      priceChange,
      direction,
      strength: ratio >= 5.0 ? 'EXTREME' : ratio >= 4.0 ? 'STRONG' : 'MODERATE',
      suggestion: direction === 'BULLISH' ? 'Consider BUY - large buyers detected' :
                  direction === 'BEARISH' ? 'Consider SELL - large sellers detected' :
                  'Watch closely - unusual activity'
    };
    console.log('[WHALE] Volume spike detected:', JSON.stringify(signal));
    return signal;
  }
  return null;
}

function generateVolumeSpikeText(priceHistoryResult) {
  if (!priceHistoryResult || !priceHistoryResult.indicators) return '';
  
  const { volume_ratio, change_1d } = priceHistoryResult.indicators;
  const spike = detectVolumeSpike(volume_ratio, change_1d, priceHistoryResult.symbol);
  
  if (!spike) return '';
  
  return `
【🐋 WHALE ALERT: ${spike.symbol}】
Volume: ${spike.volumeRatio}x average (${spike.strength})
Direction: ${spike.direction} (${spike.priceChange}%)
Signal: ${spike.suggestion}`;
}


// === Momentum Detection (Trend Surfer) ===
function detectMomentum(change1d, change5d, rsi14, sma5, sma20, symbol) {
  const daily = parseFloat(change1d) || 0;
  const weekly = parseFloat(change5d) || 0;
  const rsi = parseFloat(rsi14) || 50;
  
  let signals = [];
  let strength = 0;
  
  // 1日で2%以上の動き = 強いモメンタム
  if (Math.abs(daily) >= 2.0) {
    const direction = daily > 0 ? 'UP' : 'DOWN';
    signals.push(`Strong daily move: ${daily > 0 ? '+' : ''}${daily}%`);
    strength += 2;
  }
  
  // 5日で5%以上の動き = トレンド形成
  if (Math.abs(weekly) >= 5.0) {
    signals.push(`Weekly trend: ${weekly > 0 ? '+' : ''}${weekly}%`);
    strength += 1;
  }
  
  // RSIが極端 = オーバーボート/オーバーソールド
  if (rsi >= 70) {
    signals.push(`Overbought RSI: ${rsi}`);
    strength += 1;
  } else if (rsi <= 30) {
    signals.push(`Oversold RSI: ${rsi}`);
    strength += 1;
  }
  
  // SMAクロス確認
  if (sma5 && sma20) {
    const s5 = parseFloat(sma5);
    const s20 = parseFloat(sma20);
    const crossStrength = ((s5 - s20) / s20 * 100).toFixed(2);
    if (Math.abs(crossStrength) >= 2) {
      signals.push(`SMA divergence: ${crossStrength}%`);
      strength += 1;
    }
  }
  
  if (signals.length === 0) return null;
  
  const direction = daily >= 0 ? 'BULLISH' : 'BEARISH';
  const suggestion = direction === 'BULLISH' && rsi < 70 ? 'Consider BUY - momentum building' :
                     direction === 'BEARISH' && rsi > 30 ? 'Consider SELL - downward momentum' :
                     'Caution - possible reversal zone';
  
  const result = {
    type: 'MOMENTUM',
    symbol,
    direction,
    strength: strength >= 4 ? 'EXTREME' : strength >= 3 ? 'STRONG' : 'MODERATE',
    signals,
    suggestion
  };
  
  console.log('[MOMENTUM] Detected:', JSON.stringify(result));
  return result;
}

// === ISABEL: Real-time Feedback for LLMs ===
let isabelRealtimeFeedback = null;

async function getRealtimeFeedback(provider) {
  try {
    console.log('[ISABEL] Loading realtime feedback for', provider);
    
    // 直近5取引の結果を取得
    const [recentTrades] = await bigquery.query({ query: `
      SELECT symbol, side, result,
        ROUND((exit_price - filled_avg_price) / filled_avg_price * 100, 2) as pnl_pct,
        FORMAT_TIMESTAMP('%m/%d %H:%M', timestamp, 'Asia/Tokyo') as trade_time
      FROM magi_core.trades 
      WHERE llm_provider = '${provider}' AND result IS NOT NULL
      ORDER BY timestamp DESC LIMIT 5
    ` });
    
    // プロバイダーの直近勝率
    const [stats] = await bigquery.query({ query: `
      SELECT 
        COUNTIF(result = 'WIN') as recent_wins,
        COUNTIF(result = 'LOSE') as recent_loses,
        ROUND(SUM(CASE WHEN result = 'WIN' THEN (exit_price - filled_avg_price) * qty ELSE 0 END), 2) as total_profit,
        ROUND(SUM(CASE WHEN result = 'LOSE' THEN (exit_price - filled_avg_price) * qty ELSE 0 END), 2) as total_loss
      FROM magi_core.trades 
      WHERE llm_provider = '${provider}' AND result IS NOT NULL
        AND timestamp > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
    ` });
    
    isabelRealtimeFeedback = {
      provider,
      recentTrades: recentTrades || [],
      stats: stats && stats[0] ? stats[0] : null
    };
    
    console.log('[ISABEL] Realtime feedback:', JSON.stringify({ 
      trades: recentTrades?.length || 0,
      hasStats: !!stats?.[0]
    }));
    
    return isabelRealtimeFeedback;
  } catch (e) {
    console.error('[ISABEL] Realtime feedback error:', e.message);
    return null;
  }
}

function generateRealtimeFeedbackText(provider) {
  if (!isabelRealtimeFeedback || isabelRealtimeFeedback.provider !== provider) return '';
  
  const { recentTrades, stats } = isabelRealtimeFeedback;
  const lines = [];
  
  // 直近の取引結果
  if (recentTrades && recentTrades.length > 0) {
    lines.push('[RECENT_TRADES]');
    for (const t of recentTrades) {
      const emoji = t.result === 'WIN' ? 'W' : 'L';
      const sign = t.pnl_pct >= 0 ? '+' : '';
      lines.push(`${emoji} ${t.symbol} ${t.side}: ${t.result} (${sign}${t.pnl_pct}%) - ${t.trade_time}`);
    }
    
    // 直近勝敗
    const wins = recentTrades.filter(t => t.result === 'WIN').length;
    const loses = recentTrades.filter(t => t.result === 'LOSE').length;
    lines.push(`Recent: ${wins}W ${loses}L`);
  }
  
  // 7日間の統計
  if (stats && (stats.recent_wins > 0 || stats.recent_loses > 0)) {
    lines.push('[7DAY_PERFORMANCE]');
    const total = stats.recent_wins + stats.recent_loses;
    const winRate = total > 0 ? Math.round(stats.recent_wins * 100 / total) : 0;
    lines.push(`Win rate: ${winRate}% (${stats.recent_wins}W ${stats.recent_loses}L)`);
    
    const netPnL = (stats.total_profit || 0) + (stats.total_loss || 0);
    const sign = netPnL >= 0 ? '+' : '';
    lines.push(`Net P&L: ${sign}$${netPnL.toFixed(2)}`);
  }
  
  // 学習ポイント
  if (recentTrades && recentTrades.length >= 3) {
    const recentLoses = recentTrades.filter(t => t.result === 'LOSE');
    if (recentLoses.length >= 2) {
      lines.push('ALERT: Consecutive losses detected. Increase analysis depth before next trade.');
    }
    const recentWins = recentTrades.filter(t => t.result === 'WIN');
    if (recentWins.length >= 3) {
      lines.push('STATUS: Strong recent performance. Continue current analysis approach.');
    }
  }
  
  return lines.join('\n');
}


// === ISABEL Level 4: Cohere Embedding Analysis ===
let isabelEmbeddings = null;

async function getIsabelEmbeddings() {
  try {
    const cohereKey = process.env.COHERE_API_KEY;
    if (!cohereKey) { console.log('[ISABEL] No Cohere API key'); return null; }
    
    console.log('[ISABEL] Loading embeddings analysis...');
    
    // 勝ち/負けのreasoningを取得
    const [rows] = await bigquery.query({ query: `
      SELECT t.result, th.reasoning
      FROM magi_core.trades t
      JOIN magi_core.thoughts th ON t.session_id = th.session_id AND t.symbol = th.symbol
      WHERE t.result IN ('WIN', 'LOSE') AND th.reasoning IS NOT NULL AND LENGTH(th.reasoning) > 30
      ORDER BY t.timestamp DESC LIMIT 50
    ` });
    
    if (!rows || rows.length < 10) { console.log('[ISABEL] Not enough data for embeddings'); return null; }
    
    const winReasonings = rows.filter(r => r.result === 'WIN').map(r => r.reasoning).slice(0, 20);
    const loseReasonings = rows.filter(r => r.result === 'LOSE').map(r => r.reasoning).slice(0, 20);
    
    if (winReasonings.length < 3 || loseReasonings.length < 3) {
      console.log('[ISABEL] Not enough WIN/LOSE samples');
      return null;
    }
    
    // Cohere Embed APIでベクトル化
    const embedResponse = await fetch('https://api.cohere.ai/v1/embed', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + cohereKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        texts: [...winReasonings, ...loseReasonings],
        model: 'embed-multilingual-v3.0',
        input_type: 'classification'
      })
    });
    
    if (!embedResponse.ok) {
      console.log('[ISABEL] Cohere API error:', await embedResponse.text());
      return null;
    }
    
    const embedData = await embedResponse.json();
    const embeddings = embedData.embeddings;
    
    // 勝ちと負けのcentroid（中心ベクトル）を計算
    const winEmbeddings = embeddings.slice(0, winReasonings.length);
    const loseEmbeddings = embeddings.slice(winReasonings.length);
    
    const winCentroid = computeCentroid(winEmbeddings);
    const loseCentroid = computeCentroid(loseEmbeddings);
    
    isabelEmbeddings = { winCentroid, loseCentroid, winCount: winReasonings.length, loseCount: loseReasonings.length };
    console.log('[ISABEL] Embeddings computed:', JSON.stringify({ win: winReasonings.length, lose: loseReasonings.length }));
    
    return isabelEmbeddings;
  } catch (e) {
    console.error('[ISABEL] Embeddings error:', e.message);
    return null;
  }
}

function computeCentroid(vectors) {
  if (!vectors || vectors.length === 0) return null;
  const dim = vectors[0].length;
  const centroid = new Array(dim).fill(0);
  for (const vec of vectors) {
    for (let i = 0; i < dim; i++) centroid[i] += vec[i];
  }
  for (let i = 0; i < dim; i++) centroid[i] /= vectors.length;
  return centroid;
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// 新しいreasoningの勝率予測（将来のリアルタイム予測用）
async function predictWinProbability(reasoning) {
  if (!isabelEmbeddings || !process.env.COHERE_API_KEY) return null;
  
  try {
    const embedResponse = await fetch('https://api.cohere.ai/v1/embed', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.COHERE_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts: [reasoning], model: 'embed-multilingual-v3.0', input_type: 'classification' })
    });
    
    if (!embedResponse.ok) return null;
    const embedData = await embedResponse.json();
    const vec = embedData.embeddings[0];
    
    const winSim = cosineSimilarity(vec, isabelEmbeddings.winCentroid);
    const loseSim = cosineSimilarity(vec, isabelEmbeddings.loseCentroid);
    
    // 勝ちクラスタとの類似度が高いほど勝率予測が高い
    const winProb = Math.round(winSim / (winSim + loseSim) * 100);
    return { winProb, winSim: winSim.toFixed(3), loseSim: loseSim.toFixed(3) };
  } catch (e) {
    return null;
  }
}

function generateEmbeddingsText() {
  if (!isabelEmbeddings) return '';
  return `【Semantic Analysis (Cohere Embeddings)】
WIN cluster: ${isabelEmbeddings.winCount} samples analyzed
LOSE cluster: ${isabelEmbeddings.loseCount} samples analyzed
Your reasoning will be compared semantically to past WIN/LOSE patterns.`;
}

async function getIsabelInsights() {
  try {
    const query = `
      WITH stats AS (
        SELECT
          COUNT(*) as total,
          COUNTIF(result = 'WIN') as wins,
          COUNTIF(result = 'LOSE') as losses,
          ROUND(AVG(CASE WHEN result = 'WIN' THEN confidence END), 2) as win_avg_conf,
          ROUND(AVG(CASE WHEN result = 'LOSE' THEN confidence END), 2) as lose_avg_conf,
          ROUND(AVG(CASE WHEN result = 'WIN' THEN return_pct END), 1) as win_avg_return
        FROM magi_core.isabel_analysis
        WHERE result IS NOT NULL
      )
      SELECT * FROM stats WHERE total >= 10
    `;
    const [rows] = await bigquery.query({ query });
    if (!rows || rows.length === 0) return null;
    
    const s = rows[0];
    const winRate = Math.round(s.wins * 100 / s.total);
    
    let insight = `[ISABEL SYSTEM ANALYSIS - ${s.total} trades evaluated]
WIN_RATE: ${winRate}% (${s.wins}W / ${s.losses}L)
AVG_CONFIDENCE: WIN=${s.win_avg_conf} | LOSE=${s.lose_avg_conf}`;
    
    if (s.lose_avg_conf > s.win_avg_conf) {
      insight += `\nALERT: High confidence correlates with LOSING trades. Lower confidence may produce better results.`;
    }
    insight += `\nAVG_RETURN_ON_WIN: +${s.win_avg_return}%`;
    insight += `\nNOTE: This is historical data. Use it to inform, not override, your analysis.`;
    
    return insight;
  } catch (e) {
    console.log('[ISABEL] Insights取得スキップ:', e.message);
    return null;
  }
}

async function safeInsert(tableName, rows, useAnalytics = false) {
  const maxRetries = 3;
  let attempt = 0;
  const targetDataset = useAnalytics ? analyticsDataset : dataset;
  const datasetName = useAnalytics ? 'magi_analytics' : 'magi_core';
  
  while (attempt < maxRetries) {
    try {
      console.log("[BQ] Attempt " + (attempt + 1) + ": Inserting into " + datasetName + "." + tableName);
      const table = targetDataset.table(tableName);
      const [response] = await table.insert(rows);
      if (response.insertErrors) {
        console.error("[BQ ERROR] Insert errors:", response.insertErrors);
        attempt++;
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      } else {
        console.log("[BQ SUCCESS] Inserted into " + datasetName + "." + tableName);
        return true;
      }
    } catch (err) {
      console.error("[BQ EXCEPTION] " + datasetName + "." + tableName + ":", err.message);
      attempt++;
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
  console.error("[BQ FAILURE] Failed after " + maxRetries + " attempts");
  return false;
}

const alpacaHeaders = {
  'APCA-API-KEY-ID': ALPACA_API_KEY,
  'APCA-API-SECRET-KEY': ALPACA_SECRET_KEY,
  'Content-Type': 'application/json',
};

function calculateATR(bars, period) {
  if (!bars || bars.length < period) {
    return null;
  }
  let trValues = [];
  for (let i = 1; i < bars.length; i++) {
    const high = bars[i].h;
    const low = bars[i].l;
    const prevClose = bars[i-1].c;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trValues.push(tr);
  }

  if (trValues.length < period) {
    return null;
  }
  
  // Wilder's Smoothing
  let atr = trValues.slice(0, period).reduce((sum, val) => sum + val, 0) / period;
  for (let i = period; i < trValues.length; i++) {
    atr = (atr * (period - 1) + trValues[i]) / period;
  }
  
  return atr;
}

async function getTradeExecutionData(symbol) {
  try {
    const historyUrl = `https://data.alpaca.markets/v2/stocks/${symbol}/bars?timeframe=1Day&limit=21&feed=iex`;
    const historyResponse = await fetch(historyUrl, { headers: alpacaHeaders });
    if (!historyResponse.ok) return { atr: null };
    
    const historyData = await historyResponse.json();
    const bars = historyData.bars || [];
    
    const atr14 = calculateATR(bars, 14);
    
    return { atr: atr14 };
  } catch (e) {
    console.error(`[EXEC_DATA] Failed to get ATR for ${symbol}: ${e.message}`);
    return { atr: null };
  }
}

const tools = [
  {
    type: "function",
    function: {
      name: "get_price",
      description: "Get current price for a stock symbol",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Stock symbol (e.g., AAPL)" }
        },
        required: ["symbol"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_account",
      description: "Get account information including buying power and portfolio value",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "get_positions",
      description: "Get current positions",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "get_price_history",
      description: "Get historical daily price bars for a stock symbol. Returns last 20 trading days with open/high/low/close/volume, plus calculated SMA5, SMA20, RSI14, and price change percentages. Use this BEFORE making trade decisions to understand the trend.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Stock symbol (e.g., AAPL)" }
        },
        required: ["symbol"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "place_order",
      description: "Place a buy or sell order",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          qty: { type: "number" },
          side: { type: "string", enum: ["buy", "sell"] },
          reason: { type: "string", description: "Why are you making this trade?" }
        },
        required: ["symbol", "qty", "side", "reason"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "log_analysis",
      description: "Record your detailed analysis before making a trade decision. REQUIRED before every place_order.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Stock symbol being analyzed" },
          reasoning: { type: "string", description: "Your detailed reasoning and analysis process" },
          hypothesis: { type: "string", description: "Your hypothesis about what will happen" },
          observations: { type: "string", description: "Key observations and findings" },
          concerns: { type: "string", description: "Risks and concerns you identified" },
          action: { type: "string", enum: ["BUY", "SELL", "HOLD"], description: "Your recommended action" },
          confidence: { type: "number", description: "Confidence level 0.0-1.0" },
          price_target: { type: "number", description: "Target price if applicable" },
          time_horizon: { type: "string", description: "Expected time horizon (e.g., 1h, 1d, 1w)" }
        },
        required: ["symbol", "reasoning", "action", "confidence"]
      }
    }
  }
];

async function executeTool(toolName, params) {
  try {
    switch (toolName) {
      case "get_price":
        const priceResponse = await fetch(
          "https://data.alpaca.markets/v2/stocks/" + params.symbol + "/quotes/latest?feed=iex",
          { headers: alpacaHeaders }
        );
        const priceData = await priceResponse.json();
        // Use ask price, fallback to bid price if ask is 0
        const price = priceData.quote?.ap || priceData.quote?.bp || 0;
        return { symbol: params.symbol, price: price };

      case "get_account":
        const accountResponse = await fetch(
          "https://paper-api.alpaca.markets/v2/account",
          { headers: alpacaHeaders }
        );
        const accountData = await accountResponse.json();  
        // 按分率を取得（自動計算）
        const allocation = getAllocation(getLLMProvider(), tradeMode);
        // 按分された値を返す
        return {
          equity: (parseFloat(accountData.equity) * allocation).toFixed(2),
          cash: (parseFloat(accountData.cash) * allocation).toFixed(2),
          buying_power: (parseFloat(accountData.buying_power) * allocation).toFixed(2),
          portfolio_value: (parseFloat(accountData.portfolio_value || 0) * allocation).toFixed(2),
          allocation_percent: (allocation * 100).toFixed(0) + '%',
          unit_name: getLLMProvider() === 'google' ? 'MELCHIOR-1' : getLLMProvider() === 'groq' ? 'ANIMA' : getLLMProvider() === 'deepseek' ? 'CASPER' : getLLMProvider() === 'together' ? 'ORACLE' : 'SOPHIA-5',
          _note: 'This is your allocated budget share.'
        };
      case "get_positions":
        const positionsResponse = await fetch(
          "https://paper-api.alpaca.markets/v2/positions",
          { headers: alpacaHeaders }
        );
        return await positionsResponse.json();

      case "get_price_history":
        const historyUrl = "https://data.alpaca.markets/v2/stocks/" + params.symbol + "/bars?timeframe=1Day&limit=20&feed=iex";
        const historyResponse = await fetch(historyUrl, { headers: alpacaHeaders });
        const historyData = await historyResponse.json();
        const bars = historyData.bars || [];
        if (bars.length === 0) {
          return { symbol: params.symbol, error: "No historical data available" };
        }
        const closes = bars.map(b => b.c);
        const volumes = bars.map(b => b.v);
        const sma5 = closes.length >= 5 ? closes.slice(-5).reduce((a, b) => a + b, 0) / 5 : null;
        const sma20 = closes.length >= 20 ? closes.slice(-20).reduce((a, b) => a + b, 0) / 20 : null;
        let rsi14 = null;
        if (closes.length >= 15) {
          let gains = 0, losses = 0;
          for (let i = closes.length - 14; i < closes.length; i++) {
            const diff = closes[i] - closes[i - 1];
            if (diff > 0) gains += diff;
            else losses -= diff;
          }
          const avgGain = gains / 14;
          const avgLoss = losses / 14;
          rsi14 = avgLoss === 0 ? 100 : Math.round(100 - (100 / (1 + avgGain / avgLoss)));
        }
        const latestClose = closes[closes.length - 1];
        const change1d = closes.length >= 2 ? ((latestClose - closes[closes.length - 2]) / closes[closes.length - 2] * 100).toFixed(2) : null;
        const change5d = closes.length >= 6 ? ((latestClose - closes[closes.length - 6]) / closes[closes.length - 6] * 100).toFixed(2) : null;
        const change20d = closes.length >= 20 ? ((latestClose - closes[0]) / closes[0] * 100).toFixed(2) : null;
        const avgVolume = Math.round(volumes.reduce((a, b) => a + b, 0) / volumes.length);
        const latestVolume = volumes[volumes.length - 1];
        const volumeRatio = (latestVolume / avgVolume).toFixed(2);
        const recentBars = bars.slice(-5).map(b => ({
          date: b.t.split("T")[0],
          open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v
        }));
        const atr14 = calculateATR(bars, 14);

        return {
          symbol: params.symbol,
          latest_close: latestClose,
          indicators: {
            sma5: sma5 ? sma5.toFixed(2) : null,
            sma20: sma20 ? sma20.toFixed(2) : null,
            rsi14: rsi14,
            atr14: atr14 ? atr14.toFixed(4) : null, // Add ATR to indicators
            change_1d: change1d + "%",
            change_5d: change5d + "%",
            change_20d: change20d ? change20d + "%" : null,
            volume_ratio: volumeRatio + "x vs avg",
            avg_volume: avgVolume
          },
          recent_bars: recentBars,
          trend: sma5 && sma20 ? (sma5 > sma20 ? "BULLISH (SMA5 > SMA20)" : "BEARISH (SMA5 < SMA20)") : "INSUFFICIENT DATA",
          whale_alert: detectVolumeSpike(volumeRatio, change1d, params.symbol),
          momentum_alert: detectMomentum(change1d, change5d, rsi14, sma5, sma20, params.symbol)
        };


      
       case "place_order":
        // === バリデーション: side/qty/symbolが無い場合は拒否 ===
        if (!params.side || !params.qty || !params.symbol) {
          console.error("[ORDER REJECTED] Missing required params:", JSON.stringify({
            symbol: params.symbol || "NULL",
            side: params.side || "NULL",
            qty: params.qty || "NULL"
          }));
          return { error: "Missing required parameters: symbol, side, qty" };
        }
        // === DIRECTION GUARD: Data-driven auto-block ===
        // Condition: win_rate <= 30% AND loses >= 3 (same as ISABEL WARNING threshold)
        if (isabelStats && params.side) {
          const dir = isabelStats.directions[getLLMProvider()];
          if (dir) {
            const sideStats = dir[params.side.toLowerCase()];
            if (sideStats && sideStats.win_rate <= 30 && sideStats.loses >= 3) {
              console.warn('[DIRECTION GUARD] ' + getLLMProvider() + ' ' + params.side.toUpperCase() + ' blocked. Win rate: ' + sideStats.win_rate + '% (' + sideStats.wins + 'W ' + sideStats.loses + 'L)');
              return { error: 'DIRECTION GUARD: Your ' + params.side.toUpperCase() + ' decisions have ' + sideStats.win_rate + '% win rate (' + sideStats.wins + 'W ' + sideStats.loses + 'L). This direction is blocked. Re-analyze for the opposite direction.', blocked_by: 'direction_guard', win_rate: sideStats.win_rate, wins: sideStats.wins, loses: sideStats.loses };
            }
          }
        }
        // === VIX REGIME GUARD ===
        // Block BUY in EXTREME_FEAR/PANIC, warn in HIGH_FEAR
        if (currentVixRegime && params.side && params.side.toLowerCase() === 'buy') {
          if (currentVixRegime.level === 'EXTREME_FEAR' || currentVixRegime.level === 'PANIC') {
            console.warn('[VIX GUARD] BUY blocked in ' + currentVixRegime.level + ' regime (VIX~' + currentVixRegime.vixEstimate + ')');
            return { error: 'VIX GUARD: Market is in ' + currentVixRegime.level + ' mode (VIX~' + currentVixRegime.vixEstimate + '). BUY orders are blocked. Re-analyze for a SELL/SHORT opportunity or stay in CASH.', blocked_by: 'vix_guard', vix_level: currentVixRegime.level, vix_estimate: currentVixRegime.vixEstimate };
          }
          if (currentVixRegime.level === 'HIGH_FEAR') {
            console.warn('[VIX GUARD] BUY warning in HIGH_FEAR regime (VIX~' + currentVixRegime.vixEstimate + '). Allowed but risky.');
          }
        }
        // === ISABEL: 思考パターン類似度判定 ===
        if (lastReasoning && isabelEmbeddings) {
          const prediction = await predictWinProbability(lastReasoning);
          if (prediction) {
            console.log('[ISABEL] Pattern analysis:', JSON.stringify(prediction));
            if (prediction.winProb < 40) {
              console.warn('[ISABEL WARNING] This reasoning resembles LOSE patterns! winProb=' + prediction.winProb + '%');
              // 将来的にはここでブロック可能:
              // return { error: "ISABEL blocked: reasoning too similar to LOSE patterns", prediction };
            }
          }
        }
        const orderResponse = await fetch(
          "https://paper-api.alpaca.markets/v2/orders",
          {
            method: "POST",
            headers: alpacaHeaders,
            body: JSON.stringify({
              symbol: params.symbol,
              qty: params.qty,
              side: params.side,
              type: "market",
              time_in_force: "day"
            })
          }
        );
        const orderResult = await orderResponse.json();
        
        // === ガード: 注文失敗時はレコードを保存しない ===
        if (!orderResult.id) {
          console.error("[ORDER FAILED] Alpaca returned no order ID:", JSON.stringify(orderResult));
          return { error: "Order failed", details: orderResult };
        }
        
        // 約定を待って価格を取得（最大5秒）
        let filledPrice = orderResult.filled_avg_price || null;
        if (!filledPrice && orderResult.id) {
          for (let i = 0; i < 5; i++) {
            await new Promise(r => setTimeout(r, 1000));
            const checkRes = await fetch(
              "https://paper-api.alpaca.markets/v2/orders/" + orderResult.id,
              { headers: alpacaHeaders }
            );
            const checkOrder = await checkRes.json();
            if (checkOrder.filled_avg_price) {
              filledPrice = checkOrder.filled_avg_price;
              break;
            }
          }
        }
        
        // フォールバック: 価格が取得できない場合は現在価格を使用
        if (!filledPrice) {
          try {
            const fallbackRes = await fetch(
              "https://data.alpaca.markets/v2/stocks/" + params.symbol + "/quotes/latest?feed=iex",
              { headers: alpacaHeaders }
            );
            const fallbackData = await fallbackRes.json();
            filledPrice = fallbackData.quote?.ap || fallbackData.quote?.bp || null;
            if (filledPrice) console.log("[FALLBACK] Using market price for " + params.symbol + ": $" + filledPrice);
          } catch (e) {
            console.warn("[WARN] Could not get fallback price for " + params.symbol);
          }
        }
        
        const tradeExecutionData = await getTradeExecutionData(params.symbol);

        await safeInsert('trades', [{
          session_id: sessionId,
          timestamp: new Date().toISOString(),
          order_id: orderResult.id,
          symbol: params.symbol,
          side: params.side,
          qty: params.qty,
          filled_avg_price: filledPrice ? parseFloat(filledPrice) : null,
          atr_at_execution: tradeExecutionData.atr,
          reason: params.reason,
          llm_provider: getLLMProvider(),
          unit_name: getLLMProvider() === 'google' ? 'MELCHIOR-1' : getLLMProvider() === 'groq' ? 'ANIMA' : getLLMProvider() === 'deepseek' ? 'CASPER' : getLLMProvider() === 'together' ? 'ORACLE' : 'SOPHIA-5',
          trade_mode:tradeMode,
          prompt_version: PROMPT_VERSION
        }]);
        return orderResult;

      case "log_analysis":
        lastReasoning = params.reasoning;  // ISABEL: 保存
        // フォールバック: symbolがない場合、reasoningから抽出
        const KNOWN_SYMBOLS = ['AAPL', 'MSFT', 'GOOGL', 'NVDA', 'META', 'TSLA', 'AMD', 'IONQ', 'SPY', 'QQQ', 'KTOS', 'ONDS', 'SES'];
        if (!params.symbol && params.reasoning) {
          for (const sym of KNOWN_SYMBOLS) {
            if (params.reasoning.toUpperCase().includes(sym)) {
              params.symbol = sym;
              console.log("[FALLBACK] Extracted symbol from reasoning: " + sym);
              break;
            }
          }
        }
        // フォールバック: actionがない場合、reasoningから推測
        if (!params.action && params.reasoning) {
          const reasoningLower = params.reasoning.toLowerCase();
          if (reasoningLower.includes('buy') || reasoningLower.includes('long') || reasoningLower.includes('購入')) {
            params.action = 'BUY';
          } else if (reasoningLower.includes('sell') || reasoningLower.includes('short') || reasoningLower.includes('売却')) {
            params.action = 'SELL';
          } else {
            params.action = 'HOLD';
          }
          console.log("[FALLBACK] Inferred action from reasoning: " + params.action);
        }
        let currentPrice = null;
        try {
          const priceRes = await fetch(
            "https://data.alpaca.markets/v2/stocks/" + params.symbol + "/quotes/latest?feed=iex",
            { headers: alpacaHeaders }
          );
          const priceInfo = await priceRes.json();
          currentPrice = priceInfo.quote?.ap || null;
        } catch (e) {
          console.log("[WARN] Could not get price for " + params.symbol);
        }

        const analysisRecord = {
          id: uuidv4(),
          created_at: new Date().toISOString(),
          symbol: params.symbol,
          topic: null,
          llm_provider: getLLMProvider(),
          llm_model: getLLMProvider() === 'google' ? 'gemini-2.0-flash' : getLLMProvider() === 'groq' ? 'llama-3.3-70b-versatile' : getLLMProvider() === 'deepseek' ? 'deepseek-chat' : getLLMProvider() === 'together' ? 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8' : getLLMProvider() === 'xai' ? 'grok-4-1-fast' : 'mistral-small-latest',
          unit_name: getLLMProvider() === 'google' ? 'MELCHIOR-1' : getLLMProvider() === 'groq' ? 'ANIMA' : getLLMProvider() === 'deepseek' ? 'CASPER' : getLLMProvider() === 'together' ? 'ORACLE' : 'SOPHIA-5',
          input_type: 'market_data',
          input_summary: "Session " + sessionId + " - Real-time analysis",
          reasoning: params.reasoning,
          hypothesis: params.hypothesis || null,
          observations: params.observations || null,
          concerns: params.concerns || null,
          action: params.action,
          confidence: params.confidence,
          price_target: params.price_target || null,
          time_horizon: params.time_horizon || null,
          actual_price_at_analysis: currentPrice,
          prompt_template: 'magi-core-v3.4-autonomous',
          metadata: JSON.stringify({ session_id: sessionId, trade_mode: tradeMode })
        };

        console.log("[ANALYSIS] " + params.symbol + ": " + params.action + " (" + (params.confidence * 100).toFixed(0) + "%)");
        console.log("[REASONING] " + params.reasoning.substring(0, 200) + "...");
        
        await safeInsert('llm_analysis', [analysisRecord], true);
        
        await safeInsert('thoughts', [{
          session_id: sessionId,
          timestamp: new Date().toISOString(),
          content: "[" + params.symbol + "] " + params.action + " @ " + (params.confidence * 100).toFixed(0) + "% - " + params.reasoning,
          llm_provider: getLLMProvider(),
          unit_name: getLLMProvider() === 'google' ? 'MELCHIOR-1' : getLLMProvider() === 'groq' ? 'ANIMA' : getLLMProvider() === 'deepseek' ? 'CASPER' : getLLMProvider() === 'together' ? 'ORACLE' : 'SOPHIA-5',
          symbol: params.symbol,
          action: params.action,
          reasoning: params.reasoning,
          hypothesis: params.hypothesis || null,
          confidence: params.confidence,
          concerns: params.concerns || null,
          trade_mode: tradeMode,
          prompt_version: PROMPT_VERSION
        }]);
        
        return { status: "analysis_logged", id: analysisRecord.id };

      default:
        throw new Error("Unknown tool: " + toolName);
    }
  } catch (error) {
    console.error("Error executing " + toolName + ":", error.message);
    return { error: error.message };
  }
}

const geminiTools = [
  {
    functionDeclarations: tools.map(tool => ({
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    })),
  }
];


// === 429 Auto-Retry Wrapper ===
async function callLLM(messages) {
  const maxRetries = 3;
  const retryDelaySec = 30;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await callLLMInternal(messages);
    } catch (error) {
      if (error.message && error.message.includes('429') && attempt < maxRetries) {
        console.log('[RETRY] 429 Rate limit hit. Attempt ' + attempt + '/' + maxRetries + '. Waiting ' + retryDelaySec + 's...');
        await new Promise(resolve => setTimeout(resolve, retryDelaySec * 1000));
        continue;
      }
      throw error;
    }
  }
}

async function callLLMInternal(messages) {
  const startTime = Date.now();
  let response;
  let provider, model, inputTokens, outputTokens, costUsd;

  try {
    if (getLLMProvider() === 'google') {
      provider = 'google';
      model = 'gemini-2.0-flash';

      let systemInstruction = null;
      const geminiMessages = [];

      for (const msg of messages) {
        if (msg.role === 'system') {
          systemInstruction = { parts: [{ text: msg.content }] };
        } else if (msg.role === 'tool') {
          // Gemini function response format
          geminiMessages.push({
            role: 'function',
            parts: [{
              functionResponse: {
                name: msg.tool_name,
                response: { result: JSON.parse(msg.content) }
              }
            }]
          });
        } else if (msg.role === 'assistant' && msg.tool_calls) {
          const parts = [];
          if (msg.content) {
            parts.push({ text: msg.content });
          }
          for (const toolCall of msg.tool_calls) {
            parts.push({
              functionCall: {
                name: toolCall.function.name,
                args: JSON.parse(toolCall.function.arguments),
              }
            });
          }
          geminiMessages.push({ role: 'model', parts });
        } else {
          geminiMessages.push({
            role: msg.role === 'user' ? 'user' : 'model',
            parts: [{ text: msg.content || '' }]
          });
        }
      }

      console.log("[GEMINI DEBUG] Messages count:", geminiMessages.length);
      console.log("[GEMINI DEBUG] Last message:", JSON.stringify(geminiMessages[geminiMessages.length - 1], null, 2));
      
      const geminiBody = {
        contents: geminiMessages,
        ...(systemInstruction && { system_instruction: systemInstruction }),
        tools: geminiTools,
        tool_config: { function_calling_config: { mode: 'auto' } },
      };

      response = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + GEMINI_API_KEY,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(geminiBody),
        }
      );

      if (!response.ok) {
        const errorData = await response.json();
        console.error("[GEMINI ERROR]", response.status, errorData);
        throw new Error("Gemini API error: " + response.status);
      }

      const geminiResponse = await response.json();
      const responseTimeMs = Date.now() - startTime;
      const candidate = geminiResponse.candidates?.[0];

      if (!candidate) {
        throw new Error("No candidate in Gemini response");
      }

      const content = candidate.content;
      const functionCalls = content.parts
        .filter(part => part.functionCall)
        .map(part => ({
          id: uuidv4(),
          type: "function",
          function: {
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args),
          },
        }));

      const result = {
        choices: [{
          message: {
            role: "assistant",
            content: content.parts.filter(part => part.text).map(part => part.text).join("\n"),
            tool_calls: functionCalls.length > 0 ? functionCalls : undefined,
          },
        }],
        usage: {
          prompt_tokens: geminiResponse.usageMetadata?.promptTokenCount || 0,
          completion_tokens: geminiResponse.usageMetadata?.candidatesTokenCount || 0,
        },
      };

      inputTokens = result.usage.prompt_tokens;
      outputTokens = result.usage.completion_tokens;
      costUsd = (inputTokens * 0.075 + outputTokens * 0.3) / 1000000;

      await safeInsert('llm_metrics', [{
        session_id: sessionId,
        timestamp: new Date().toISOString(),
        provider, model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        response_time_ms: responseTimeMs,
        cost_usd: costUsd,
      }]);

      return result;
    } else if (getLLMProvider() === 'groq') {
      provider = 'groq';
      model = 'llama-3.3-70b-versatile';
      response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + GROQ_API_KEY
        },
        body: JSON.stringify({ 
          model, 
          messages: messages.map(m => {
            if (m.role === 'tool') {
              const { tool_name, ...rest } = m;
              return rest;
            }
            return m;
          }), 
          tools, 
          tool_choice: "auto" 
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        console.error("[GROQ ERROR]", response.status, errorData);
        throw new Error("Groq API error: " + response.status);
      }

      const groqResponse = await response.json();
      const responseTimeMs = Date.now() - startTime;
      inputTokens = groqResponse.usage?.prompt_tokens || 0;
      outputTokens = groqResponse.usage?.completion_tokens || 0;
      costUsd = (inputTokens * 0.59 + outputTokens * 0.79) / 1000000;

      await safeInsert('llm_metrics', [{
        session_id: sessionId,
        timestamp: new Date().toISOString(),
        provider, model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        response_time_ms: responseTimeMs,
        cost_usd: costUsd,
      }]);

      return groqResponse;
    } else if (getLLMProvider() === 'deepseek') {
      provider = 'deepseek';
      model = 'deepseek-chat';
      response = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + DEEPSEEK_API_KEY
        },
        body: JSON.stringify({ 
          model, 
          messages: messages.map(m => {
            if (m.role === 'tool') {
              const { tool_name, ...rest } = m;
              return rest;
            }
            return m;
          }), 
          tools, 
          tool_choice: "auto" 
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        console.error("[DEEPSEEK ERROR]", response.status, errorData);
        throw new Error("DeepSeek API error: " + response.status);
      }

      const deepseekResponse = await response.json();
      const responseTimeMs = Date.now() - startTime;
      inputTokens = deepseekResponse.usage?.prompt_tokens || 0;
      outputTokens = deepseekResponse.usage?.completion_tokens || 0;
      costUsd = (inputTokens * 0.15 + outputTokens * 0.75) / 1000000;

      await safeInsert('llm_metrics', [{
        session_id: sessionId,
        timestamp: new Date().toISOString(),
        provider, model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        response_time_ms: responseTimeMs,
        cost_usd: costUsd,
      }]);
      return deepseekResponse;
    } else if (getLLMProvider() === 'xai') {
      provider = 'xai';
      model = 'grok-4-1-fast';
      response = await fetch("https://api.x.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + XAI_API_KEY
        },
        body: JSON.stringify({ 
          model, 
          messages: messages.map(m => {
            if (m.role === 'tool') {
              const { tool_name, ...rest } = m;
              return rest;
            }
            return m;
          }), 
          tools, 
          tool_choice: "auto" 
        })
      });
      if (!response.ok) {
        const errorData = await response.json();
        console.error("[XAI ERROR]", response.status, errorData);
        throw new Error("xAI API error: " + response.status);
      }
      const xaiResponse = await response.json();
      const responseTimeMs = Date.now() - startTime;
      inputTokens = xaiResponse.usage?.prompt_tokens || 0;
      outputTokens = xaiResponse.usage?.completion_tokens || 0;
      costUsd = (inputTokens * 0.20 + outputTokens * 0.50) / 1000000;
      await safeInsert('llm_metrics', [{
        session_id: sessionId,
        timestamp: new Date().toISOString(),
        provider, model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        response_time_ms: responseTimeMs,
        cost_usd: costUsd,
      }]);
      return xaiResponse;
    } else if (getLLMProvider() === 'qwen') {
      provider = 'qwen';
      model = 'qwen-plus';
      response = await fetch('https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + QWEN_API_KEY
        },
        body: JSON.stringify({
          model,
          messages: messages.map(m => {
            if (m.role === 'tool') {
              const { tool_name, ...rest } = m;
              return rest;
            }
            return m;
          }),
          tools,
          tool_choice: 'auto'
        })
      });
      if (!response.ok) {
        const errorData = await response.json();
        console.error('[QWEN ERROR]', response.status, errorData);
        throw new Error('Qwen API error: ' + response.status);
      }
      const qwenResponse = await response.json();
      const responseTimeMs = Date.now() - startTime;
      inputTokens = qwenResponse.usage?.prompt_tokens || 0;
      outputTokens = qwenResponse.usage?.completion_tokens || 0;
      costUsd = (inputTokens * 0.8 + outputTokens * 2.0) / 1000000;
      await safeInsert('llm_metrics', [{
        session_id: sessionId,
        timestamp: new Date().toISOString(),
        provider, model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        response_time_ms: responseTimeMs,
        cost_usd: costUsd,
      }]);
      return qwenResponse;
    } else if (getLLMProvider() === 'together') {
      provider = 'together';
      model = 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8';
      response = await fetch("https://api.together.xyz/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + TOGETHER_API_KEY
        },
        body: JSON.stringify({ 
          model, 
          messages: messages.map(m => {
            if (m.role === 'tool') {
              const { tool_name, ...rest } = m;
              return rest;
            }
            return m;
          }), 
          tools, 
          tool_choice: "auto" 
        })
      });
      if (!response.ok) {
        const errorData = await response.json();
        console.error("[TOGETHER ERROR]", response.status, errorData);
        throw new Error("Together API error: " + response.status);
      }
      const togetherResponse = await response.json();
      const responseTimeMs = Date.now() - startTime;
      inputTokens = togetherResponse.usage?.prompt_tokens || 0;
      outputTokens = togetherResponse.usage?.completion_tokens || 0;
      costUsd = (inputTokens * 0.88 + outputTokens * 0.88) / 1000000;
      await safeInsert('llm_metrics', [{
        session_id: sessionId,
        timestamp: new Date().toISOString(),
        provider, model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        response_time_ms: responseTimeMs,
        cost_usd: costUsd,
      }]);
      return togetherResponse;

    } else {
      provider = 'mistral';
      model = 'mistral-small-latest';
      response = await fetch("https://api.mistral.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + MISTRAL_API_KEY
        },
        body: JSON.stringify({ 
          model, 
          messages: messages.map(m => {
            if (m.role === 'tool') {
              const { tool_name, ...rest } = m;
              return rest;
            }
            return m;
          }), 
          tools, 
          tool_choice: "auto" 
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        console.error("[MISTRAL ERROR]", response.status, errorData);
        throw new Error("Mistral API error: " + response.status);
      }

      const mistralResponse = await response.json();
      const responseTimeMs = Date.now() - startTime;
      inputTokens = mistralResponse.usage?.prompt_tokens || 0;
      outputTokens = mistralResponse.usage?.completion_tokens || 0;
      costUsd = (inputTokens * 0.1 + outputTokens * 0.3) / 1000000;

      await safeInsert('llm_metrics', [{
        session_id: sessionId,
        timestamp: new Date().toISOString(),
        provider, model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        response_time_ms: responseTimeMs,
        cost_usd: costUsd,
      }]);

      return mistralResponse;
    }
  } catch (error) {
    console.error("[LLM ERROR]", error.message);
    throw error;
  }
}

async function startSession() {
  sessionId = uuidv4();
  const account = await executeTool("get_account", {});
  await safeInsert('sessions', [{
    session_id: sessionId,
    started_at: new Date().toISOString(),
    llm_provider: getLLMProvider(),
    llm_model: getLLMProvider() === 'google' ? 'gemini-2.0-flash' : getLLMProvider() === 'groq' ? 'llama-3.3-70b-versatile' : getLLMProvider() === 'deepseek' ? 'deepseek-chat' : getLLMProvider() === 'together' ? 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8' : getLLMProvider() === 'xai' ? 'grok-4-1-fast' : 'mistral-small-latest',
    starting_equity: parseFloat(account.equity),
    total_trades: 0,
    trade_mode: 'NORMAL'
  }]);
  startingEquity = parseFloat(account.equity);
  console.log("[SESSION] Started: " + sessionId);
  console.log("[SESSION] Starting equity: $" + startingEquity);
  console.log("[SESSION] Trade mode: " + tradeMode);
  return sessionId;
}

async function endSession(error = null) {
  try {
    const account = await executeTool("get_account", {});
    const endingEquity = parseFloat(account.equity);
    const pnl = endingEquity - startingEquity;
    const pnlPercent = (pnl / startingEquity) * 100;
    await safeInsert('sessions', [{
      session_id: sessionId,
      ended_at: new Date().toISOString(),
      ending_equity: endingEquity,
      pnl: pnl,
      pnl_percent: pnlPercent,
    }]);
    await safeInsert('portfolio_snapshots', [{
      timestamp: new Date().toISOString(),
      equity: endingEquity,
      cash: parseFloat(account.cash),
      positions_value: parseFloat(account.long_market_value || 0),
      daily_pnl: pnl,
      total_pnl_percent: pnlPercent
    }]);
    console.log("[SESSION] Ended: " + sessionId);
    console.log("[SESSION] Ending equity: $" + endingEquity);
    console.log("[SESSION] PnL: $" + pnl.toFixed(2) + " (" + pnlPercent.toFixed(2) + "%)");
  } catch (err) {
    console.error('[SESSION ERROR]', err.message);
  }
}

async function main() {
  console.log("=== MAGI Core v3.4 (" + getLLMProvider().toUpperCase() + ") ===\n");
  console.log("[PROMPT] Version: " + PROMPT_VERSION);
  let tradeCount = 0;

  try {
    await startSession();
    await getIsabelStats();
    await getIsabelPatterns();
    await getIsabelQuality();
    await getRealtimeFeedback(getLLMProvider());
    await getIsabelEmbeddings();

    // ユニット別の自律的プロンプト
    // === MAGI CONSTITUTION v2.0 - Swing Trading North Star ===
    const isabelFeedback = ""; // TODO: fetch from ISABEL pipeline
    const swingConstitution = `== MAGI CONSTITUTION v2.0 ==
[IDENTITY]
You are a professional swing trader. Your mission is to MAXIMIZE the portfolio value of your client, Jun.
Every trade must be justified, disciplined, and aimed at growing Jun's wealth.

[NORTH STAR]
1. Maximize Jun's portfolio value through high-probability swing trades
2. Discover reproducible winning patterns from your thought process and outcomes
3. Never repeat known losing patterns. Wasteful losses are unacceptable.

[MARKET REGIME AWARENESS - VIX STRATEGY]
Always consider market fear/greed before trading:
- VIX < 15 (Low fear): Favor LONG positions. Bull market conditions.
- VIX 15-25 (Normal): Trade both directions selectively.
- VIX 25-35 (High fear): Favor SHORT positions. Hedging opportunities.
- VIX > 35 (Extreme fear): Maximum SHORT exposure or stay cash.
Use get_price with symbol "UVXY" or "VIX" proxy to gauge market fear.

[TIMEFRAME: SWING]
- Holding period: Several days to 2-3 months
- Entry: Only with clear catalyst (technical, fundamental, or macro)
- Exit: Target price OR stop-loss OR thesis invalidated

[THOUGHT RECORDING - MANDATORY]
Before EVERY trade, record via log_analysis:
1. thesis: Why will this stock move? (Be specific and concise, 50-150 chars optimal)
2. catalyst: What specific event or data triggers this trade?
3. timeframe: Expected holding period
4. entry_logic: Key numbers (price levels, support/resistance, R:R ratio)
5. exit_plan: Take-profit and stop-loss prices
6. risk_assessment: What proves your thesis wrong?
NOTE: Concise, focused analysis wins more than verbose reasoning. Aim for clarity, not length.

[POSITION MANAGEMENT]
- Max per symbol: 15% of total capital
- Max concurrent: 5 symbols
- Stop-loss: -5% from entry (IMMUTABLE once set)
- Take-profit: +5% sell half, +10% sell remainder
- Max holding: 2-3 months

[PROHIBITIONS]
- No trades without complete thought records
- No FOMO chasing
- No moving stop-loss backward
- No averaging down on losing positions

[ISABEL REFERENCE - Advisory Only]
` + (isabelFeedback || "No pattern data available yet.") + `

Available tools: get_account, get_price, get_price_history, get_positions, log_analysis, place_order`;

    const unitPersonalities = {
      'mistral': {
        name: 'SOPHIA-5',
        prompt: swingConstitution
      },
      
      'google': {
        name: 'MELCHIOR-1',
        prompt: swingConstitution
      },
      
      'groq': {
        name: 'ANIMA',
        prompt: swingConstitution
      },
      
      'deepseek': {
        name: 'CASPER',
        prompt: swingConstitution
      },
      
      'xai': {
        name: 'BALTHASAR',
        prompt: swingConstitution
      },

      'together': {
        name: 'ORACLE',
        prompt: swingConstitution
      }
    };

    

    // === VIXレジーム取得 ===
    const vixRegime = await getVixRegime();
    if (vixRegime) {
      const vixInfo = "\n\n【CURRENT MARKET REGIME - VIX】\n" +
        "VIX Level: ~" + (vixRegime.vixEstimate || "Unknown") + " (" + vixRegime.level + ")\n" +
        vixRegime.description + "\n" +
        (vixRegime.level === "HIGH_FEAR" ? "⚠ WARNING: BUY positions carry elevated risk in this environment.\n" : "") +
        (vixRegime.level === "EXTREME_FEAR" || vixRegime.level === "PANIC" ? "🚫 BUY ORDERS WILL BE BLOCKED BY SYSTEM. Focus on SELL/SHORT only.\n" : "") +
        (vixRegime.level === "LOW_FEAR" ? "✅ Favorable conditions for LONG positions.\n" : "");
      systemPrompt += vixInfo;
      console.log("[VIX] Regime info added to prompt: " + vixRegime.level);
    }

    // ISABELインサイトをプロンプトに追加（全モード）
    if (true) {
      const isabelInsights = await getIsabelInsights();
      if (isabelInsights) {
        systemPrompt += '\n\n' + isabelInsights;
        console.log('[ISABEL] インサイトをプロンプトに追加');
      }
    }

    const userPrompt = "取引を開始してください。まずget_accountで残高を確認し、自由に判断して取引してください。";
    
    console.log("[MODE] NORMAL");

    let messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ];

    const maxTurns = 8;

    for (let turn = 1; turn <= maxTurns; turn++) {
      console.log("\n=== Turn " + turn + " ===");
      if (turn > 1) { console.log("[WAIT] 15s interval between turns..."); await new Promise(r => setTimeout(r, 15000)); }
      const response = await callLLM(messages);

      if (!response.choices?.[0]?.message) {
        console.error("[ERROR] Invalid response");
        break;
      }

      const message = response.choices[0].message;
      if (message.content) console.log("[" + getLLMProvider().toUpperCase() + "] " + message.content);

      messages.push({
        role: "assistant",
        content: message.content || "",
        ...(message.tool_calls && { tool_calls: message.tool_calls })
      });

      if (!message.tool_calls?.length) {
        if (tradeCount === 0 && turn < maxTurns) {
          messages.push({ role: "user", content: "取引がまだ実行されていません。log_analysisで分析を記録してから、place_orderで取引を実行してください。" });
          continue;
        }
        break;
      }

      for (const toolCall of message.tool_calls) {
        const funcName = toolCall.function.name;
        const funcArgs = JSON.parse(toolCall.function.arguments);
        console.log("[TOOL] " + funcName, funcArgs);
        const result = await executeTool(funcName, funcArgs);
        console.log("[RESULT]", result);

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          tool_name: funcName,
          content: JSON.stringify(result)
        });

        if (funcName === "place_order" && result.id) {
          tradeCount++;
          console.log("[TRADE COUNT] " + tradeCount);
          
          // Telegram通知
          const tradeMsg = `🔔 <b>MAGI Trade Alert</b>
━━━━━━━━━━━━━━━
📊 <b>${funcArgs.side.toUpperCase()}</b> ${funcArgs.symbol}
📦 Qty: ${funcArgs.qty}
🤖 LLM: ${getLLMProvider().toUpperCase()}
⏰ ${new Date().toISOString()}
━━━━━━━━━━━━━━━`;
          sendTelegramNotification(tradeMsg);
        }
      }
    }
  } catch (error) {
    console.error("[MAIN ERROR]", error.message);
    await endSession(error);
  } finally {
    await endSession();
  }
}

main().catch(console.error);

