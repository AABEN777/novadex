"""
Solana adapter — DexScreener (market) + RugCheck (safety) + Helius (creator).

Carries over every v1 rule: top-holder cap, LP lock on graduated pools only,
danger flags, raw-score block. Difference from v1: when RugCheck times out we
record the gap in `unavailable` instead of letting the field default to zero.
"""

from __future__ import annotations

import time
from typing import Optional

import config
from chain_base import (
    ChainAdapter, SafetyReport, CreatorActivity,
    http_get, safe_float, safe_int,
)

RUGCHECK = "https://api.rugcheck.xyz/v1/tokens/{ca}/report"
HELIUS_TX = "https://api.helius.xyz/v0/addresses/{addr}/transactions"

# Bonding-curve pools are locked by construction — skip the LP check there.
BONDING_CURVE_MARKETS = {"pump_fun_amm", "pumpfun", "moonshot", "bonk_curve"}

CREATOR_RUG_PATTERNS = ("rugged", "creator history", "previous rug")


class SolanaAdapter(ChainAdapter):

    def __init__(self):
        super().__init__("solana")

    # ── SAFETY ────────────────────────────────────────────────────
    def safety(self, ca: str, pair_address: str | None = None) -> SafetyReport:
        rep = SafetyReport(ca=ca, chain=self.key)
        data = http_get(RUGCHECK.format(ca=ca), timeout=15)

        if not data or not isinstance(data, dict):
            rep.unavailable = [
                "top_holder_pct", "top10_pct", "lp_locked_pct",
                "mint_authority", "freeze_authority", "creator", "risk_raw",
            ]
            rep.flags.append("rugcheck_unreachable")
            return rep

        rep.sources.append("rugcheck")

        # -- hard kill switches ------------------------------------
        if data.get("rugged") is True:
            rep.hard_rejects.append("rugged")

        token = data.get("token") or {}
        mint_auth = token.get("mintAuthority")
        freeze_auth = token.get("freezeAuthority")
        rep.mint_authority = bool(mint_auth) and mint_auth != "null"
        rep.freeze_authority = bool(freeze_auth) and freeze_auth != "null"
        if rep.mint_authority and config.SAFETY["reject_on_mint_auth"]:
            rep.hard_rejects.append("mint_authority_active")
        if rep.freeze_authority and config.SAFETY["reject_on_freeze"]:
            rep.hard_rejects.append("freeze_authority_active")

        # -- raw risk score ---------------------------------------
        score = data.get("score")
        if score is None:
            rep.unavailable.append("risk_raw")
        else:
            rep.risk_raw = safe_float(score)
            rep.risk_scale = "rugcheck:lower_is_safer"
            if rep.risk_raw > config.SAFETY["rugcheck_raw_block"]:
                rep.hard_rejects.append(f"risk_score_{rep.risk_raw:g}")

        # -- danger flags -----------------------------------------
        risks = data.get("risks") or []
        for r in risks:
            name = (r.get("name") or "").strip()
            if not name:
                continue
            level = (r.get("level") or "").lower()
            rep.flags.append(name)
            if level == "danger":
                low = name.lower()
                if (config.SAFETY["reject_creator_rug_history"]
                        and any(p in low for p in CREATOR_RUG_PATTERNS)):
                    rep.hard_rejects.append("creator_rug_history")

        # -- holder distribution ----------------------------------
        holders = data.get("topHolders")
        if not holders:
            rep.unavailable.extend(["top_holder_pct", "top10_pct"])
        else:
            outside = [h for h in holders if not h.get("insider")]
            pcts = sorted((safe_float(h.get("pct")) for h in outside), reverse=True)
            if pcts:
                rep.top_holder_pct = pcts[0]
                rep.top10_pct = sum(pcts[:10])
                if rep.top_holder_pct > config.SAFETY["max_top_holder_pct"]:
                    rep.hard_rejects.append(
                        f"top_holder_{rep.top_holder_pct:.0f}pct")
                if rep.top10_pct > config.SAFETY["max_top10_pct"]:
                    rep.hard_rejects.append(f"top10_{rep.top10_pct:.0f}pct")
            else:
                rep.unavailable.extend(["top_holder_pct", "top10_pct"])
        rep.holder_count = safe_int(data.get("totalHolders")) or None

        # -- LP lock, graduated pools only ------------------------
        markets = data.get("markets")
        if markets is None:
            rep.unavailable.append("lp_locked_pct")
        else:
            graduated = [m for m in markets
                         if (m.get("marketType") or "") not in BONDING_CURVE_MARKETS]
            rep.has_graduated_pool = bool(graduated)
            if not graduated:
                # Still on the curve — LP lock is not a meaningful question.
                rep.lp_locked_pct = 100.0
                rep.flags.append("bonding_curve")
            else:
                locks = [safe_float((m.get("lp") or {}).get("lpLockedPct"))
                         for m in graduated]
                locks = [x for x in locks if x is not None]
                if not locks:
                    rep.unavailable.append("lp_locked_pct")
                else:
                    rep.lp_locked_pct = max(locks)
                    if rep.lp_locked_pct < config.SAFETY["min_lp_locked_pct"]:
                        rep.hard_rejects.append(
                            f"lp_unlocked_{rep.lp_locked_pct:.0f}pct")

        # -- creator ----------------------------------------------
        creator = data.get("creator")
        if creator and creator != "11111111111111111111111111111111":
            rep.creator = creator
            supply = safe_float(token.get("supply"))
            bal = safe_float(data.get("creatorBalance"))
            if supply > 0:
                rep.creator_holds_pct = round(bal / supply * 100, 4)
        else:
            rep.unavailable.append("creator")

        return self.apply_common_gates(rep)

    # ── CREATOR ACTIVITY ──────────────────────────────────────────
    def creator_activity(self, ca: str, creator: Optional[str] = None) -> CreatorActivity:
        act = CreatorActivity(ca=ca, chain=self.key, creator=creator,
                              last_checked=int(time.time()))

        if not config.HELIUS_API_KEY:
            act.available = False
            act.note = "HELIUS_API_KEY not set"
            return act

        if not creator:
            rep = self.safety(ca)
            creator = rep.creator
            act.creator = creator
        if not creator:
            act.available = False
            act.note = "creator unknown"
            return act

        txs = http_get(
            HELIUS_TX.format(addr=creator),
            params={"api-key": config.HELIUS_API_KEY, "limit": 25},
            timeout=15,
        )
        if not isinstance(txs, list):
            act.available = False
            act.note = "helius unreachable"
            return act

        sold_total = 0.0
        for tx in txs:
            if tx.get("type") != "SWAP":
                continue
            for tr in (tx.get("tokenTransfers") or []):
                if tr.get("mint") != ca:
                    continue
                # Tokens leaving a creator-associated account = distribution.
                if tr.get("fromUserAccount"):
                    sold_total += safe_float(tr.get("tokenAmount"))

        if sold_total > 10_000:
            act.sold = True
            act.sold_amount = sold_total
        return act
