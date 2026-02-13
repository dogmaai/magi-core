
import { BigQuery } from '@google-cloud/bigquery';

const COHERE_API_KEY = process.env.COHERE_API_KEY;
const bigquery = new BigQuery({ projectId: 'screen-share-459802', location: 'US' });

async function embedText(text) {
  const response = await fetch('https://api.cohere.ai/v1/embed', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + COHERE_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'embed-multilingual-v3.0',
      texts: [text],
      input_type: 'search_document',
      truncate: 'END'
    })
  });
  
  if (!response.ok) {
    throw new Error('Cohere API error: ' + await response.text());
  }
  
  const data = await response.json();
  return data.embeddings[0];
}

async function main() {
  console.log('=== Sync Thought Embeddings (magi_core) ===');
  console.log('COHERE_API_KEY set:', !!COHERE_API_KEY);
  
  const [rows] = await bigquery.query({
    query: `
      SELECT DISTINCT
        CONCAT(t.session_id, '-', t.symbol) as id,
        t.session_id,
        t.symbol,
        th.reasoning,
        th.llm_provider,
        th.confidence,
        th.action,
        t.result as trade_result
      FROM \`screen-share-459802.magi_core.trades\` t
      JOIN \`screen-share-459802.magi_core.thoughts\` th 
        ON t.session_id = th.session_id AND t.symbol = th.symbol
      WHERE t.result IN ('WIN', 'LOSE')
        AND th.reasoning IS NOT NULL
        AND LENGTH(th.reasoning) > 20
        AND CONCAT(t.session_id, '-', t.symbol) NOT IN (
          SELECT id FROM \`screen-share-459802.magi_core.thought_embeddings\`
        )
      LIMIT 30
    `,
    location: 'US'
  });
  
  console.log('Found ' + rows.length + ' new thoughts to embed');
  
  if (rows.length === 0) {
    console.log('All synced!');
    return;
  }
  
  let success = 0;
  let failed = 0;
  
  for (const row of rows) {
    try {
      console.log('Embedding: ' + row.id.substring(0, 25) + '...');
      const embedding = await embedText(row.reasoning);
      
      await bigquery.query({
        query: `
          INSERT INTO \`screen-share-459802.magi_core.thought_embeddings\`
          (id, session_id, symbol, reasoning, llm_provider, confidence, action, trade_result, embedding, created_at)
          VALUES (@id, @session_id, @symbol, @reasoning, @llm_provider, @confidence, @action, @trade_result, @embedding, CURRENT_TIMESTAMP())
        `,
        params: {
          id: row.id,
          session_id: row.session_id,
          symbol: row.symbol,
          reasoning: row.reasoning,
          llm_provider: row.llm_provider,
          confidence: row.confidence,
          action: row.action,
          trade_result: row.trade_result,
          embedding: embedding
        },
        types: { embedding: ['FLOAT64'] },
        location: 'US'
      });
      
      success++;
      console.log('[' + success + '/' + rows.length + '] Done');
      
      await new Promise(r => setTimeout(r, 100));
    } catch (err) {
      failed++;
      console.error('Failed: ' + err.message);
    }
  }
  
  console.log('\nComplete! Success: ' + success + ', Failed: ' + failed);
}

main().catch(console.error);