# Profili broker

[English](README.md) · **Italiano**

Ogni file `.yaml` in questa cartella diventa un profilo selezionabile nell'app (convertito in JSON in fase di build).
Formato (vedi `engine/brokers.py`):
```yaml
name: NomeBroker
verified_on: "2026-01-15"      # facoltativo; senza data l'app mostra "profilo non verificato"
cost_basis: weighted_average
loss_offset_scope: same_broker  # o all_brokers
fractional_shares_default: false
fees:
  fixed: 2.95      # € per ordine (null = non configurato)
  percent: 0.19    # % sull'importo
  min: null
  max: null
fx_cost_percent: null
```
