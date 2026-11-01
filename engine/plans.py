"""Piani di contributo, decumulo e ribilanciamento, con tasse, commissioni e quote intere/frazionate."""
from __future__ import annotations

import math
from collections import defaultdict
from typing import Optional

from .allocation import (allocate_contribution, allocate_sale_min_tax, allocate_sale_priority,
                         allocate_sale_pro_rata, allocate_sale_towards_target, target_values)
from .fees import order_fee
from .models import BrokerProfile, Holding, Plan, Trade
from .tax import compute_tax

EPS = 1e-9
STRATEGIES = ["pro_rata", "towards_target", "min_tax", "priority_order"]


# ----------------------------------------------------------------------------- utilità
def class_pct(holdings: list, values: Optional[list] = None) -> dict:
    vals = values if values is not None else [h.value for h in holdings]
    tot = sum(vals)
    out = defaultdict(float)
    for h, v in zip(holdings, vals):
        out[h.asset_class] += v
    return {c: (v / tot * 100.0 if tot > 0 else 0.0) for c, v in out.items()}


def _floor4(x: float) -> float:
    return math.floor(x * 1e4 + 1e-9) / 1e4


def _ceil4(x: float) -> float:
    return math.ceil(x * 1e4 - 1e-9) / 1e4


def _valid(holdings: list) -> list:
    return [h for h in holdings if h.price > 0 and h.quantity >= 0]


def _finish(plan: Plan, holdings: list, targets: dict, new_values: list, cash_extra: float = 0.0) -> Plan:
    classes = list(dict.fromkeys(list(targets) + [h.asset_class for h in holdings]))
    before = class_pct(holdings)
    after = class_pct(holdings, new_values)
    plan.allocation_before = {c: before.get(c, 0.0) for c in classes}
    plan.allocation_after = {c: after.get(c, 0.0) for c in classes}
    plan.targets = {c: targets.get(c, 0.0) for c in classes}
    held = {h.asset_class for h in holdings}
    for c, t in targets.items():
        if t > 0 and c not in held:
            plan.warnings.append(("class_without_holdings", c))
    if not plan.tax_estimable:
        plan.warnings.append(("missing_avg_cost", ""))
    if not (sum(targets.values()) > 99.5 and sum(targets.values()) < 100.5):
        plan.warnings.append(("targets_not_100", f"{sum(targets.values()):.1f}"))
    return plan


def _sell_trades(holdings: list, qty: list, profile: BrokerProfile, carryforward: float):
    idx = [i for i, q in enumerate(qty) if q > EPS]
    sales = [(holdings[i], qty[i]) for i in idx]
    tax = compute_tax(sales, carryforward)
    trades = []
    for k, i in enumerate(idx):
        h = holdings[i]
        gross = qty[i] * h.price
        trades.append(Trade(h.ticker, h.name, h.asset_class, "sell", qty[i], h.price, gross,
                            fee=order_fee(profile, gross), tax=tax.per_trade[k],
                            tax_known=h.avg_cost is not None))
    return trades, tax


def _buy_trades(holdings: list, qty: list, profile: BrokerProfile):
    trades = []
    for i, q in enumerate(qty):
        if q > EPS:
            h = holdings[i]
            gross = q * h.price
            trades.append(Trade(h.ticker, h.name, h.asset_class, "buy", q, h.price, gross,
                                fee=order_fee(profile, gross)))
    return trades


def _greedy_buy_whole(holdings: list, T: list, cash: float, profile: BrokerProfile, start_q: Optional[list] = None):
    """Acquista unità intere una alla volta, scegliendo quella che riduce di più la deviazione quadratica."""
    n = len(holdings)
    q = list(start_q) if start_q else [0] * n
    v = [h.value for h in holdings]
    spent = sum(order_fee(profile, q[i] * holdings[i].price) + q[i] * holdings[i].price for i in range(n))
    left = cash - spent
    for _ in range(100000):
        best, best_gain, best_cost = None, 0.0, 0.0
        for i, h in enumerate(holdings):
            p = h.price
            if p <= 0 or T[i] <= 0:
                continue
            fee_delta = order_fee(profile, (q[i] + 1) * p) - order_fee(profile, q[i] * p)
            cost = p + fee_delta
            if cost > left + 1e-9:
                continue
            dev = v[i] + q[i] * p - T[i]
            gain = -(2 * dev * p + p * p)
            if gain > best_gain + 1e-12:
                best, best_gain, best_cost = i, gain, cost
        if best is None:
            break
        q[best] += 1
        left -= best_cost
    return q, left


