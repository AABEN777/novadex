"""
Generic EVM adapter — serves Robinhood Chain, Base, BNB Chain and Monad.

Safety stack, in order:
  1. GoPlus Token Security  — holders, LP lock, taxes, honeypot, creator
  2. Blockscout             — holder distribution fallback where GoPlus is thin

GoPlus added Robinhood Chain on 2026-07-15 and flagged tax/DEX fields as
still rolling out, so on the newest chains expect partial reports. That is
handled explicitly: missing fields land in `unavailable` and the alert says
"n/a" rather than inventing a zero.
"""

from __future__ import annotations

import time
from typing import Optional

import config
from chain_base import (
    ChainAdapter, SafetyReport, CreatorActivity,
    http_get, safe_float, safe_int,
    BURN_ADDRESSES, is_infrastructure_holder,
)

GOPLUS_TOKEN = "https://api.gopluslabs.io/api/v1/token_security/{chain_id}"
GOPLUS_CHAINS = "https://api.gopluslabs.io/api/v1/supported_chains"

class EvmAdapter(ChainAdapter):
    """One class, many chains. All behaviour comes from config.CHAINS[key]."""

    def __init__(self, key: str):
        super().__init__(key)
        self.goplus_chain_id = self.cfg.get("goplus_chain_id")
        self.blockscout = self.cfg.get("blockscout")

    # ── SAFETY ────────────────────────────────────────────────────
    def safety(self, ca: str, pair_address: str | None = None) -> SafetyReport:
        rep = SafetyReport(ca=ca, chain=self.key)
        ca_l = (ca or "").lower()

        got_goplus = self._apply_goplus(rep, ca_l, pair_address)
        if not got_goplus:
            rep.flags.append("goplus_unavailable")

        # Holder distribution is the field we refuse to guess at.
        if rep.top_holder_pct is None and self.blockscout:
            self._apply_blockscout_holders(rep, ca, pair_address)

        for f in ("top_holder_pct", "lp_locked_pct"):
            if getattr(rep, f) is None and f not in rep.unavailable:
                rep.unavailable.append(f)

        return self.apply_common_gates(rep)

    # -- GoPlus ---------------------------------------------------
    def _apply_goplus(self, rep: SafetyReport, ca_l: str,
                      pair_address: str | None = None) -> bool:
        if not self.goplus_chain_id:
            rep.unavailable.extend(
                ["top_holder_pct", "lp_locked_pct", "honeypot",
                 "buy_tax_pct", "sell_tax_pct", "creator"])
            rep.flags.append("goplus_chain_id_unset")
            return False

        headers_params = {"contract_addresses": ca_l}
        data = http_get(GOPLUS_TOKEN.format(chain_id=self.goplus_chain_id),
                        params=headers_params, timeout=15)
        if not data or data.get("code") != 1:
            return False

        result = (data.get("result") or {}).get(ca_l)
        if not result:
            return False

        rep.sources.append("goplus")

        # -- honeypot / taxes -------------------------------------
        hp = result.get("is_honeypot")
        if hp is not None:
            rep.honeypot = hp == "1"
            if rep.honeypot and config.SAFETY["reject_on_honeypot"]:
                rep.hard_rejects.append("honeypot")
        else:
            rep.unavailable.append("honeypot")

        for field_name, key, limit in (
            ("buy_tax_pct",  "buy_tax",  config.SAFETY["max_buy_tax_pct"]),
            ("sell_tax_pct", "sell_tax", config.SAFETY["max_sell_tax_pct"]),
        ):
            raw = result.get(key)
            if raw in (None, ""):
                rep.unavailable.append(field_name)
                continue
            pct = safe_float(raw) * 100.0   # GoPlus returns a 0-1 fraction
            setattr(rep, field_name, round(pct, 2))
            if pct > limit:
                rep.hard_rejects.append(f"{key}_{pct:.0f}pct")

        # -- authorities ------------------------------------------
        mintable = result.get("is_mintable")
        if mintable is not None:
            rep.mint_authority = mintable == "1"
            if rep.mint_authority and config.SAFETY["reject_on_mint_auth"]:
                rep.hard_rejects.append("mintable")

        for key, flag in (
            ("is_blacklisted",         "blacklist_function"),
            ("can_take_back_ownership","ownership_reclaimable"),
            ("hidden_owner",           "hidden_owner"),
            ("selfdestruct",           "selfdestruct"),
            ("transfer_pausable",      "transfer_pausable"),
        ):
            if result.get(key) == "1":
                rep.flags.append(flag)

        if result.get("is_open_source") == "0":
            rep.flags.append("unverified_contract")

        # -- holder distribution ----------------------------------
        holders = result.get("holders")
        if holders:
            pcts = []
            skipped = 0
            for h in holders:
                addr = (h.get("address") or "").lower()
                if h.get("is_locked") in (1, "1"):
                    skipped += 1
                    continue          # locked/vested supply is not float risk
                if is_infrastructure_holder(addr, h.get("tag", ""), pair_address):
                    skipped += 1
                    continue          # pool / locker / bridge / burn
                pcts.append(safe_float(h.get("percent")) * 100.0)
            if skipped:
                rep.flags.append(f"excluded_{skipped}_infra_holders")
            pcts.sort(reverse=True)
            if pcts:
                rep.top_holder_pct = round(pcts[0], 2)
                rep.top10_pct = round(sum(pcts[:10]), 2)
                if rep.top_holder_pct > config.SAFETY["max_top_holder_pct"]:
                    rep.hard_rejects.append(f"top_holder_{rep.top_holder_pct:.0f}pct")
                if rep.top10_pct > config.SAFETY["max_top10_pct"]:
                    rep.hard_rejects.append(f"top10_{rep.top10_pct:.0f}pct")
        rep.holder_count = safe_int(result.get("holder_count")) or None

        # -- LP lock ----------------------------------------------
        lp_holders = result.get("lp_holders")
        if lp_holders:
            locked = 0.0
            for h in lp_holders:
                addr = (h.get("address") or "").lower()
                pct = safe_float(h.get("percent")) * 100.0
                if addr in BURN_ADDRESSES or h.get("is_locked") in (1, "1"):
                    locked += pct
            rep.lp_locked_pct = round(locked, 2)
            rep.has_graduated_pool = True
            if rep.lp_locked_pct < config.SAFETY["min_lp_locked_pct"]:
                rep.hard_rejects.append(f"lp_unlocked_{rep.lp_locked_pct:.0f}pct")

        # -- creator ----------------------------------------------
        creator = result.get("creator_address")
        if creator:
            rep.creator = creator
            cp = result.get("creator_percent")
            if cp not in (None, ""):
                rep.creator_holds_pct = round(safe_float(cp) * 100.0, 4)
        else:
            rep.unavailable.append("creator")

        return True

    # -- Blockscout fallback --------------------------------------
    def _apply_blockscout_holders(self, rep: SafetyReport, ca: str,
                                  pair_address: str | None = None) -> None:
        """Holder distribution from a Blockscout instance."""
        url = f"{self.blockscout.rstrip('/')}/api/v2/tokens/{ca}/holders"
        data = http_get(url, timeout=15)
        if not data:
            return
        items = data.get("items") if isinstance(data, dict) else None
        if not items:
            return

        token_info = data.get("token") or {}
        supply = safe_float(token_info.get("total_supply"))
        if supply <= 0:
            info = http_get(f"{self.blockscout.rstrip('/')}/api/v2/tokens/{ca}",
                            timeout=15) or {}
            supply = safe_float(info.get("total_supply"))
        if supply <= 0:
            return

        pcts, skipped = [], 0
        for h in items:
            a = h.get("address") or {}
            addr = (a.get("hash") or "").lower()
            tag = a.get("name") or a.get("implementation_name") or ""
            # Blockscout marks contracts — pools and lockers are contracts,
            # ordinary holders are not.
            if a.get("is_contract") or is_infrastructure_holder(addr, tag, pair_address):
                skipped += 1
                continue
            val = safe_float(h.get("value"))
            if val > 0:
                pcts.append(val / supply * 100.0)
        if skipped:
            rep.flags.append(f"excluded_{skipped}_infra_holders")
        if not pcts:
            return

        pcts.sort(reverse=True)
        rep.sources.append("blockscout")
        rep.top_holder_pct = round(pcts[0], 2)
        rep.top10_pct = round(sum(pcts[:10]), 2)
        for f in ("top_holder_pct", "top10_pct"):
            if f in rep.unavailable:
                rep.unavailable.remove(f)
        if rep.top_holder_pct > config.SAFETY["max_top_holder_pct"]:
            rep.hard_rejects.append(f"top_holder_{rep.top_holder_pct:.0f}pct")
        if rep.top10_pct > config.SAFETY["max_top10_pct"]:
            rep.hard_rejects.append(f"top10_{rep.top10_pct:.0f}pct")

    # ── CREATOR ACTIVITY ──────────────────────────────────────────
    def creator_activity(self, ca: str, creator: Optional[str] = None) -> CreatorActivity:
        """
        Deployer dump detection via Blockscout token transfers.
        Without a Blockscout instance for the chain this reports unavailable
        rather than a false 'clean'.
        """
        act = CreatorActivity(ca=ca, chain=self.key, creator=creator,
                              last_checked=int(time.time()))
        if not creator:
            creator = self.safety(ca).creator
            act.creator = creator
        if not creator:
            act.available = False
            act.note = "creator unknown"
            return act
        if not self.blockscout:
            act.available = False
            act.note = f"no blockscout instance configured for {self.key}"
            return act

        url = f"{self.blockscout.rstrip('/')}/api/v2/tokens/{ca}/transfers"
        data = http_get(url, timeout=15)
        items = (data or {}).get("items") or []
        creator_l = creator.lower()

        sold = 0.0
        for tr in items:
            frm = ((tr.get("from") or {}).get("hash") or "").lower()
            if frm != creator_l:
                continue
            total = tr.get("total") or {}
            val = safe_float(total.get("value"))
            dec = safe_int(total.get("decimals"), 18)
            sold += val / (10 ** dec) if dec else val

        if sold > 0:
            act.sold = True
            act.sold_amount = sold
        return act
