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
This script re-evaluates ALL completed trades in the BigQuery table, 
classifying them as 'WIN', 'LOSE', or 'HOLD' based on the new,
volatility-adjusted return percentages.

This script should be run after `backfill_atr.py` to ensure all trades
have the necessary `atr_at_execution` data. This will overwrite any
previous `result` values, creating a clean slate for Pattern Analysis v2.0.

Prerequisites:
- Google Cloud SDK authenticated (`gcloud auth application-default login`)
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
# These multipliers are initial estimates. The resulting data should be
# analyzed to find more optimal, data-driven values.
WIN_ATR_MULTIPLIER = 2.0
LOSE_ATR_MULTIPLIER = 1.5

def reevaluate_all_trades(client: bigquery.Client):
    """
    Updates trade results (WIN/LOSE/HOLD) for ALL trades using the new
    volatility-adjusted thresholds. This will overwrite previous results.
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
      /* This condition applies the logic to all evaluatable trades */
      exit_price IS NOT NULL
      AND filled_avg_price IS NOT NULL
      AND filled_avg_price > 0
      AND atr_at_execution IS NOT NULL
      AND atr_at_execution > 0
    """
    
    print(f"Executing FULL re-evaluation with volatility-adjusted logic:\n{query}")
    
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("win_multiplier", "FLOAT64", WIN_ATR_MULTIPLIER),
            bigquery.ScalarQueryParameter("lose_multiplier", "FLOAT64", LOSE_ATR_MULTIPLIER),
        ]
    )

    # Execute the query
    query_job = client.query(query, job_config=job_config)
    
    print("Waiting for re-evaluation query to complete...")
    query_job.result()
    
    if query_job.errors:
        print(f"Errors encountered during re-evaluation: {query_job.errors}")
    else:
        print(f"Successfully re-evaluated {query_job.num_dml_affected_rows} trades.")

def main():
    """Main function to orchestrate the re-evaluation."""
    print("--- Starting Full Trade Re-evaluation Process (Pattern Analysis v2.0) ---")
    
    # --- Initialize Client ---
    try:
        bq_client = bigquery.Client(project=GCP_PROJECT_ID)
        print("Successfully connected to BigQuery.")
    except Exception as e:
        print(f"Failed to connect to BigQuery. Ensure you are authenticated. Error: {e}")
        return

    # --- Run Re-evaluation ---
    reevaluate_all_trades(bq_client)
    
    print("\n--- Full Re-evaluation Process Complete ---")
    print("The 'trades' table is now updated with the new evaluation logic.")
    print("You can now re-run analyses on this data to generate 'Pattern Analysis v2.0'.")


if __name__ == "__main__":
    main()
