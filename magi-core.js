if (LLM_PROVIDER === 'google') {
  provider = 'google';
  model = 'gemini-1.5-flash'; // 最新の安定版モデル（Function Calling対応）

  // メッセージ形式をGemini API仕様に変換
  const geminiMessages = messages.map(msg => {
    // ツール呼び出し結果を含むメッセージの場合
    if (msg.role === 'tool') {
      return {
        role: 'function',
        parts: [{ text: msg.content }]
      };
    }
    // アシスタントメッセージ（ツール呼び出しを含む場合）
    else if (msg.role === 'assistant' && msg.tool_calls) {
      return {
        role: 'model',
        parts: [
          { text: msg.content || '' },
          ...(msg.tool_calls || []).map(toolCall => ({
            functionResponse: {
              name: toolCall.function.name,
              response: { result: JSON.parse(toolCall.function.arguments) }
            }
          }))
        ]
      };
    }
    // 通常のユーザー/アシスタントメッセージ
    else {
      return {
        role: msg.role === 'user' ? 'user' : 'model',
        parts: [{ text: msg.content || '' }]
      };
    }
  });

  // リクエストボディ（Gemini API v1仕様）
  const geminiBody = {
    contents: geminiMessages,
    tools: {
      function_declarations: tools.map(tool => ({
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      }))
    },
    tool_config: {
      function_calling_config: "ANY"  // 或いは"AUTO"
    }
  };

  // API呼び出し
  const startTime = Date.now();
  try {
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
      throw new Error(`Gemini API error: ${response.status} - ${errorData.error?.message || 'Unknown error'}`);
    }

    const geminiResponse = await response.json();
    const responseTimeMs = Date.now() - startTime;

    // レスポンス変換（OpenAI形式に統一）
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
          content: content.parts
            .filter(part => part.text)
            .map(part => part.text)
            .join("\n"),
          tool_calls: functionCalls.length > 0 ? functionCalls : undefined,
        },
      }],
      usage: {
        prompt_tokens: geminiResponse.usageMetadata?.promptTokenCount || 0,
        completion_tokens: geminiResponse.usageMetadata?.candidatesTokenCount || 0,
      },
    };

    // メトリクス記録
    const inputTokens = result.usage.prompt_tokens;
    const outputTokens = result.usage.completion_tokens;
    const costUsd = (inputTokens * 0.5 + outputTokens * 1.5) / 1000000; // gemini-1.5-flashの料金（$0.5/1M input, $1.5/1M output）

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

  } catch (error) {
    console.error(`[GEMINI API ERROR]`, error.message);

    // フォールバック: Mistralに切り替え（オプショナル）
    if (MISTRAL_API_KEY) {
      console.log("[FALLBACK] Switching to Mistral due to Gemini error");
      provider = 'mistral';
      model = 'mistral-small-latest';
      response = await fetch("https://api.mistral.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${MISTRAL_API_KEY}`
        },
        body: JSON.stringify({
          model: 'mistral-small-latest',
          messages: messages.slice(0, -1), // 最後のメッセージを除外してリトライ
          tools,
          tool_choice: "auto"
        })
      });
      // Mistralレスポンス処理は既存ロジックを流用
    } else {
      throw error;
    }
  }
}