# ----------------------------------------------------------------------------- contributo
def contribution_plan(holdings: list, targets: dict, cash: float, profile: BrokerProfile,
                      allow_fractional: bool = True) -> Plan:
    holdings = _valid(holdings)
    plan = Plan(mode="contribution", cash_in=cash)
    if not holdings or cash <= 0:
        return _finish(plan, holdings, targets, [h.value for h in holdings])
    V = sum(h.value for h in holdings)

    fees = 0.0
    y = [0.0] * len(holdings)
    for _ in range(40):
        y = allocate_contribution(holdings, targets, max(0.0, cash - fees))
        new_fees = sum(order_fee(profile, a) for a in y if a > EPS)
        if abs(new_fees - fees) < 0.005:
            fees = new_fees
            break
        fees = new_fees
    invest = max(0.0, cash - fees)

    if allow_fractional:
        q = [_floor4(a / h.price) for a, h in zip(y, holdings)]
        for _ in range(10):   # garanzia: mai oltre la liquidità disponibile
            tr = _buy_trades(holdings, q, profile)
            over = sum(t.gross + t.fee for t in tr) - cash
            if over <= 1e-9:
                break
            big = max(range(len(q)), key=lambda i: q[i] * holdings[i].price)
            q[big] = max(0.0, _floor4(q[big] - (over + 0.01) / holdings[big].price))
    else:
        T = target_values(holdings, targets, V + invest)
        q, _ = _greedy_buy_whole(holdings, T, cash, profile)

    plan.trades = _buy_trades(holdings, q, profile)
    plan.total_fees = sum(t.fee for t in plan.trades)
    plan.leftover_cash = cash - sum(t.gross + t.fee for t in plan.trades)
    new_vals = [h.value + q[i] * h.price for i, h in enumerate(holdings)]
    return _finish(plan, holdings, targets, new_vals)


# ----------------------------------------------------------------------------- decumulo
def _sale_alloc(strategy: str, holdings: list, targets: dict, amount: float,
                max_drift: float, priority_order: list):
    if strategy == "pro_rata":
        return allocate_sale_pro_rata(holdings, amount), None
    if strategy == "towards_target":
        return allocate_sale_towards_target(holdings, targets, amount), None
    if strategy == "min_tax":
        return allocate_sale_min_tax(holdings, targets, amount, max_drift)
    if strategy == "priority_order":
        return allocate_sale_priority(holdings, amount, priority_order or []), None
    raise ValueError(f"strategia sconosciuta: {strategy}")


def decumulation_plan(holdings: list, targets: dict, net: float, strategy: str, profile: BrokerProfile,
                      allow_fractional: bool = True, carryforward: float = 0.0, max_drift: float = 5.0,
                      priority_order: Optional[list] = None) -> Plan:
    holdings = _valid(holdings)
    plan = Plan(mode="decumulation", net_target=net, carryforward_before=carryforward,
                carryforward_after=carryforward)
    if not holdings or net <= 0:
        return _finish(plan, holdings, targets, [h.value for h in holdings])
    V = sum(h.value for h in holdings)
    n = len(holdings)

    def net_of_amounts(x: list) -> float:
        sales = [(holdings[i], x[i] / holdings[i].price) for i in range(n) if x[i] > EPS]
        tax = compute_tax(sales, carryforward).total_tax
        fees = sum(order_fee(profile, a) for a in x if a > EPS)
        return sum(x) - fees - tax

    def alloc(G: float):
        return _sale_alloc(strategy, holdings, targets, G, max_drift, priority_order)

    x_all, _ = alloc(V)
    if net_of_amounts(x_all) < net - 0.005:
        plan.warnings.append(("insufficient_value", f"{net_of_amounts(x_all):.2f}"))
        G = V
    else:
        lo, hi = net, V
        for _ in range(80):
            mid = (lo + hi) / 2
            if net_of_amounts(alloc(mid)[0]) >= net:
                hi = mid
            else:
                lo = mid
        G = hi
    x, warn = alloc(G)
    if warn:
        plan.warnings.append((warn, f"{max_drift:g}"))

    if allow_fractional:
        q = [min(h.quantity, _ceil4(x[i] / h.price)) if x[i] > EPS else 0.0 for i, h in enumerate(holdings)]
    else:
        q = [min(math.floor(h.quantity + 1e-9), math.floor(x[i] / h.price + 1e-9)) if x[i] > EPS else 0
             for i, h in enumerate(holdings)]

        def net_q(qq):
            tr, tx = _sell_trades(holdings, qq, profile, carryforward)
            return sum(t.gross - t.fee for t in tr) - tx.total_tax
        while net_q(q) < net - 0.005:
            cands = [i for i, h in enumerate(holdings) if q[i] + 1 <= math.floor(h.quantity + 1e-9)]
            if not cands:
                plan.warnings.append(("insufficient_value", f"{net_q(q):.2f}"))
                break
            i = max(cands, key=lambda j: (x[j] / holdings[j].price - q[j], -(holdings[j].rate)))
            q[i] += 1

    trades, tax = _sell_trades(holdings, q, profile, carryforward)
    plan.trades = trades
    plan.total_tax = tax.total_tax
    plan.total_fees = sum(t.fee for t in trades)
    plan.net_obtained = sum(t.net_cash for t in trades)
    plan.tax_estimable = tax.estimable
    plan.carryforward_after = tax.carryforward_after
    new_vals = [h.value - q[i] * h.price for i, h in enumerate(holdings)]
    return _finish(plan, holdings, targets, new_vals)


