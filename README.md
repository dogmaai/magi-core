# MAGI Core v3.6

Autonomous Trading Agent powered by multiple LLMs.

## Overview

MAGI discovers winning trading algorithms by analyzing LLM thought patterns and their correlation with trading outcomes.

**The goal is not trading profit, but discovering reproducible winning patterns.**

## LLM Units

| Unit | Provider | Model | Role |
|------|----------|-------|------|
| SOPHIA-5 | Mistral | mistral-small-latest | Normal trading |
| MELCHIOR-1 | Gemini | gemini-2.0-flash | Normal trading |
| ANIMA | Groq | llama-3.3-70b-versatile | Normal/Scalping |
| CASPER | DeepSeek | deepseek-chat | Normal trading |
| BALTHASAR-6 | Together | Llama-3.3-70B-Instruct-Turbo | Scalping |

## Architecture
```
┌─────────────────────────────────────────────────────────────┐
│                    MAGI System v3.6                          │
├─────────────────────────────────────────────────────────────┤
│  [Cloud Scheduler] → [Cloud Run Jobs] → [BigQuery]          │
│                                                              │
│  Each LLM autonomously:                                      │
│  1. Analyzes market data                                     │
│  2. Logs detailed reasoning (thoughts table)                 │
│  3. Executes trades (trades table)                           │
│                                                              │
│  [ISABEL] analyzes accumulated data to extract:              │
│  - Winning patterns                                          │
│  - Failure patterns                                          │
│  - Reproducible algorithms                                   │
└─────────────────────────────────────────────────────────────┘
```

## Infrastructure

- **Cloud Run Jobs**: Autonomous LLM execution
- **Cloud Scheduler**: Automated triggers (Mon-Fri)
- **BigQuery**: Thought/trade data persistence
- **Alpaca Paper Trading**: $100k virtual funds

## Data Flow

1. **Phase 1**: Data accumulation (current)
2. **Phase 2**: Outcome labeling (WIN/LOSE after 7 days)
3. **Phase 3**: Pattern analysis with ISABEL (Cohere)
4. **Phase 4**: Algorithm generation

## License

MIT

## Author

Dogma AI - Jun
