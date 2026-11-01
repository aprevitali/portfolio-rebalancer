"""Salvataggio/caricamento dell'intero stato di lavoro in un unico file JSON, e import CSV con alias.

Il portafoglio è una lista di dict con le chiavi di COLUMNS (solo libreria standard).
"""
from __future__ import annotations

import csv
import io
import json
import math
import re
from typing import Optional

from .models import INSTRUMENT_TYPES, Holding

VERSION = 2
COLUMNS = ["asset_class", "ticker", "name", "quantity", "price", "avg_cost", "instrument_type",
           "target_weight_in_class", "currency", "manual", "price_updated_at"]
ALIASES = {
    "categoria": "asset_class", "asset class": "asset_class", "asset_class": "asset_class", "classe": "asset_class",
    "ticker": "ticker", "nome": "name", "name": "name",
    "quantità": "quantity", "quantita": "quantity", "quantity": "quantity", "qty": "quantity",
    "prezzo": "price", "price": "price",
    "pmc": "avg_cost", "prezzo medio di carico": "avg_cost", "avg_cost": "avg_cost", "costo medio": "avg_cost",
    "instrument_type": "instrument_type", "tipo": "instrument_type",
    "target_weight_in_class": "target_weight_in_class", "peso_in_classe": "target_weight_in_class",
    "currency": "currency", "valuta": "currency", "manual": "manual",
    "price_updated_at": "price_updated_at", "valore": None,
}
REQUIRED = ["asset_class", "ticker", "quantity", "price"]


def _none(x):
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return None
    if isinstance(x, str) and x.strip() == "":
        return None
    return x


def _num(x) -> Optional[float]:
    """Numero da testo o valore; accetta "1.234,56", "1,234.56", "12,5", "12.5" e simboli di valuta."""
    x = _none(x)
    if x is None or isinstance(x, bool):
        return None
    if isinstance(x, (int, float)):
        v = float(x)
        return v if math.isfinite(v) else None
    v = re.sub(r"[€$£\s]", "", str(x))
    if not v:
        return None
    lc, ld = v.rfind(","), v.rfind(".")
    if lc > -1 and ld > -1:
        v = v.replace(".", "").replace(",", ".") if lc > ld else v.replace(",", "")
    elif lc > -1:
        v = v.replace(",", "") if re.fullmatch(r"[1-9]\d{0,2}(,\d{3})+", v) else v.replace(",", ".")
    try:
        out = float(v)
    except ValueError:
        return None
    return out if math.isfinite(out) else None


def _bool(x) -> bool:
    x = _none(x)
    if x is None:
        return False
    if isinstance(x, bool):
        return x
    if isinstance(x, (int, float)):
        return x != 0
    return str(x).strip().lower() in ("true", "1", "yes", "y", "si", "sì", "vero")


def empty_portfolio() -> list:
    return []


def normalize_rows(rows: list, fields: Optional[list] = None) -> list:
    """Rinomina le colonne con gli alias (italiano/inglese), completa i valori mancanti e scarta le righe senza ticker."""
    keys = list(fields) if fields is not None else list(dict.fromkeys(k for r in rows for k in r))
    mapping = {}
    for k in keys:
        c = ALIASES.get(str(k).strip().lower())
        if c and c not in mapping.values():
            mapping[k] = c
    missing = [c for c in REQUIRED if c not in mapping.values()]
    if missing:
        raise ValueError(f"colonne mancanti: {', '.join(missing)}")
    out = []
    for r in rows:
        v = {c: r.get(k) for k, c in mapping.items()}
        ticker = str(_none(v.get("ticker")) or "").strip()
        if not ticker:
            continue
        itype = _none(v.get("instrument_type"))
        updated = _none(v.get("price_updated_at"))
        out.append({
            "asset_class": str(_none(v.get("asset_class")) or "").strip(),
            "ticker": ticker,
            "name": str(_none(v.get("name")) or ticker),
            "quantity": _num(v.get("quantity")) or 0.0,
            "price": _num(v.get("price")) or 0.0,
            "avg_cost": _num(v.get("avg_cost")),
            "instrument_type": itype if itype in INSTRUMENT_TYPES else "etf",
            "target_weight_in_class": _num(v.get("target_weight_in_class")),
            "currency": str(_none(v.get("currency")) or "EUR"),
            "manual": _bool(v.get("manual")),
            "price_updated_at": None if updated is None else str(updated),
        })
    return out


def read_csv(text: str) -> list:
    """Legge un CSV (separatore , ; o tab, riconosciuto dall'intestazione) e restituisce le righe normalizzate."""
    text = text.lstrip("\ufeff")
    head = text.split("\n", 1)[0]
    delim = max([",", ";", "\t"], key=head.count)
    rdr = csv.DictReader(io.StringIO(text), delimiter=delim)
    rows = list(rdr)
    return normalize_rows(rows, rdr.fieldnames or [])


def to_holdings(rows: list) -> list:
    out = []
    for r in rows:
        if not r.get("ticker") or not r.get("asset_class"):
            continue
        out.append(Holding(
            ticker=str(r["ticker"]), asset_class=str(r["asset_class"]), name=str(_none(r.get("name")) or r["ticker"]),
            quantity=float(_none(r.get("quantity")) or 0.0), price=float(_none(r.get("price")) or 0.0),
            avg_cost=_none(r.get("avg_cost")), instrument_type=_none(r.get("instrument_type")) or "etf",
            target_weight_in_class=_none(r.get("target_weight_in_class")),
            currency=_none(r.get("currency")) or "EUR", manual=bool(_none(r.get("manual")) or False),
            price_updated_at=_none(r.get("price_updated_at"))))
    return out


def dump_workspace(portfolio: list, targets: dict, settings: Optional[dict] = None) -> str:
    return json.dumps({"version": VERSION, "targets": targets, "settings": settings or {}, "portfolio": portfolio},
                      ensure_ascii=False, indent=2)


def load_workspace(text: str):
    d = json.loads(text)
    if not isinstance(d, dict) or "portfolio" not in d or "targets" not in d:
        raise ValueError("file di lavoro non valido")
    pf = normalize_rows(d["portfolio"]) if d["portfolio"] else empty_portfolio()
    return pf, {str(k): float(v) for k, v in d["targets"].items()}, d.get("settings", {})
