"""Ponte tra JavaScript (Pyodide) e il motore: JSON in ingresso, JSON in uscita."""
import dataclasses
import json

from engine import workspace as ws
from engine.brokers import profile_from_dict
from engine.models import DEFAULT_TAX_RATES, INSTRUMENT_TYPES, BrokerProfile
from engine.plans import STRATEGIES, contribution_plan, decumulation_plan, rebalance_plan

PROFILES = {}


def _dump(o) -> str:
    return json.dumps(o, ensure_ascii=False, allow_nan=False)


def set_profiles(js: str) -> str:
    global PROFILES
    PROFILES = {p.name: p for p in (profile_from_dict(d or {}) for d in json.loads(js))} or {"Custom": BrokerProfile()}
    return "ok"


def config(_: str = "") -> str:
    return _dump({
        "profiles": [{"name": p.name, "verified_on": p.verified_on, "fractional_shares_default": p.fractional_shares_default,
                      "fees_configured": p.fees_configured,
                      "fees": {"fixed": p.fee_fixed, "percent": p.fee_percent, "min": p.fee_min, "max": p.fee_max}}
                     for p in PROFILES.values()],
        "instrument_types": INSTRUMENT_TYPES, "strategies": STRATEGIES, "tax_rates": DEFAULT_TAX_RATES,
    })


def _plan_json(p) -> dict:
    d = dataclasses.asdict(p)
    d["total_cost"] = p.total_cost
    for out, tr in zip(d["trades"], p.trades):
        out["net_cash"] = tr.net_cash
    d["warnings"] = [{"code": c, "arg": str(a)} for c, a in p.warnings]
    return d


def plan(js: str) -> str:
    req = json.loads(js)
    rows = req.get("holdings") or []
    holdings = ws.to_holdings(ws.normalize_rows(rows)) if rows else []
    targets = {str(k): float(v) for k, v in (req.get("targets") or {}).items()}
    profile = PROFILES.get(req.get("broker")) or next(iter(PROFILES.values()))
    f = req.get("fees")
    if f is not None:   # stessa logica della v2: minimo e massimo a 0 = nessun limite
        profile = dataclasses.replace(profile, fee_fixed=f.get("fixed") or 0.0, fee_percent=f.get("percent") or 0.0,
                                      fee_min=f.get("min") or None, fee_max=f.get("max") or None)
    frac = bool(req.get("allow_fractional", True))
    carry = max(0.0, float(req.get("carryforward") or 0.0))
    mode = req.get("mode")
    if mode == "contribution":
        p = contribution_plan(holdings, targets, max(0.0, float(req.get("cash") or 0.0)), profile, frac)
    elif mode == "decumulation":
        strategy = req.get("strategy", "pro_rata")
        if strategy not in STRATEGIES:
            raise ValueError(f"strategia sconosciuta: {strategy}")
        p = decumulation_plan(holdings, targets, max(0.0, float(req.get("net") or 0.0)), strategy, profile, frac, carry,
                              max_drift=float(req.get("max_drift", 5.0)), priority_order=req.get("priority_order") or [])
    elif mode == "rebalance":
        p = rebalance_plan(holdings, targets, profile, frac, carry, float(req.get("band_abs", 5.0)), float(req.get("band_rel", 25.0)))
    else:
        raise ValueError(f"modalità sconosciuta: {mode}")
    return _dump(_plan_json(p))


def import_csv(text: str) -> str:
    return _dump({"portfolio": ws.read_csv(text)})


def import_workspace(text: str) -> str:
    pf, targets, settings = ws.load_workspace(text)
    return _dump({"portfolio": pf, "targets": targets, "settings": settings})
