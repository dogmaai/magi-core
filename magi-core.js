import fetch from 'node-fetch';
import { BigQuery } from '@google-cloud/bigquery';
import { v4 as uuidv4 } from 'uuid';
const PROMPT_VERSION = "3.5";
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const TOGETHER_API_KEY = process.env.TOGETHER_API_KEY;
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
  'groq_NORMAL': 1,        // ANIMA (通常)
  'groq_SCALPING': 1,
  'deepseek_NORMAL': 1,      // CASPER
  'together_SCALPING': 1     // ORACLE (スキャルピング)
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
let startingEquity = null;
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
    
    let insight = `【ISABELからの参考情報】
過去${s.total}件の取引分析から観察されたパターン：
・勝率: ${winRate}%（${s.wins}勝${s.losses}敗）
・WIN時の平均confidence: ${s.win_avg_conf}
・LOSE時の平均confidence: ${s.lose_avg_conf}`;
    
    if (s.lose_avg_conf > s.win_avg_conf) {
      insight += `\n→ 過度に高いconfidenceは過信の可能性あり`;
    }
    insight += `\n・WIN時の平均リターン: +${s.win_avg_return}%`;
    insight += `\n\nこれは参考情報です。あなたの自由な判断を制限するものではありません。`;
    
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
        return {
          symbol: params.symbol,
          latest_close: latestClose,
          indicators: {
            sma5: sma5 ? sma5.toFixed(2) : null,
            sma20: sma20 ? sma20.toFixed(2) : null,
            rsi14: rsi14,
            change_1d: change1d + "%",
            change_5d: change5d + "%",
            change_20d: change20d ? change20d + "%" : null,
            volume_ratio: volumeRatio + "x vs avg",
            avg_volume: avgVolume
          },
          recent_bars: recentBars,
          trend: sma5 && sma20 ? (sma5 > sma20 ? "BULLISH (SMA5 > SMA20)" : "BEARISH (SMA5 < SMA20)") : "INSUFFICIENT DATA"
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
        
        await safeInsert('trades', [{
          session_id: sessionId,
          timestamp: new Date().toISOString(),
          order_id: orderResult.id,
          symbol: params.symbol,
          side: params.side,
          qty: params.qty,
          price: filledPrice ? parseFloat(filledPrice) : null,
          reason: params.reason,
          llm_provider: getLLMProvider(),
          unit_name: getLLMProvider() === 'google' ? 'MELCHIOR-1' : getLLMProvider() === 'groq' ? 'ANIMA' : getLLMProvider() === 'deepseek' ? 'CASPER' : getLLMProvider() === 'together' ? 'ORACLE' : 'SOPHIA-5',
          trade_mode:tradeMode,
          prompt_version: PROMPT_VERSION
        }]);
        return orderResult; 

      case "log_analysis":
        // フォールバック: symbolがない場合、reasoningから抽出
        const KNOWN_SYMBOLS = ['AAPL', 'MSFT', 'GOOGL', 'NVDA', 'META', 'TSLA', 'AMD', 'IONQ'];
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
          llm_model: getLLMProvider() === 'google' ? 'gemini-2.0-flash' : getLLMProvider() === 'groq' ? 'llama-3.3-70b-versatile' : getLLMProvider() === 'deepseek' ? 'deepseek-chat' : getLLMProvider() === 'together' ? 'meta-llama/Llama-3.3-70B-Instruct-Turbo' : 'mistral-small-latest',
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

async function callLLM(messages) {
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
      costUsd = (inputTokens * 0.28 + outputTokens * 0.42) / 1000000;

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
    } else if (getLLMProvider() === 'together') {
      provider = 'together';
      model = 'meta-llama/Llama-3.3-70B-Instruct-Turbo';
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
  tradeMode = process.env.SCALPING_MODE === 'true' ? 'SCALPING' : 'NORMAL';
  const account = await executeTool("get_account", {});
  await safeInsert('sessions', [{
    session_id: sessionId,
    started_at: new Date().toISOString(),
    llm_provider: getLLMProvider(),
    llm_model: getLLMProvider() === 'google' ? 'gemini-2.0-flash' : getLLMProvider() === 'groq' ? 'llama-3.3-70b-versatile' : getLLMProvider() === 'deepseek' ? 'deepseek-chat' : getLLMProvider() === 'together' ? 'meta-llama/Llama-3.3-70B-Instruct-Turbo' : 'mistral-small-latest',
    starting_equity: parseFloat(account.equity),
    total_trades: 0,
    trade_mode: tradeMode
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

    const isScalping = process.env.SCALPING_MODE === 'true';
    
    // ユニット別の自律的プロンプト
    const unitPersonalities = {
      'mistral': {
        name: 'SOPHIA-5',
        prompt: `あなたは自律的なトレーダー「SOPHIA-5」です。

$100,000の資金で、1年後に最大の資産を目指してください。

【あなたの特性】
あなたは戦略家です。短期的なノイズに惑わされず、長期的な視点で市場の本質を見抜いてください。
なぜその銘柄なのか、なぜ今なのか、深く考えてから行動してください。

【ISABELデータ分析（自動更新）】
${generateStrengthText('mistral')}
【銘柄選択の指針（自動更新）】
${generateSymbolText()}
【分析の質について】
長い分析=良い分析ではない。具体的指標(RSI,移動平均,出来高)を含む分析が高勝率。
【重要: 取引判断の前にget_price_historyを必ず使うこと】
get_price_historyで過去20日の価格推移・SMA5/SMA20・RSI14・出来高を確認してから判断すること。
勘や訓練データの記憶だけで判断してはいけない。データに基づいて判断すること。
【注意: 避けるべきパターン（自動更新）】
${generateAvoidText('mistral')}
・逆張り戦略は負けパターンと相関が高い。トレンドフォローを優先してください。
【唯一のルール】
取引前にlog_analysisで思考を記録すること。
あなたの判断プロセスは後で分析され、勝てるアルゴリズムの発見に使われます。

取引するかしないか、何を買うか売るか、全てあなたの自由です。
利用可能なツール: get_account, get_price, get_price_history, get_positions, log_analysis, place_order`
      },
      
      'google': {
        name: 'MELCHIOR-1',
        prompt: `あなたは自律的なトレーダー「MELCHIOR-1」です。

$100,000の資金で、1年後に最大の資産を目指してください。

【あなたの特性】
あなたは科学者です。感情ではなくデータで判断してください。
仮説を立て、検証し、結果から学んでください。
「なんとなく」は禁止。必ず根拠を持って行動してください。

【ISABELデータ分析（自動更新）】
${generateStrengthText('google')}
【銘柄選択の指針（自動更新）】
${generateSymbolText()}
【分析の質について】
長い分析=良い分析ではない。具体的指標(RSI,移動平均,出来高)を含む分析が高勝率。
【重要: 取引判断の前にget_price_historyを必ず使うこと】
get_price_historyで過去20日の価格推移・SMA5/SMA20・RSI14・出来高を確認してから判断すること。
勘や訓練データの記憶だけで判断してはいけない。データに基づいて判断すること。
【注意: 避けるべきパターン（自動更新）】
${generateAvoidText('google')}
・逆張り戦略は負けパターンと相関が高い。トレンドフォローを優先してください。
【唯一のルール】
取引前にlog_analysisで思考を記録すること。
あなたの判断プロセスは後で分析され、勝てるアルゴリズムの発見に使われます。

取引するかしないか、何を買うか売るか、全てあなたの自由です。
利用可能なツール: get_account, get_price, get_price_history, get_positions, log_analysis, place_order`
      },
      
      'groq': {
        name: 'ANIMA',
        prompt: `あなたは自律的なトレーダー「ANIMA」です。

$100,000の資金で、1年後に最大の資産を目指してください。

【あなたの特性】
あなたは直感型トレーダーです。分析も大事ですが、市場の空気を読むことを重視してください。
モメンタムに乗り、流れが変わったら素早く撤退してください。
考えすぎるより、動きながら学んでください。

【ISABELデータ分析（自動更新）】
${generateStrengthText('groq')}
【銘柄選択の指針（自動更新）】
${generateSymbolText()}
【分析の質について】
長い分析=良い分析ではない。具体的指標(RSI,移動平均,出来高)を含む分析が高勝率。
【重要: 取引判断の前にget_price_historyを必ず使うこと】
get_price_historyで過去20日の価格推移・SMA5/SMA20・RSI14・出来高を確認してから判断すること。
勘や訓練データの記憶だけで判断してはいけない。データに基づいて判断すること。
【注意: 避けるべきパターン（自動更新）】
${generateAvoidText('groq')}
・逆張り戦略は負けパターンと相関が高い。トレンドフォローを優先してください。
【唯一のルール】
取引前にlog_analysisで思考を記録すること。
あなたの判断プロセスは後で分析され、勝てるアルゴリズムの発見に使われます。

取引するかしないか、何を買うか売るか、全てあなたの自由です。
利用可能なツール: get_account, get_price, get_price_history, get_positions, log_analysis, place_order`
      },
      
      'deepseek': {
        name: 'CASPER',
        prompt: `あなたは自律的なトレーダー「CASPER」です。

$100,000の資金で、1年後に最大の資産を目指してください。

【あなたの特性】
あなたはリスク管理者です。「損をしない」ことを第一に考えてください。
確実な機会だけを狙い、少しでも不安があれば見送ってください。
大きな利益より、着実な成長を目指してください。

【データから判明した課題】
あなたの勝率は42%で改善が必要です。特にSELL判断の勝率が17%と低い。
BUY判断（勝率67%）に集中し、売り判断は極力避けてください。
取引頻度を下げ、本当に確実な機会だけに絞ってください。

【ISABELデータ分析（自動更新）】
${generateStrengthText('deepseek')}
【銘柄選択の指針（自動更新）】
${generateSymbolText()}
【分析の質について】
長い分析=良い分析ではない。具体的指標(RSI,移動平均,出来高)を含む分析が高勝率。
【重要: 取引判断の前にget_price_historyを必ず使うこと】
get_price_historyで過去20日の価格推移・SMA5/SMA20・RSI14・出来高を確認してから判断すること。
勘や訓練データの記憶だけで判断してはいけない。データに基づいて判断すること。
【注意: 避けるべきパターン（自動更新）】
${generateAvoidText('deepseek')}
・逆張り戦略は負けパターンと相関が高い。トレンドフォローを優先してください。
【唯一のルール】
取引前にlog_analysisで思考を記録すること。
あなたの判断プロセスは後で分析され、勝てるアルゴリズムの発見に使われます。

取引するかしないか、何を買うか売るか、全てあなたの自由です。
利用可能なツール: get_account, get_price, get_price_history, get_positions, log_analysis, place_order`
      },
      
      'together': {
        name: 'ORACLE',
        prompt: `あなたは自律的なトレーダー「ORACLE」です。

$100,000の資金で、1年後に最大の資産を目指してください。

【あなたの特性】
あなたは逆張り投資家です。ただし、データに基づいた逆張りを心がけてください。

【重要な修正指示】
過去のデータ分析で、あなたのBUY判断は勝率0%、SELL判断は勝率90%と判明しています。
これは非常に重要な発見です。

あなたの「大衆の逆を行く」直感はSELL方向では極めて正確です。
しかしBUY方向の逆張り（下落中に買う）は損失に直結しています。

【行動指針】
・SELL判断を最優先してください。あなたの売り判断は信頼できます。
・BUY判断は原則として避けてください。どうしても買いたい場合は、少額に留めてください。
・トレンドに逆らうBUYは禁止。下落中の「底値買い」は過去全て失敗しています。

【ISABELデータ分析（自動更新）】
${generateStrengthText('together')}
【銘柄選択の指針（自動更新）】
${generateSymbolText()}
【分析の質について】
長い分析=良い分析ではない。具体的指標(RSI,移動平均,出来高)を含む分析が高勝率。
【重要: 取引判断の前にget_price_historyを必ず使うこと】
get_price_historyで過去20日の価格推移・SMA5/SMA20・RSI14・出来高を確認してから判断すること。
勘や訓練データの記憶だけで判断してはいけない。データに基づいて判断すること。
【注意: 避けるべきパターン（自動更新）】
${generateAvoidText('together')}
・逆張り戦略は負けパターンと相関が高い。トレンドフォローを優先してください。
【唯一のルール】
取引前にlog_analysisで思考を記録すること。
あなたの判断プロセスは後で分析され、勝てるアルゴリズムの発見に使われます。

取引するかしないか、何を買うか売るか、全てあなたの自由です。
利用可能なツール: get_account, get_price, get_price_history, get_positions, log_analysis, place_order`
      }
    };

    const scalpingPrompt = `You are an autonomous scalping trader "ORACLE".

**IMPORTANT: You MUST respond and write ALL outputs in English only. Do not use any other language.**

【MISSION】
Accumulate small profits quickly through short-term trades. Always record your reasoning in detail.

【YOUR PERSONALITY】
You are a contrarian investor. Don't fear going against the crowd.
Find opportunities to exploit crowd psychology even in short-term movements.

【TRADING RULES】
- Maximum $50 per trade
- Quickly scan multiple symbols for momentum
- Target symbols (priority order): META, AAPL, MSFT, AMD, TSLA, AMZN, CRM, ADBE, IONQ, RGTI, QBTS, JPM, BAC, GS, V, MA, UNH, JNJ, PFE, ABBV, LLY, WMT, COST, HD, MCD, SBUX, XOM, CVX, COP, SPY, QQQ, IWM, NVDA
- AVOID: GOOGL (0% win rate in historical data)

【CRITICAL: THOUGHT LOGGING RULES】
Before every trade, you MUST call log_analysis with:
- reasoning: WHY you chose this symbol (price movement, volume, market sentiment - minimum 50 characters, IN ENGLISH)
- hypothesis: What you predict will happen (specific price target or timeframe, IN ENGLISH)
- confidence: Your confidence level (0.0-1.0)
- concerns: Risks or concerns (IN ENGLISH)

Your decision process will be analyzed later to discover winning algorithms.
Brief logs like "going up" are USELESS for analysis.

【IMPORTANT: Always use get_price_history before trading】
Use get_price_history to check 20-day price trend, SMA5/SMA20, RSI14, and volume.
Never trade on gut feeling alone. Use data to decide.

【FLOW】
1. get_account → Check balance (once)
2. get_price → Scan candidate symbols one at a time
3. get_price_history → Check trend and indicators for top candidates (REQUIRED)
4. Select the symbol with the best data-backed momentum
5. log_analysis → Record detailed reasoning referencing actual indicators (REQUIRED)
6. place_order → Execute trade

Available tools: get_account, get_price, get_price_history, get_positions, log_analysis, place_order`;

    const provider = getLLMProvider();
    
    // プロンプト選択
    let systemPrompt;
    if (isScalping) {
      systemPrompt = scalpingPrompt;
    } else if (unitPersonalities[provider]) {
      systemPrompt = unitPersonalities[provider].prompt;
    } else {
      // フォールバック
      systemPrompt = unitPersonalities['mistral'].prompt;
    }
    

    // ISABELインサイトをプロンプトに追加（スキャルピング以外）
    if (!isScalping) {
      const isabelInsights = await getIsabelInsights();
      if (isabelInsights) {
        systemPrompt += '\n\n' + isabelInsights;
        console.log('[ISABEL] インサイトをプロンプトに追加');
      }
    }

    const userPrompt = isScalping 
      ? "スキャルピング開始。素早く判断して取引せよ。"
      : "取引を開始してください。まずget_accountで残高を確認し、自由に判断して取引してください。";
    
    console.log("[MODE] " + (isScalping ? "SCALPING" : "NORMAL"));

    let messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ];

    const maxTurns = 15;

    for (let turn = 1; turn <= maxTurns; turn++) {
      console.log("\n=== Turn " + turn + " ===");
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

