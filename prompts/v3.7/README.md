# MAGI System Prompts v3.7

## 概要
各LLMユニットのシステムプロンプト（北極星/憲法）

## 変更履歴
- v3.7: ISABEL Level 3（Quality Analysis）追加
- v3.6: ISABEL v2（Keyword Pattern Analysis）追加
- v3.5: ISABEL動的統計導入

## ファイル構成
- SOPHIA-5.md (Mistral) - 戦略家
- MELCHIOR-1.md (Google) - 科学者
- ANIMA.md (Groq) - 直感型トレーダー
- CASPER.md (DeepSeek) - リスク管理者
- ORACLE.md (Together) - スキャルピング専門

## 動的挿入される情報
- `${generateStrengthText(provider)}` - BUY/SELL勝率
- `${generateSymbolText()}` - 銘柄別勝率
- `${generatePatternText()}` - 思考パターン分析
- `${generateQualityText()}` - 分析品質スコア
- `${generateAvoidText(provider)}` - 避けるべきパターン
