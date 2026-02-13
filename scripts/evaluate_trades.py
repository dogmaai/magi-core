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
This script evaluates completed trades in a BigQuery table, classifying them
as 'WIN', 'LOSE', or 'HOLD' based on their return percentage.

This script should be run after `update_exit_prices.py` to ensure all trades
have an exit price before evaluation.

Prerequisites:
- Google Cloud SDK authenticated (e.g., `gcloud auth application-default login`)
- Required Python packages installed:
  - pip install google-cloud-bigquery
"""
from google.cloud import bigquery

# --- Configuration ---
GCP_PROJECT_ID = "screen-share-459802"
BIGQUERY_DATASET = "magi_core"
BIGQUERY_TABLE = "trades"
TABLE_ID = f"{GCP_PROJECT_ID}.{BIGQUERY_DATASET}.{BIGQUERY_TABLE}"

# --- ATR-based Evaluation Thresholds ---
# A trade is a WIN if the profit exceeds N times the ATR at execution.
# A trade is a LOSE if the loss exceeds M times the ATR at execution.
# Using a higher multiplier for wins encourages capturing more significant moves.
WIN_ATR_MULTIPLIER = 2.0
LOSE_ATR_MULTIPLIER = 1.5

def evaluate_trades(client: bigquery.Client):
    """
    Updates trade results (WIN/LOSE/HOLD) and return percentages in BigQuery
    for trades that have not yet been evaluated, using volatility-adjusted thresholds.
    """
    query = f"""
    UPDATE `{TABLE_ID}`
    SET 
      result = CASE 
        /* Volatility-adjusted WIN condition */
        WHEN side = 'buy' AND (exit_price - filled_avg_price) >= (atr_at_execution * @win_multiplier) THEN 'WIN'
        WHEN side = 'sell' AND (filled_avg_price - exit_price) >= (atr_at_execution * @win_multiplier) THEN 'WIN'
        
        /* Volatility-adjusted LOSE condition */
        WHEN side = 'buy' AND (exit_price - filled_avg_price) <= -(atr_at_execution * @lose_multiplier) THEN 'LOSE'
        WHEN side = 'sell' AND (filled_avg_price - exit_price) <= -(atr_at_execution * @lose_multiplier) THEN 'LOSE'
        
        ELSE 'HOLD'
      END,
      return_pct = ROUND((exit_price - filled_avg_price) / filled_avg_price * 100, 2)
    WHERE 
      result IS NULL
      AND exit_price IS NOT NULL
      AND filled_avg_price IS NOT NULL
      AND filled_avg_price > 0
      AND atr_at_execution IS NOT NULL
      AND atr_at_execution > 0
      /* Optional: only evaluate older trades */
      AND timestamp < TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 DAY)
    """
    
    print(f"Executing volatility-adjusted trade evaluation query:\n{query}")
    
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("win_multiplier", "FLOAT64", WIN_ATR_MULTIPLIER),
            bigquery.ScalarQueryParameter("lose_multiplier", "FLOAT64", LOSE_ATR_MULTIPLIER),
        ]
    )

    # Execute the query
    query_job = client.query(query, job_config=job_config)
    
    # Wait for the job to complete to get the result
    query_job.result()
    
    if query_job.errors:
        print(f"Errors encountered during trade evaluation: {query_job.errors}")
    else:
        # DML queries return the number of rows affected
        print(f"Successfully evaluated {query_job.num_dml_affected_rows} trades.")

def main():
    """Main function to orchestrate the evaluation."""
    print("Starting trade evaluation process...")
    
    # --- Initialize Client ---
    try:
        bq_client = bigquery.Client(project=GCP_PROJECT_ID)
        print("Successfully connected to BigQuery.")
    except Exception as e:
        print(f"Failed to connect to BigQuery. Ensure you are authenticated. Error: {e}")
        return

    # --- Run Evaluation ---
    evaluate_trades(bq_client)
    
    print("\nEvaluation process complete.")

if __name__ == "__main__":
    main()
