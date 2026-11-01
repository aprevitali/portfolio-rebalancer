from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

# Aliquote di default per tipo di strumento (modificabili per singolo titolo).
DEFAULT_TAX_RATES = {
    "etf": 0.26, "etc": 0.26, "stock": 0.26, "bond_other": 0.26, "bond_govt": 0.125,
}
INSTRUMENT_TYPES = list(DEFAULT_TAX_RATES)


@dataclass
class Holding:
    ticker: str
    asset_class: str
    quantity: float
    price: float                         # prezzo in EUR per unità
    name: str = ""
    avg_cost: Optional[float] = None     # prezzo medio di carico (costo medio ponderato), EUR
    instrument_type: str = "etf"
    tax_rate: Optional[float] = None     # sovrascrive il default per tipo
    target_weight_in_class: Optional[float] = None  # 0-100; None = pesi correnti
    currency: str = "EUR"
    manual: bool = False
    price_updated_at: Optional[str] = None

    @property
    def value(self) -> float:
        return self.quantity * self.price

    @property
    def rate(self) -> float:
        if self.tax_rate is not None:
            return self.tax_rate
        return DEFAULT_TAX_RATES.get(self.instrument_type, 0.26)

    @property
    def gain_share(self) -> Optional[float]:
        """Quota di plusvalenza sul valore: (P - C) / P. None se il costo non è noto."""
        if self.avg_cost is None or self.price <= 0:
            return None
        return (self.price - self.avg_cost) / self.price


@dataclass
class BrokerProfile:
    name: str = "Custom"
    verified_on: Optional[str] = None
    cost_basis: str = "weighted_average"      # lifo: non implementato
    loss_offset_scope: str = "same_broker"    # same_broker | all_brokers
    fractional_shares_default: bool = True
    fee_fixed: Optional[float] = None
    fee_percent: Optional[float] = None       # in percentuale, es. 0.19 = 0,19%
    fee_min: Optional[float] = None
    fee_max: Optional[float] = None
    fx_cost_percent: Optional[float] = None

    @property
    def fees_configured(self) -> bool:
        return any(v is not None for v in (self.fee_fixed, self.fee_percent, self.fee_min, self.fee_max))


@dataclass
class Trade:
    ticker: str
    name: str
    asset_class: str
    action: str                 # "buy" | "sell"
    quantity: float
    price: float
    gross: float                # controvalore (quantità x prezzo)
    fee: float = 0.0
    tax: float = 0.0
    tax_known: bool = True

    @property
    def net_cash(self) -> float:
        """Flusso di cassa: negativo per acquisti, positivo per vendite (dopo costi)."""
        return -(self.gross + self.fee) if self.action == "buy" else self.gross - self.fee - self.tax


@dataclass
class Plan:
    mode: str
    trades: list = field(default_factory=list)
    total_tax: float = 0.0
    total_fees: float = 0.0
    cash_in: float = 0.0                # liquidità immessa (contributo)
    net_target: float = 0.0             # netto richiesto (decumulo)
    net_obtained: float = 0.0           # netto ottenuto dalle vendite (decumulo)
    leftover_cash: float = 0.0
    carryforward_before: float = 0.0
    carryforward_after: float = 0.0
    tax_estimable: bool = True
    triggered: bool = True              # False se le bande di tolleranza non sono superate
    allocation_before: dict = field(default_factory=dict)   # % per classe
    allocation_after: dict = field(default_factory=dict)
    targets: dict = field(default_factory=dict)
    warnings: list = field(default_factory=list)

    @property
    def total_cost(self) -> float:
        return self.total_tax + self.total_fees
