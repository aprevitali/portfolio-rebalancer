export interface Row {
  asset_class: string; ticker: string; name: string; quantity: number; price: number; avg_cost: number | null;
  instrument_type: string; target_weight_in_class: number | null; currency: string; manual: boolean; price_updated_at: string | null;
}
export interface Profile {
  name: string; verified_on: string | null; fractional_shares_default: boolean; fees_configured: boolean;
  fees: { fixed: number | null; percent: number | null; min: number | null; max: number | null };
}
export interface Config { profiles: Profile[]; instrument_types: string[]; strategies: string[]; tax_rates: Record<string, number> }
export interface Suggestion { symbol: string; name: string; exchange: string; type: string; isin: string; known_type: string | null }
export interface Trade {
  ticker: string; name: string; asset_class: string; action: 'buy' | 'sell'; quantity: number; price: number;
  gross: number; fee: number; tax: number; tax_known: boolean; net_cash: number;
}
export interface Plan {
  mode: string; trades: Trade[]; total_tax: number; total_fees: number; cash_in: number; net_target: number; net_obtained: number;
  leftover_cash: number; carryforward_before: number; carryforward_after: number; tax_estimable: boolean; triggered: boolean;
  allocation_before: Record<string, number>; allocation_after: Record<string, number>; targets: Record<string, number>;
  warnings: { code: string; arg: string }[]; total_cost: number;
}
