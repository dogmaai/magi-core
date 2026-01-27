#!/usr/bin/env python3
"""ISABEL: 埋め込み分析のみ"""

import os
import cohere
from google.cloud import bigquery
import numpy as np
from numpy.linalg import norm

co = cohere.ClientV2(os.environ.get('COHERE_API_KEY'))

def main():
    client = bigquery.Client()
    query = """
    SELECT symbol, side, result, return_pct, confidence, unit_name, reasoning, hypothesis
    FROM magi_core.isabel_analysis
    WHERE current_price IS NOT NULL AND reasoning IS NOT NULL
    """
    rows = list(client.query(query))
    
    win_data, lose_data = [], []
    for row in rows:
        text = f"{row.reasoning or ''}"
        data = {"symbol": row.symbol, "confidence": row.confidence, "return": row.return_pct, "text": text[:200]}
        if row.result == 'WIN':
            win_data.append(data)
        elif row.result == 'LOSE':
            lose_data.append(data)
    
    print("=" * 60)
    print("ISABEL PATTERN ANALYSIS")
    print("=" * 60)
    
    # 埋め込み計算
    all_texts = [d["text"] for d in win_data] + [d["text"] for d in lose_data]
    response = co.embed(
        texts=all_texts,
        model="embed-multilingual-v3.0",
        input_type="classification",
        embedding_types=["float"]
    )
    
    embeddings = response.embeddings.float_
    win_embeds = embeddings[:len(win_data)]
    lose_embeds = embeddings[len(win_data):]
    
    win_center = np.mean(win_embeds, axis=0)
    lose_center = np.mean(lose_embeds, axis=0)
    similarity = np.dot(win_center, lose_center) / (norm(win_center) * norm(lose_center))
    
    print(f"\n【統計サマリー】")
    print(f"WIN: {len(win_data)}件, LOSE: {len(lose_data)}件")
    print(f"WIN vs LOSE 思考類似度: {similarity:.3f}")
    print(f"  → 0.826は高い類似度。WINとLOSEの思考パターンは似ている")
    print(f"  → 思考内容ではなく「何を買うか」が結果を決めている可能性")
    
    print(f"\n【WINパターン（{len(win_data)}件）】")
    print(f"平均confidence: {np.mean([d['confidence'] for d in win_data if d['confidence']]):.2f}")
    print(f"平均return: {np.mean([d['return'] for d in win_data]):.2f}%")
    print(f"銘柄: {set(d['symbol'] for d in win_data)}")
    
    print(f"\n【LOSEパターン（{len(lose_data)}件）】")
    if lose_data:
        print(f"平均confidence: {np.mean([d['confidence'] for d in lose_data if d['confidence']]):.2f}")
        print(f"平均return: {np.mean([d['return'] for d in lose_data]):.2f}%")
        print(f"銘柄: {set(d['symbol'] for d in lose_data)}")
    
    print(f"\n【WIN思考サンプル】")
    for d in win_data[:3]:
        print(f"  {d['symbol']}: conf={d['confidence']} ret={d['return']:.1f}%")
        print(f"    {d['text'][:100]}...")
    
    print(f"\n【LOSE思考サンプル】")
    for d in lose_data:
        print(f"  {d['symbol']}: conf={d['confidence']} ret={d['return']:.1f}%")
        print(f"    {d['text'][:100]}...")

if __name__ == "__main__":
    main()
