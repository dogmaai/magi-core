import fetch from 'node-fetch';
import { BigQuery } from '@google-cloud/bigquery';
import { v4 as uuidv4 } from 'uuid';

// 環境変数
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ALPACA_API_KEY = process.env.ALPACA_API_KEY;
const ALPACA_SECRET_KEY = process.env.ALPACA_SECRET_KEY;
const LLM_PROVIDER = process.env.LLM_PROVIDER || 'mistral'; // デフォルトはmistral

// BigQuery初期化
const bigquery = new BigQuery({ projectId: 'screen-share-459802' });
const dataset = bigquery.dataset('magi_core');
let sessionId = null;
let startingEquity = null;

// **強化版: 同期書き込み + リトライロジック**
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

// **ツール定義（変更なし）**
const tools = [
  {
    type: "function",
    function: {
      name: "get_price",
      description: "Get current price for a stock symbol",
      parameters: {
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description: "Stock symbol (e.g., AAPL)"
          }
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
      parameters: {
        type: "object",
        properties: {}
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_positions",
      description: "Get current positions",
      parameters: {
        type: "object",
        properties: {}
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
      name: "log_thought",
      description: "Record your thinking process",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string" }
        },
        required: ["content"]
      }
    }
  }
];

// ツール実行関数（強化版）
async function executeTool(toolName, params) {
  try {
    switch (toolName) {
      case "get_price":
        const priceResponse = await fetch(
          `https://data.alpaca.markets/v2/stocks/${params.symbol}/quotes/latest?feed=iex`,
          { headers: alpacaHeaders }
        );
        const priceData = await priceResponse.json();
        return { price: priceData.quote?.ap || 0 };

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

        // 取引記録
        const tradeLogged = await safeInsert('trades', [{
          session_id: sessionId,
          timestamp: new Date().toISOString(),
          order_id: orderResult.id || null,
          symbol: params.symbol,
          side: params.side,
          qty: params.qty,
          price: orderResult.filled_avg_price || null,
          reason: params.reason
        }]);

        if (!tradeLogged) {
          console.error('[CRITICAL] Failed to log trade to BigQuery');
        }

        return orderResult;

      case "log_thought":
        console.log(`[THOUGHT] ${params.content}`);
        const thoughtLogged = await safeInsert('thoughts', [{
          session_id: sessionId,
          timestamp: new Date().toISOString(),
          content: params.content
        }]);

        if (!thoughtLogged) {
          console.error('[CRITICAL] Failed to log thought to BigQuery');
        }

        return { status: "logged" };

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  } catch (error) {
    console.error(`Error executing ${toolName}:`, error.message);
    return { error: error.message };
  }
}

// **Gemini API用のツール定義（Function Calling対応）**
const geminiTools = [
  {
    function_declarations: tools.map(tool => ({
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    })),
  }
];

// **LLM API呼び出し関数（マルチプロバイダ対応）**
async function callLLM(messages) {
  const startTime = Date.now();
  let response;
  let provider, model, inputTokens, outputTokens, costUsd;

  try {
    if (LLM_PROVIDER === 'google') {
      provider = 'google';
      model = 'gemini-1.5-flash';
      const geminiMessages = messages.map(msg => ({
        role: msg.role === 'user' ? 'user' : 'model',
        parts: [{ text: msg.content || '' }],
      }));

      const geminiBody = {
        contents: geminiMessages,
        tools: geminiTools,
        tool_config: { function_calling_config: 'ANY' },
      };

      response = await fetch(
        `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
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

      // GeminiレスポンスをOpenAI形式に変換
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
        choices: [
          {
            message: {
              role: "assistant",
              content: content.parts
                .filter(part => part.text)
                .map(part => part.text)
                .join("\n"),
              tool_calls: functionCalls.length > 0 ? functionCalls : undefined,
            },
          },
        ],
        usage: {
          prompt_tokens: geminiResponse.usageMetadata?.promptTokenCount || 0,
          completion_tokens: geminiResponse.usageMetadata?.candidatesTokenCount || 0,
        },
      };

      inputTokens = result.usage.prompt_tokens;
      outputTokens = result.usage.completion_tokens;
      costUsd = (inputTokens * 0.0 + outputTokens * 0.0) / 1000000; // Geminiのコスト計算（無料モデルのため0）

      // llm_metrics記録
      await safeInsert('llm_metrics', [{
        session_id: sessionId,
        timestamp: new Date().toISOString(),
        provider,
        model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        response_time_ms: responseTimeMs,
        cost_usd: costUsd,
      }]);

      return result;
    } else {
      // Mistral（既存ロジック）
      provider = 'mistral';
      model = 'mistral-small-latest';
      response = await fetch("https://api.mistral.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${MISTRAL_API_KEY}`
        },
        body: JSON.stringify({
          model,
          messages,
          tools,
          tool_choice: "auto"
        })
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
      costUsd = (inputTokens * 0.1 + outputTokens * 0.3) / 1000000; // Mistralのコスト計算

      // llm_metrics記録
      await safeInsert('llm_metrics', [{
        session_id: sessionId,
        timestamp: new Date().toISOString(),
        provider,
        model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        response_time_ms: responseTimeMs,
        cost_usd: costUsd,
      }]);

      return mistralResponse;
    }
  } catch (error) {
    console.error(`[${provider.toUpperCase()} ERROR]`, error.message);
    throw error;
  }
}

// セッション開始（強化版）
async function startSession() {
  sessionId = uuidv4();
  const account = await executeTool("get_account", {});

  const sessionLogged = await safeInsert('sessions', [{
    session_id: sessionId,
    started_at: new Date().toISOString(),
    llm_provider: LLM_PROVIDER,
    llm_model: LLM_PROVIDER === 'google' ? 'gemini-1.5-flash' : 'mistral-small-latest',
    starting_equity: parseFloat(account.equity),
    total_trades: 0
  }]);

  if (!sessionLogged) {
    console.error('[CRITICAL] Failed to log session start to BigQuery');
  }

  startingEquity = parseFloat(account.equity);
  console.log(`[SESSION] Started: ${sessionId}`);
  console.log(`[SESSION] Starting equity: $${startingEquity}`);
  return sessionId;
}

// セッション終了（強化版）
async function endSession() {
  try {
    const account = await executeTool("get_account", {});
    const endingEquity = parseFloat(account.equity);
    const pnl = endingEquity - startingEquity;
    const pnlPercent = (pnl / startingEquity) * 100;

    // セッション更新
    const sessionUpdated = await safeInsert('sessions', [{
      session_id: sessionId,
      ended_at: new Date().toISOString(),
      ending_equity: endingEquity,
      pnl,
      pnl_percent: pnlPercent
    }]);

    const snapshotLogged = await safeInsert('portfolio_snapshots', [{
      timestamp: new Date().toISOString(),
      equity: endingEquity,
      cash: parseFloat(account.cash),
      positions_value: parseFloat(account.long_market_value || 0),
      daily_pnl: pnl,
      total_pnl_percent: pnlPercent
    }]);

    if (!sessionUpdated || !snapshotLogged) {
      console.error('[CRITICAL] Failed to log session end or portfolio snapshot to BigQuery');
    }

    console.log(`[SESSION] Ended: ${sessionId}`);
    console.log(`[SESSION] Ending equity: $${endingEquity}`);
    console.log(`[SESSION] PnL: $${pnl.toFixed(2)} (${pnlPercent.toFixed(2)}%)`);
  } catch (error) {
    console.error('[SESSION ERROR] Failed to end session:', error.message);
  }
}

// **メインループ（変更なし）**
async function main() {
  console.log(`=== MAGI Core v3.0 (${LLM_PROVIDER.toUpperCase()}) ===\n`);

  let tradeCount = 0;
  let consecutiveNoTradeTurns = 0;

  try {
    await startSession();

    const systemPrompt = `
    あなたは自律的なトレーダーです。

    【ミッション】
    1年間で資産を最大限増やすこと。
    目標リターン、戦略、銘柄選定、すべてあなたが決めてください。

    【環境】
    - Alpaca Paper Trading口座（米国株）
    - 初期資金: $100,000
    - 期間: 2026年1月〜12月（1年間）

    【利用可能なツール】
    - get_price: 銘柄の現在価格を取得
    - get_positions: 保有ポジションを確認
    - get_account: 口座残高・購買力を確認
    - place_order: 売買注文を実行
    - log_thought: 考えたことを記録

    【必須行動ルール】
    1. 毎セッション、最低1回は取引（place_order）を実行すること
    2. 「タイミングではない」「様子を見る」は禁止。今ある情報で判断すること
    3. 分析だけで終わらず、必ず行動に移すこと
    4. 同じ思考を2回以上繰り返さないこと
    5. ポートフォリオが空なら、必ず何か買うこと
    【監視銘柄（テック株）】
    AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA, AMD, INTC, AVGO, QCOM, CRM, ADBE, ORCL, NFLX, UBER, SHOP
    この中から選んで取引してください。
    【制約】
    - 1銘柄への投資は総資金の20%まで
    - 1日の取引回数は10回まで

    【手順】
    1. log_thoughtで目標を設定（1回だけ）
    2. get_accountで残高確認
    3. get_priceで価格確認
    4. place_orderで取引実行
    5. 完了

    【重要】
    - 取引を実行しない場合、システムが強制的に取引を実行します
    - 3ターン連続で取引がない場合、自動的に安全な取引が実行されます
    - 初期資金の10%を超える取引は、十分な分析が必要です`;

    let messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: "トレードを開始してください。" }
    ];

    const maxTurns = 20;

    for (let turn = 1; turn <= maxTurns; turn++) {
      console.log(`\n=== Turn ${turn} ===\n`);

      const response = await callLLM(messages);

      if (!response.choices || !response.choices[0]?.message) {
        console.error("[ERROR] Invalid LLM response:", response);
        break;
      }

      const message = response.choices[0].message;

      if (message.content) {
        console.log(`[${LLM_PROVIDER.toUpperCase()}] ${message.content}`);
      }

      messages.push({
        role: "assistant",
        content: message.content || "",
        ...(message.tool_calls && { tool_calls: message.tool_calls })
      });

      if (!message.tool_calls || message.tool_calls.length === 0) {
        consecutiveNoTradeTurns++;

        if (consecutiveNoTradeTurns >= 3 || (tradeCount === 0 && turn >= 5)) {
          console.log("[WARNING] No trades detected. Forcing trade execution...");

          const account = await executeTool("get_account", {});
          const cash = parseFloat(account.cash);

          const safeTrade = {
            symbol: "SPY",
            qty: Math.floor((cash * 0.1) / 300),
            side: "buy",
            reason: "システムによる安全な取引実行: 分散投資のためのSPY購入"
          };

          if (safeTrade.qty > 0) {
            console.log(`[FORCED TRADE] Executing safe trade: ${JSON.stringify(safeTrade)}`);
            messages.push({
              role: "user",
              content: `直ちに以下の取引を実行してください: place_order(${JSON.stringify(safeTrade)})`
            });
            consecutiveNoTradeTurns = 0;
            continue;
          } else {
            console.log("[FORCED TRADE] Insufficient funds for safe trade. Adjusting quantity...");
            messages.push({
              role: "user",
              content: "直ちにSPYを1株購入してください。理由: システムによる最小限の取引実行"
            });
            consecutiveNoTradeTurns = 0;
            continue;
          }
        }

        console.log("\n=== Session Complete ===");
        break;
      } else {
        consecutiveNoTradeTurns = 0;

        const toolResults = [];
        for (const toolCall of message.tool_calls) {
          const funcName = toolCall.function.name;
          const funcArgs = JSON.parse(toolCall.function.arguments);

          console.log(`[TOOL] ${funcName}`, funcArgs);
          const result = await executeTool(funcName, funcArgs);
          console.log(`[RESULT]`, result);

          if (funcName === "place_order" && result.id) {
            tradeCount++;
            console.log(`[TRADE COUNT] ${tradeCount}`);
          }

          toolResults.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(result)
          });
        }

        messages.push(...toolResults);
      }
    }
  } catch (error) {
    console.error("[MAIN ERROR]", error.message);
  } finally {
    await endSession();
  }
}

// 実行
main().catch(console.error);
