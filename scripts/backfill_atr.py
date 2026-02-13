# -*- coding: utf-8 -*-
#
# Copyright 2024 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""
This one-time script backfills the `atr_at_execution` column for historical 
trades in the BigQuery `trades` table.

It fetches trades where `atr_at_execution` is NULL, retrieves historical price 
bars from Alpaca for the period leading up to the trade, calculates the 
14-day ATR (Average True Range), and updates the BigQuery record.

This is a necessary step to enable volatility-adjusted evaluation on trades
that were logged before the `magi-core.js` application started recording the ATR.

Prerequisites:
- Google Cloud SDK authenticated (`gcloud auth application-default login`)
- Alpaca API credentials set as environment variables.
- Required Python packages installed:
  - pip install alpaca-trade-api google-cloud-bigquery pandas
"""

import os
from datetime import datetime, timedelta, timezone
import alpaca_trade_api as tradeapi
from google.cloud import bigquery
import pandas as pd

# --- Configuration ---
GCP_PROJECT_ID = "screen-share-459802"
BIGQUERY_DATASET = "magi_core"
BIGQUERY_TABLE = "trades"
TABLE_ID = f"{GCP_PROJECT_ID}.{BIGQUERY_DATASET}.{BIGQUERY_TABLE}"
ALPACA_API_BASE_URL = "https://paper-api.alpaca.markets"

def get_trades_needing_atr(client: bigquery.Client, limit: int = 500) -> list:
    """Fetches trades from BigQuery that need an ATR value backfilled."""
    query = f"""
        SELECT session_id, symbol, timestamp
        FROM `{TABLE_ID}`
        WHERE atr_at_execution IS NULL 
          AND price IS NOT NULL
          AND side IS NOT NULL
        ORDER BY timestamp DESC
        LIMIT {limit}
    """
    print(f"Executing query to find trades needing ATR backfill:\n{query}")
    query_job = client.query(query)
    results = list(query_job.result())
    print(f"Found {len(results)} trades to backfill.")
    return results

def calculate_atr(bars_df: pd.DataFrame, period: int = 14) -> float | None:
    """Calculates ATR using Wilder's Smoothing, matching the JS implementation."""
    if len(bars_df) < period + 1:
        return None

    high_low = bars_df['high'] - bars_df['low']
    high_prev_close = (bars_df['high'] - bars_df['close'].shift()).abs()
    low_prev_close = (bars_df['low'] - bars_df['close'].shift()).abs()

    tr = pd.concat([high_low, high_prev_close, low_prev_close], axis=1).max(axis=1)
    
    # Using Exponential Moving Average for Wilder's Smoothing
    atr = tr.ewm(alpha=1/period, adjust=False).mean()
    
    return atr.iloc[-1]


def get_historical_atr(api: tradeapi.REST, symbol: str, trade_timestamp: datetime) -> float | None:
    """Fetches historical bars and calculates ATR for a specific point in time."""
    # We need `period` + 1 bars to calculate TR, and more for a stable ATR.
    # Fetching 40 days should be sufficient for a 14-period ATR.
    end_dt = trade_timestamp.astimezone(timezone.utc)
    start_dt = end_dt - timedelta(days=40)

    try:
        # Alpaca's get_bars is inclusive of start/end
        bars = api.get_bars(
            symbol,
            tradeapi.TimeFrame.Day,
            start=start_dt.strftime('%Y-%m-%d'),
            end=end_dt.strftime('%Y-%m-%d'),
            adjustment='raw'
        )
        if not bars:
            print(f"  - No bars returned for {symbol} up to {end_dt.date()}")
            return None

        bars_df = pd.DataFrame([b._raw for b in bars])
        bars_df.rename(columns={'o': 'open', 'h': 'high', 'l': 'low', 'c': 'close', 'v': 'volume'}, inplace=True)
        
        return calculate_atr(bars_df, 14)

    except Exception as e:
        print(f"  - Could not fetch/calculate ATR for {symbol}: {e}")
        return None

def update_trade_atr(client: bigquery.Client, session_id: str, atr: float):
    """Updates the atr_at_execution for a specific trade in BigQuery."""
    query = f"""
        UPDATE `{TABLE_ID}`
        SET atr_at_execution = @atr
        WHERE session_id = @session_id
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("atr", "FLOAT64", atr),
            bigquery.ScalarQueryParameter("session_id", "STRING", session_id),
        ]
    )
    
    query_job = client.query(query, job_config=job_config)
    query_job.result() 
    
    if query_job.errors:
        print(f"  - Error updating ATR for trade {session_id}: {query_job.errors}")
    else:
        print(f"  - Successfully updated ATR for trade {session_id}.")

def main():
    """Main function to orchestrate the backfill process."""
    print("--- Starting ATR Backfill Process ---")
    
    # --- Initialize Clients ---
    try:
        alpaca_api = tradeapi.REST(base_url=ALPACA_API_BASE_URL)
        print("Successfully connected to Alpaca API.")
    except Exception as e:
        print(f"Failed to connect to Alpaca API. Error: {e}")
        return

    bq_client = bigquery.Client(project=GCP_PROJECT_ID)
    print("Successfully connected to BigQuery.")

    # --- Fetch and Process Trades ---
    trades_to_process = get_trades_needing_atr(bq_client)

    if not trades_to_process:
        print("No trades require ATR backfilling. Exiting.")
        return

    for i, trade in enumerate(trades_to_process):
        print(f"\nProcessing trade {i+1}/{len(trades_to_process)}: {trade.symbol} ({trade.session_id})")
        
        atr_value = get_historical_atr(alpaca_api, trade.symbol, trade.timestamp)
        
        if atr_value is not None and atr_value > 0:
            print(f"  - Calculated ATR at {trade.timestamp.date()}: {atr_value:.4f}")
            update_trade_atr(bq_client, trade.session_id, atr_value)
        else:
            print(f"  - Skipping update for trade {trade.session_id} due to invalid ATR.")

    print("\n--- ATR Backfill Process Complete ---")

if __name__ == "__main__":
    main()
