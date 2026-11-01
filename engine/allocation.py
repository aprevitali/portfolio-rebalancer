"""Allocazione di importi verso i valori obiettivo, a livello di singola posizione."""
from __future__ import annotations

from collections import defaultdict


def waterfill(e: list, total: float, lo: list, hi: list, iters: int = 80) -> list:
    """Risolve: minimizza sum (x_i - e_i)^2 con sum x_i = total e lo_i <= x_i <= hi_i.

    La soluzione è x_i = clip(e_i - theta, lo_i, hi_i) con theta scelto per bisezione.
    Se total non è raggiungibile, restituisce il limite più vicino (somma dei lo o dei hi).
    """
    n = len(e)
    if n == 0:
        return []
    hi = [min(h, max(total, l)) for h, l in zip(hi, lo)]   # tetto finito: nessun x_i supera il totale
    if total <= sum(lo):
        return list(lo)
    if total >= sum(hi):
        return list(hi)
    a = min(e[i] - hi[i] for i in range(n)) - 1.0
    b = max(e[i] - lo[i] for i in range(n)) + 1.0
    for _ in range(iters):
        theta = (a + b) / 2.0
        s = sum(min(max(e[i] - theta, lo[i]), hi[i]) for i in range(n))
        if s > total:
            a = theta
        else:
            b = theta
    theta = (a + b) / 2.0
    return [min(max(e[i] - theta, lo[i]), hi[i]) for i in range(n)]


def class_weights(holdings: list) -> dict:
    """Pesi (0-1) dei titoli dentro la propria classe: obiettivo se impostato, altrimenti correnti."""
    by_class = defaultdict(list)
    for i, h in enumerate(holdings):
        by_class[h.asset_class].append(i)
    w = [0.0] * len(holdings)
    for cls, idxs in by_class.items():
        explicit = [holdings[i].target_weight_in_class for i in idxs]
        if all(x is not None for x in explicit) and sum(explicit) > 0:
            tot = sum(explicit)
            for i, x in zip(idxs, explicit):
                w[i] = x / tot
            continue
        vals = [holdings[i].value for i in idxs]
        tot = sum(vals)
        for i, v in zip(idxs, vals):
            w[i] = (v / tot) if tot > 0 else 1.0 / len(idxs)
    return w


def target_values(holdings: list, targets: dict, total_after: float) -> list:
    """Valore obiettivo di ogni titolo dato il patrimonio dopo l'operazione.

    targets: {classe: % target}. Una classe senza titoli non può essere raggiunta.
    """
    w = class_weights(holdings)
    return [targets.get(h.asset_class, 0.0) / 100.0 * w[i] * total_after for i, h in enumerate(holdings)]


def allocate_contribution(holdings: list, targets: dict, amount: float) -> list:
    """Importo da acquistare per titolo (>= 0), somma = amount, minimizzando la deviazione quadratica."""
    if not holdings or amount <= 0:
        return [0.0] * len(holdings)
    v = [h.value for h in holdings]
    T = target_values(holdings, targets, sum(v) + amount)
    e = [T[i] - v[i] for i in range(len(holdings))]
    return waterfill(e, amount, [0.0] * len(holdings), [float("inf")] * len(holdings))


def allocate_sale_towards_target(holdings: list, targets: dict, amount: float) -> list:
    """Importo da vendere per titolo, partendo dai più sovrappesati, con 0 <= x_i <= valore."""
    if not holdings or amount <= 0:
        return [0.0] * len(holdings)
    v = [h.value for h in holdings]
    total = sum(v)
    amount = min(amount, total)
    T = target_values(holdings, targets, total - amount)
    e = [v[i] - T[i] for i in range(len(holdings))]
    return waterfill(e, amount, [0.0] * len(holdings), v)


def allocate_sale_pro_rata(holdings: list, amount: float) -> list:
    total = sum(h.value for h in holdings)
    if total <= 0 or amount <= 0:
        return [0.0] * len(holdings)
    amount = min(amount, total)
    return [amount * h.value / total for h in holdings]


def allocate_sale_priority(holdings: list, amount: float, order: list) -> list:
    """Vende classe per classe nell'ordine indicato; dentro la classe pro-rata sul valore."""
    x = [0.0] * len(holdings)
    remaining = amount
    classes = list(order) + [c for c in dict.fromkeys(h.asset_class for h in holdings) if c not in order]
    for cls in classes:
        if remaining <= 1e-9:
            break
        idxs = [i for i, h in enumerate(holdings) if h.asset_class == cls]
        cap = sum(holdings[i].value for i in idxs)
        if cap <= 0:
            continue
        take = min(cap, remaining)
        for i in idxs:
            x[i] = take * holdings[i].value / cap
        remaining -= take
    return x


def allocate_sale_min_tax(holdings: list, targets: dict, amount: float, max_drift: float):
    """Vende prima le posizioni col minor costo fiscale per euro, entro una deviazione massima per classe.

    max_drift: punti percentuali di scostamento ammessi per classe dopo la vendita.
    Restituisce (importi, avviso o None). Se i vincoli non sono soddisfacibili ripiega su towards_target.
    """
    n = len(holdings)
    v = [h.value for h in holdings]
    total = sum(v)
    amount = min(amount, total)
    after = total - amount
    classes = list(dict.fromkeys(h.asset_class for h in holdings))
    cls_val = {c: sum(v[i] for i in range(n) if holdings[i].asset_class == c) for c in classes}
    md = max_drift / 100.0
    lo, hi = {}, {}
    for c in classes:
        t = targets.get(c, 0.0) / 100.0
        lo[c] = max(0.0, cls_val[c] - (t + md) * after)
        hi[c] = min(cls_val[c], max(0.0, cls_val[c] - (t - md) * after))
    if sum(lo.values()) > amount + 1e-6 or sum(hi.values()) < amount - 1e-6:
        return (allocate_sale_towards_target(holdings, targets, amount),
                "drift_infeasible")

    def cost(i):
        g = holdings[i].gain_share
        return holdings[i].rate * (g if g is not None else 1.0)   # costo ignoto: in coda

    order = sorted(range(n), key=cost)
    x = [0.0] * n
    cap_left = dict(hi)
    # 1) quota minima obbligatoria per classe
    for c in classes:
        need = lo[c]
        for i in [j for j in order if holdings[j].asset_class == c]:
            take = min(need, v[i] - x[i])
            x[i] += take
            need -= take
            cap_left[c] -= take
            if need <= 1e-9:
                break
    remaining = amount - sum(x)
    # 2) il resto per costo fiscale crescente, entro il tetto di classe
    for i in order:
        if remaining <= 1e-9:
            break
        c = holdings[i].asset_class
        take = min(v[i] - x[i], cap_left[c], remaining)
        if take > 0:
            x[i] += take
            cap_left[c] -= take
            remaining -= take
    return x, None
