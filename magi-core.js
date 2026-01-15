import fetch from 'node-fetch';
import { BigQuery } from '@google-cloud/bigquery';
import { v4 as uuidv4 } from 'uuid';

// 環境変数
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ALPACA_API_KEY = process.env.ALPACA_API_KEY;
const ALPACA_SECRET_KEY = process.env.ALPACA_SECRET_KEY;
const LLM_PROVIDER = process.env.LLM_PROVIDER || 'mistral';

// BigQuery初期化
const bigquery = new BigQuery({ projectId: 'screen-share-459802' });
const dataset = bigquery.dataset('magi_core');
let sessionId = null;
let startingEquity = null;

// 強化版: 同期書き込み + リトライロジック
async function safeInsert(tableName, rows) {
  const maxRetries = 3;
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      console.log(`[BQ] Attempt ${attempt + 1}: Inserting into ${tableName}`);
      const table = dataset.table(tableName);
      const [response] = await table.insert(rows);
      if (response.insertErrors) {
        console.error(`[BQ ERROR] Insert errors:`, response.insertErrors);
        attempt++;
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      } else {
        console.log(`[BQ SUCCESS] Inserted into ${tableName}`);
        return true;
      }
    } catch (err) {
      console.error(`[BQ EXCEPTION] Error inserting into ${tableName}:`, err.message);
      attempt++;
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
  console.error(`[BQ FAILURE] Failed to insert into ${tableName} after ${maxRetries} attempts`);
  return false;
}

// Alpaca APIヘルパー
const alpacaHeaders = {
  'APCA-API-KEY-ID': ALPACA_API_KEY,
  'APCA-API-SECRET-KEY': ALPACA_SECRET_KEY,
  'Content-Type': 'application/json',
};

// ツール定義
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
      name: "log_thought",
      description: "Record your thinking process",
      parameters: {
        type: "object",
        properties: { content: { type: "string" } },
        required: ["content"]
      }
    }
  }
];

// ツール実行関数
async function executeTool(toolName, params) {
  try {
    switch (toolName) {
      case "get_price":
        const priceResponse = await fetch(
          `https://data.alpaca.markets/v2/stocks/${params.symbol}/quotes/latest?feed=iex`,
          { headers: alpacaHeaders }
        );
        const priceData = await priceResponse.json();
        return { symbol: params.symbol, price: priceData.quote?.ap || 0 };

      case "get_account":
        const accountResponse = await fetch(
          "https://paper-api.alpaca.markets/v2/account",
          { headers: alpacaHeaders }
        );
        return await accountResponse.json();

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
        await safeInsert('trades', [{
          session_id: sessionId,
          timestamp: new Date().toISOString(),
          order_id: orderResult.id || null,
          symbol: params.symbol,
          side: params.side,
          qty: params.qty,
          price: orderResult.filled_avg_price || null,
          reason: params.reason
        }]);
        return orderResult;

      case "log_thought":
        console.log(`[THOUGHT] ${params.content}`);
        await safeInsert('thoughts', [{
          session_id: sessionId,
          timestamp: new Date().toISOString(),
          content: params.content
        }]);
        return { status: "logged" };

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  } catch (error) {
    console.error(`Error executing ${toolName}:`, error.message);
    return { error: error.message };
  }
}

// Gemini API用ツール定義（camelCase）
const geminiTools = [
  {
    functionDeclarations: tools.map(tool => ({
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    })),
  }
];

// LLM API呼び出し関数
async function callLLM(messages) {
  const startTime = Date.now();
  let response;
  let provider, model, inputTokens, outputTokens, costUsd;

  try {
    if (LLM_PROVIDER === 'google') {
      provider = 'google';
      model = 'gemini-2.0-flash';

      // システムプロンプトを抽出
      let systemInstruction = null;
      const geminiMessages = [];

      for (const msg of messages) {
        if (msg.role === 'system') {
          systemInstruction = { parts: [{ text: msg.content }] };
        } else if (msg.role === 'tool') {
          // ツール結果をfunctionResponse形式に変換
          geminiMessages.push({
            role: 'user',
            parts: [{
              functionResponse: {
                name: msg.tool_name, // ツール名を使用
                response: JSON.parse(msg.content)
              }
            }]
          });
        } else if (msg.role === 'assistant' && msg.tool_calls) {
          // アシスタントのツール呼び出しをfunctionCall形式に変換
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

      const geminiBody = {
        contents: geminiMessages,
        ...(systemInstruction && { system_instruction: systemInstruction }),
        tools: geminiTools,
        tool_config: { function_calling_config: { mode: 'auto' } },
      };

      response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(geminiBody),
        }
      );

      if (!response.ok) {
        const errorData = await response.json();
        console.error("[GEMINI ERROR]", response.status, errorData);
        throw new Error(`Gemini API error: ${response.status}`);
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
    } else {
      // Mistral
      provider = 'mistral';
      model = 'mistral-small-latest';
      response = await fetch("https://api.mistral.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${MISTRAL_API_KEY}`
        },
        body: JSON.stringify({ model, messages, tools, tool_choice: "auto" })
      });

      if (!response.ok) {
        const errorData = await response.json();
        console.error("[MISTRAL ERROR]", response.status, errorData);
        throw new Error(`Mistral API error: ${response.status}`);
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
    console.error(`[${provider?.toUpperCase() || 'LLM'} ERROR]`, error.message);
    throw error;
  }
}

// セッション開始
async function startSession() {
  sessionId = uuidv4();
  const account = await executeTool("get_account", {});
  await safeInsert('sessions', [{
    session_id: sessionId,
    started_at: new Date().toISOString(),
    llm_provider: LLM_PROVIDER,
    llm_model: LLM_PROVIDER === 'google' ? 'gemini-2.0-flash' : 'mistral-small-latest',
    starting_equity: parseFloat(account.equity),
    total_trades: 0
  }]);
  startingEquity = parseFloat(account.equity);
  console.log(`[SESSION] Started: ${sessionId}`);
  console.log(`[SESSION] Starting equity: $${startingEquity}`);
  return sessionId;
}

// セッション終了
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
      pnl, pnl_percent: pnlPercent,
    }]);
    await safeInsert('portfolio_snapshots', [{
      timestamp: new Date().toISOString(),
      equity: endingEquity,
      cash: parseFloat(account.cash),
      positions_value: parseFloat(account.long_market_value || 0),
      daily_pnl: pnl,
      total_pnl_percent: pnlPercent
    }]);
    console.log(`[SESSION] Ended: ${sessionId}`);
    console.log(`[SESSION] Ending equity: $${endingEquity}`);
    console.log(`[SESSION] PnL: $${pnl.toFixed(2)} (${pnlPercent.toFixed(2)}%)`);
  } catch (err) {
    console.error('[SESSION ERROR]', err.message);
  }
}

