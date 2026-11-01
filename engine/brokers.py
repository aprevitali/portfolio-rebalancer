from __future__ import annotations

from typing import Optional

from .models import BrokerProfile


def _num(x) -> Optional[float]:
    """Valori mancanti, 'TODO' o non numerici diventano None (commissione non configurata)."""
    if x is None or isinstance(x, bool):
        return None
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def profile_from_dict(d: dict) -> BrokerProfile:
    fees = d.get("fees") or {}
    return BrokerProfile(
        name=str(d.get("name", "Custom")),
        verified_on=d.get("verified_on") if isinstance(d.get("verified_on"), str) else None,
        cost_basis=str(d.get("cost_basis", "weighted_average")),
        loss_offset_scope=str(d.get("loss_offset_scope", "same_broker")),
        fractional_shares_default=bool(d.get("fractional_shares_default", True)),
        fee_fixed=_num(fees.get("fixed")), fee_percent=_num(fees.get("percent")),
        fee_min=_num(fees.get("min")), fee_max=_num(fees.get("max")),
        fx_cost_percent=_num(d.get("fx_cost_percent")),
    )

