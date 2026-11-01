# Broker profiles

[English](README.md) · [Italiano](README.it.md)

Each `.yaml` file in this folder becomes a selectable profile in the app (converted to JSON at build time).
Format (see `engine/brokers.py`):
```yaml
name: BrokerName
verified_on: "2026-01-15"      # optional; without a date the app shows "unverified profile"
cost_basis: weighted_average
loss_offset_scope: same_broker  # or all_brokers
fractional_shares_default: false
fees:
  fixed: 2.95      # € per order (null = not configured)
  percent: 0.19    # % of the amount
  min: null
  max: null
fx_cost_percent: null
```
