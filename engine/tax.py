from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from .models import Holding


@dataclass
class TaxResult:
    total_tax: float
    carryforward_used: float
    carryforward_after: float
    per_trade: list                  # tassa attribuita a ciascuna vendita, stesso ordine dell'input
    estimable: bool                  # False se almeno un costo medio manca


def realized_gain(h: Holding, qty: float) -> Optional[float]:
    if h.avg_cost is None:
        return None
    return (h.price - h.avg_cost) * qty


def compute_tax(sales: list, carryforward: float = 0.0) -> TaxResult:
    """Stima la tassa su una lista di vendite [(Holding, quantità)].

    Semplificazione v1: le minusvalenze (di queste vendite e dello zainetto) compensano le
    plusvalenze partendo da quelle con aliquota più alta. La compensazione tra aliquote
    diverse (26% e 12,5%) è un'approssimazione. Se il costo medio manca, la tassa di quella
    vendita non è stimabile e viene considerata zero.
    """
    gains = []   # (indice, aliquota, plusvalenza)
    losses = 0.0
    estimable = True
    for i, (h, q) in enumerate(sales):
        g = realized_gain(h, q)
        if g is None:
            estimable = False
            continue
        if g >= 0:
            gains.append([i, h.rate, g])
        else:
            losses += -g
    available = max(0.0, carryforward) + losses
    used_total = 0.0
    taxable = {}
    for idx, rate, g in sorted(gains, key=lambda x: -x[1]):
        offset = min(g, available)
        available -= offset
        used_total += offset
        taxable[idx] = (rate, g - offset)
    per_trade = [0.0] * len(sales)
    total = 0.0
    for idx, (rate, base) in taxable.items():
        per_trade[idx] = base * rate
        total += per_trade[idx]
    # Quanto dello zainetto è stato consumato dalle sole plusvalenze oltre alle perdite correnti
    carry_used = max(0.0, used_total - losses)
    carry_after = max(0.0, carryforward) + losses - used_total
    return TaxResult(total, carry_used, carry_after, per_trade, estimable)
