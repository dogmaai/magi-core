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
This script synchronizes closed Alpaca orders with a BigQuery table.
It fetches recently closed 'sell' orders from Alpaca, and updates the 
corresponding 'exit_price' in the BigQuery 'trades' table using the actual 
filled average price from the order.

This ensures the analytical data in BigQuery is accurate, reflecting the
true execution prices rather than estimated market prices.

Prerequisites:
- Google Cloud SDK authenticated (e.g., `gcloud auth application-default login`)
- Alpaca API credentials set as environment variables:
  - export APCA_API_KEY_ID="YOUR_API_KEY"
  - export APCA_API_SECRET_KEY="YOUR_SECRET_KEY"
- Required Python packages installed:
  - pip install alpaca-trade-api google-cloud-bigquery
"""

import os
from datetime import datetime, timedelta
import alpaca_trade_api as tradeapi
from alpaca_trade_api.entity import Order
from google.cloud import bigquery

# --- Configuration ---
GCP_PROJECT_ID = "screen-share-459802"
BIGQUERY_DATASET = "magi_core"
BIGQUERY_TABLE = "trades"
TABLE_ID = f"{GCP_PROJECT_ID}.{BIGQUERY_DATASET}.{BIGQUERY_TABLE}"

# Alpaca API credentials are expected to be in environment variables
# APCA_API_KEY_ID and APCA_API_SECRET_KEY
ALPACA_API_BASE_URL = "https://paper-api.alpaca.markets" # Use paper trading endpoint

def get_recently_closed_orders(api: tradeapi.REST, limit: int = 100) -> list[Order]:
    """
    Fetches the most recent closed orders from Alpaca.

    Args:
        api: An Alpaca REST API client instance.
        limit: The maximum number of orders to fetch.

    Returns:
        A list of Alpaca Order objects.
    """
    try:
        # Fetch orders from the last 7 days, descending order
        after_date = (datetime.now() - timedelta(days=7)).isoformat()
        
        closed_orders = api.list_orders(
            status='closed',
            limit=limit,
            after=after_date,
            direction='desc' # Most recent first
        )
        print(f"Fetched {len(closed_orders)} recently closed orders from Alpaca.")
        return closed_orders
    except Exception as e:
        print(f"Could not fetch closed orders from Alpaca: {e}")
        return []

def update_trade_exit_price(client: bigquery.Client, session_id: str, symbol: str, price: float):
    """
    Updates the exit_price for a specific trade in BigQuery,
    but only if the exit_price is currently NULL.

    Args:
        client: A BigQuery client instance.
        session_id: The session_id of the trade to update (maps to client_order_id).
        symbol: The symbol of the trade (for logging).
        price: The new exit_price to set (the actual filled average price).
    """
    query = f"""
        UPDATE `{TABLE_ID}`
        SET exit_price = @price
        WHERE session_id = @session_id AND exit_price IS NULL
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("price", "FLOAT64", price),
            bigquery.ScalarQueryParameter("session_id", "STRING", session_id),
        ]
    )
    
    print(f"Attempting to update trade {session_id} ({symbol}) with exit_price: {price}")
    query_job = client.query(query, job_config=job_config)
    
    # Wait for the job to complete
    query_job.result()
    
    if query_job.errors:
        print(f"Error updating trade {session_id}: {query_job.errors}")
    elif query_job.num_dml_affected_rows > 0:
        print(f"Successfully updated trade {session_id}.")
    else:
        print(f"No update needed for trade {session_id} (already has an exit_price or does not exist).")

def main():
    """Main function to orchestrate the synchronization process."""
    # --- Initialize Clients ---
    try:
        alpaca_api = tradeapi.REST(
            base_url=ALPACA_API_BASE_URL,
            # The SDK will automatically pick up credentials from env vars
        )
        print("Successfully connected to Alpaca API.")
    except Exception as e:
        print(f"Failed to connect to Alpaca API. Ensure API keys are set correctly. Error: {e}")
        return

    bq_client = bigquery.Client(project=GCP_PROJECT_ID)
    print("Successfully connected to BigQuery.")

    # --- Fetch and Process Closed Orders ---
    closed_orders = get_recently_closed_orders(alpaca_api, limit=500)

    if not closed_orders:
        print("No recently closed orders found to process. Exiting.")
        return

    update_count = 0
    for order in closed_orders:
        # We only care about sales that close a position
        if order.side == 'sell' and order.filled_avg_price is not None:
            # Assumes the session_id in BigQuery matches the client_order_id from Alpaca
            session_id = order.client_order_id
            if not session_id:
                print(f"Skipping order {order.id} because it has no client_order_id.")
                continue

            symbol = order.symbol
            filled_price = float(order.filled_avg_price)
            
            update_trade_exit_price(bq_client, session_id, symbol, filled_price)
            update_count += 1

    print(f"\nProcessing complete. Attempted to update {update_count} trades based on closed Alpaca orders.")

if __name__ == "__main__":
    main()