# ----------------------------------------------------------------------------- ribilanciamento
def out_of_band(holdings: list, targets: dict, band_abs: float, band_rel: float) -> bool:
    """Regola 5/25: scatta se uno scostamento supera band_abs punti o band_rel % del target."""
    cur = class_pct(holdings)
    for c in set(list(targets) + list(cur)):
        t, w = targets.get(c, 0.0), cur.get(c, 0.0)
        drift = abs(w - t)
        if drift > band_abs:
            return True
        if t > 0 and drift / t * 100.0 > band_rel:
            return True
        if t == 0 and w > 0 and drift > 0:
            return True
    return False


def rebalance_plan(holdings: list, targets: dict, profile: BrokerProfile, allow_fractional: bool = True,
                   carryforward: float = 0.0, band_abs: float = 5.0, band_rel: float = 25.0) -> Plan:
    holdings = _valid(holdings)
    plan = Plan(mode="rebalance", carryforward_before=carryforward, carryforward_after=carryforward)
    if not holdings:
        return _finish(plan, holdings, targets, [])
    if not out_of_band(holdings, targets, band_abs, band_rel):
        plan.triggered = False
        return _finish(plan, holdings, targets, [h.value for h in holdings])

    n = len(holdings)
    v = [h.value for h in holdings]
    V = sum(v)
    costs = 0.0
    x, b, T = [0.0] * n, [0.0] * n, v
    for _ in range(40):
        T = target_values(holdings, targets, V - costs)
        x = [min(v[i], max(0.0, v[i] - T[i])) for i in range(n)]
        b = [max(0.0, T[i] - v[i]) for i in range(n)]
        sales = [(holdings[i], x[i] / holdings[i].price) for i in range(n) if x[i] > EPS]
        tax = compute_tax(sales, carryforward).total_tax
        fee_s = sum(order_fee(profile, a) for a in x if a > EPS)
        avail = sum(x) - tax - fee_s
        sb = sum(b)
        fee_b = sum(order_fee(profile, a) for a in b if a > EPS)
        if sb + fee_b > avail and sb > 0:
            k = max(0.0, avail - fee_b) / sb
            b = [a * k for a in b]
            fee_b = sum(order_fee(profile, a) for a in b if a > EPS)
        new_costs = tax + fee_s + fee_b
        if abs(new_costs - costs) < 0.005:
            costs = new_costs
            break
        costs = new_costs

    if allow_fractional:
        qs = [min(h.quantity, _ceil4(x[i] / h.price)) if x[i] > EPS else 0.0 for i, h in enumerate(holdings)]
    else:
        qs = [min(math.floor(h.quantity + 1e-9), round(x[i] / h.price)) if x[i] > EPS else 0
              for i, h in enumerate(holdings)]
    sell_trades, tax = _sell_trades(holdings, qs, profile, carryforward)
    cash = sum(t.gross - t.fee for t in sell_trades) - tax.total_tax

    if allow_fractional:
        qb = [_floor4(a / h.price) for a, h in zip(b, holdings)]
        for _ in range(10):
            tr = _buy_trades(holdings, qb, profile)
            over = sum(t.gross + t.fee for t in tr) - cash
            if over <= 1e-9:
                break
            big = max(range(n), key=lambda i: qb[i] * holdings[i].price)
            qb[big] = max(0.0, _floor4(qb[big] - (over + 0.01) / holdings[big].price))
    else:
        sim = [Holding(h.ticker, h.asset_class, h.quantity - qs[i], h.price) for i, h in enumerate(holdings)]
        Tw = target_values(holdings, targets, V - costs)
        qb, _ = _greedy_buy_whole(sim, Tw, cash, profile)

    buy_trades = _buy_trades(holdings, qb, profile)
    plan.trades = sell_trades + buy_trades
    plan.total_tax = tax.total_tax
    plan.total_fees = sum(t.fee for t in plan.trades)
    plan.tax_estimable = tax.estimable
    plan.carryforward_after = tax.carryforward_after
    plan.leftover_cash = cash - sum(t.gross + t.fee for t in buy_trades)
    new_vals = [h.value - qs[i] * h.price + qb[i] * h.price for i, h in enumerate(holdings)]
    return _finish(plan, holdings, targets, new_vals)
