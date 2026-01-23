import fetch from 'node-fetch';
import { BigQuery } from '@google-cloud/bigquery';
import { v4 as uuidv4 } from 'uuid';

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
  'together_SCALPING': 1     // BALTHASAR-6 (スキャルピング)
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
let tradeMode = null;

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
        return { symbol: params.symbol, price: priceData.quote?.ap || 0 };

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
          unit_name: getLLMProvider() === 'google' ? 'MELCHIOR-1' : getLLMProvider() === 'groq' ? 'ANIMA' : getLLMProvider() === 'deepseek' ? 'CASPER' : getLLMProvider() === 'together' ? 'BALTHASAR-6' : 'SOPHIA-5',
          _note: 'This is your allocated budget share.'
        };
      case "get_positions":
        const positionsResponse = await fetch(
          "https://paper-api.alpaca.markets/v2/positions",
          { headers: alpacaHeaders }
        );
        return await positionsResponse.json();

      
       case "place_order":
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
        
        await safeInsert('trades', [{
          session_id: sessionId,
          timestamp: new Date().toISOString(),
          order_id: orderResult.id || null,
          symbol: params.symbol,
          side: params.side,
          qty: params.qty,
          price: filledPrice ? parseFloat(filledPrice) : null,
          reason: params.reason,
          llm_provider: getLLMProvider(),
          unit_name: getLLMProvider() === 'google' ? 'MELCHIOR-1' : getLLMProvider() === 'groq' ? 'ANIMA' : getLLMProvider() === 'deepseek' ? 'CASPER' : getLLMProvider() === 'together' ? 'BALTHASAR-6' : 'SOPHIA-5',
          trade_mode: tradeMode
        }]);
        return orderResult; 

      case "log_analysis":
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
          unit_name: getLLMProvider() === 'google' ? 'MELCHIOR-1' : getLLMProvider() === 'groq' ? 'ANIMA' : getLLMProvider() === 'deepseek' ? 'CASPER' : getLLMProvider() === 'together' ? 'BALTHASAR-6' : 'SOPHIA-5',
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
          unit_name: getLLMProvider() === 'google' ? 'MELCHIOR-1' : getLLMProvider() === 'groq' ? 'ANIMA' : getLLMProvider() === 'deepseek' ? 'CASPER' : getLLMProvider() === 'together' ? 'BALTHASAR-6' : 'SOPHIA-5',
          symbol: params.symbol,
          action: params.action,
          reasoning: params.reasoning,
          hypothesis: params.hypothesis || null,
          confidence: params.confidence,
          concerns: params.concerns || null,
          trade_mode: tradeMode
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
          geminiMessages.push({
            role: 'user',
            parts: [{
              functionResponse: {
                name: msg.tool_name,
                response: JSON.parse(msg.content)
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
  let tradeCount = 0;

  try {
    await startSession();

    const isScalping = process.env.SCALPING_MODE === 'true';
    
    const scalpingPrompt = `あなたは超短期スキャルピングトレーダーです。

【ミッション】
素早く小さな利益を積み重ねる。深い分析より速度重視。

【ルール】
- 考えすぎない。直感で判断
- 1回の取引は$50以下
- 理由は一言でOK（例：「上昇中」「出来高増」）
- 複数銘柄を素早くチェックして、動きのある銘柄を狙う

【フロー】
1. get_account → 残高確認（1回だけ）
2. get_price → 複数銘柄を連続でチェック（AAPL, NVDA, TSLA, AMD）
3. 最も動きがありそうな銘柄を選ぶ
4. place_order → 即座に注文（log_analysisは省略OK）

【判断基準】
- 価格が切りの良い数字に近い
- 直近の動きがありそう
- それだけ。深く考えない。

【禁止】
- 長い分析文を書くこと
- 複数の指標を計算すること
- 迷うこと`;

    const normalPrompt = `あなたは自律的なトレーダーです。

【ミッション】
1年間で資産を最大限増やすこと。
あなた独自の戦略と判断で取引してください。

【環境】
- Alpaca Paper Trading口座（米国株）
- 初期資金: $100,000

【利用可能なツール】
- get_price: 銘柄の現在価格を取得
- get_positions: 保有ポジションを確認
- get_account: 口座残高・購買力を確認
- log_analysis: 分析結果を記録（取引前に必須）
- place_order: 売買注文を実行

【監視銘柄】AAPL, MSFT, GOOGL, NVDA, META, TSLA, AMD

【log_analysisの記録について】
あなたの思考プロセスは後で機械学習に使用します。
以下の点を意識して、できるだけ詳細に記録してください：

- なぜその判断に至ったか（具体的な数値や根拠）
- 何が起こると予測しているか（価格目標と期限）
- どんなリスクを認識しているか
- 他の選択肢を検討したか

【お願い】
「上昇傾向」「買いシグナル」等の曖昧な表現より、
具体的な数値（変動率、価格、比率）を使うと分析精度が上がります。

自由に考え、あなたの判断で取引してください。`;

    const systemPrompt = isScalping ? scalpingPrompt : normalPrompt;
    const userPrompt = isScalping 
      ? "スキャルピング開始。素早く判断して取引せよ。"
      : "取引を開始してください。get_account → get_price → log_analysis → place_order の順で実行してください。log_analysisでは必ず詳細な分析理由を記録してください。";
    
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