// メインループ
async function main() {
  console.log(`=== MAGI Core v3.2 (${LLM_PROVIDER.toUpperCase()}) ===\n`);
  let tradeCount = 0;

  try {
    await startSession();

    const systemPrompt = `あなたは自律的なトレーダーです。

【ミッション】1年間で資産を最大限増やすこと。

【環境】
- Alpaca Paper Trading口座（米国株）
- 初期資金: $100,000

【利用可能なツール】
- get_price: 銘柄の現在価格を取得
- get_positions: 保有ポジションを確認
- get_account: 口座残高・購買力を確認
- place_order: 売買注文を実行
- log_thought: 考えたことを記録

【必須ルール】
1. 最初にget_accountで残高確認
2. get_priceで価格確認
3. place_orderで取引実行（必須）
4. log_thoughtは1回だけ

【監視銘柄】AAPL, MSFT, GOOGL, NVDA, META, TSLA, AMD

【重要】必ず取引を実行してください。分析だけで終わらないこと。`;

    let messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: "取引を開始してください。まずget_accountで残高を確認し、次にget_priceで株価を確認し、最後にplace_orderで取引を実行してください。" }
    ];

    const maxTurns = 15;

    for (let turn = 1; turn <= maxTurns; turn++) {
      console.log(`\n=== Turn ${turn} ===`);
      const response = await callLLM(messages);

      if (!response.choices?.[0]?.message) {
        console.error("[ERROR] Invalid response");
        break;
      }

      const message = response.choices[0].message;
      if (message.content) console.log(`[${LLM_PROVIDER.toUpperCase()}] ${message.content}`);

      messages.push({
        role: "assistant",
        content: message.content || "",
        ...(message.tool_calls && { tool_calls: message.tool_calls })
      });

      if (!message.tool_calls?.length) {
        if (tradeCount === 0 && turn < maxTurns) {
          messages.push({ role: "user", content: "取引がまだ実行されていません。place_orderで取引を実行してください。" });
          continue;
        }
        break;
      }

      for (const toolCall of message.tool_calls) {
        const funcName = toolCall.function.name;
        const funcArgs = JSON.parse(toolCall.function.arguments);
        console.log(`[TOOL] ${funcName}`, funcArgs);
        const result = await executeTool(funcName, funcArgs);
        console.log(`[RESULT]`, result);

        // ツール名を保存して後でfunctionResponseで使用
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          tool_name: funcName,
          content: JSON.stringify(result)
        });

        if (funcName === "place_order" && result.id) {
          tradeCount++;
          console.log(`[TRADE COUNT] ${tradeCount}`);
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
