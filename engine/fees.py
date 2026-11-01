from __future__ import annotations

from .models import BrokerProfile


def order_fee(profile: BrokerProfile, amount: float) -> float:
    """Commissione di un singolo ordine: fisso + percentuale, con minimo e massimo."""
    if amount <= 0:
        return 0.0
    fee = (profile.fee_fixed or 0.0) + (profile.fee_percent or 0.0) / 100.0 * amount
    if profile.fee_min is not None:
        fee = max(fee, profile.fee_min)
    if profile.fee_max is not None:
        fee = min(fee, profile.fee_max)
    return round(fee, 2)
