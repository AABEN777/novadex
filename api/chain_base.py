"""
Chain adapter contract.

Every chain implements these six methods. The scoring core, alert
formatter, social tracker and position watcher never import a chain
module directly — they go through the registry. Adding a chain means
writing one adapter and flipping enabled=True in config.CHAINS.
"""

from __future__ import annotations

import re
import time
import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field, asdict
from typing import Optional

import requests

import config

log = logging.getLogger("surgeon.chains")


# ── SHARED SHAPES ─────────────────────────────────────────────────

@dataclass
class TokenMarket:
    """Normalised market snapshot. Same shape on every chain."""
    ca: str
    chain: str
    name: str = "Unknown"
    symbol: str = "???"
    price_usd: float = 0.0
    liquidity_usd: float = 0.0
    fdv: float = 0.0
    market_cap: float = 0.0
    volume_24h: float = 0.0
    volume_6h: float = 0.0
    volume_1h: float = 0.0
    volume_5m: float = 0.0
    change_24h: float = 0.0
    change_6h: float = 0.0
    change_1h: float = 0.0
    change_5m: float = 0.0
    buys_5m: int = 0
    sells_5m: int = 0
    buys_1h: int = 0
    sells_1h: int = 0
    age_hours: float = 999.0
    age_known: bool = False
    dex: str = ""
    pair_address: str = ""
    launchpad: Optional[str] = None
    ok: bool = True
    error: Optional[str] = None

    @property
    def buy_ratio_5m(self) -> Optional[float]:
        if self.sells_5m <= 0:
            return None if self.buys_5m == 0 else float("inf")
        return self.buys_5m / self.sells_5m

    @property
    def vol_fdv_ratio(self) -> float:
        return (self.volume_24h / self.fdv) if self.fdv > 0 else 0.0

    @property
    def sanity_issues(self) -> list[str]:
        return market_sanity(self)

    @property
    def trustworthy(self) -> bool:
        return not self.sanity_issues

    def as_dict(self) -> dict:
        return asdict(self)


@dataclass
class SafetyReport:
    """
    Normalised safety snapshot.

    The important field is `unavailable`. v1 defaulted missing values to
    zero, which rendered as "Top holder: 0%" on a token nobody had
    checked. Anything we could not fetch is named here and the alert
    says so out loud.
    """
    ca: str
    chain: str
    sources: list[str] = field(default_factory=list)
    top_holder_pct: Optional[float] = None
    top10_pct: Optional[float] = None
    holder_count: Optional[int] = None
    lp_locked_pct: Optional[float] = None
    has_graduated_pool: Optional[bool] = None
    mint_authority: Optional[bool] = None
    freeze_authority: Optional[bool] = None
    honeypot: Optional[bool] = None
    buy_tax_pct: Optional[float] = None
    sell_tax_pct: Optional[float] = None
    creator: Optional[str] = None
    creator_holds_pct: Optional[float] = None
    risk_raw: Optional[float] = None          # chain-native score, display only
    risk_scale: Optional[str] = None          # e.g. "rugcheck:lower_is_safer"
    flags: list[str] = field(default_factory=list)
    hard_rejects: list[str] = field(default_factory=list)
    unavailable: list[str] = field(default_factory=list)

    @property
    def partial(self) -> bool:
        return bool(self.unavailable)

    @property
    def verified(self) -> bool:
        """Did any safety source actually answer?"""
        return bool(self.sources)

    @property
    def verdict(self) -> str:
        """REJECT | UNVERIFIED | PASS_PARTIAL | PASS"""
        if self.hard_rejects:
            return "REJECT"
        if not self.sources:
            return "UNVERIFIED"
        return "PASS_PARTIAL" if self.partial else "PASS"

    @property
    def passed(self) -> bool:
        # An unanswered safety check is not a pass. v1 treated silence as
        # consent and that is how clean-looking rugs got through.
        return self.verdict in ("PASS", "PASS_PARTIAL")

    def display(self) -> str:
        """One-line summary for alerts. Never invents a number."""
        bits = []
        if self.top_holder_pct is not None:
            bits.append(f"Top holder {self.top_holder_pct:.1f}%")
        elif "top_holder_pct" in self.unavailable:
            bits.append("Top holder n/a")
        if self.lp_locked_pct is not None:
            bits.append(f"LP {self.lp_locked_pct:.0f}% locked")
        elif "lp_locked_pct" in self.unavailable:
            bits.append("LP n/a")
        if self.risk_raw is not None:
            bits.append(f"Risk {self.risk_raw:g}")
        if self.buy_tax_pct is not None or self.sell_tax_pct is not None:
            b = self.buy_tax_pct if self.buy_tax_pct is not None else 0
            s = self.sell_tax_pct if self.sell_tax_pct is not None else 0
            if b or s:
                bits.append(f"Tax {b:g}/{s:g}%")
        if not self.sources:
            return "UNVERIFIED — no safety source could answer"
        if not bits:
            return "UNVERIFIED — safety data unavailable"
        out = " · ".join(bits)
        if self.partial:
            out += f"  (partial — {', '.join(self.sources)})"
        return out

    def as_dict(self) -> dict:
        d = asdict(self)
        d["partial"] = self.partial
        d["verified"] = self.verified
        d["verdict"] = self.verdict
        d["passed"] = self.passed
        return d


@dataclass
class CreatorActivity:
    ca: str
    chain: str
    creator: Optional[str] = None
    sold: bool = False
    sold_amount: float = 0.0
    last_checked: int = 0
    available: bool = True
    note: Optional[str] = None


# ── HTTP HELPER ───────────────────────────────────────────────────

_session = requests.Session()
_session.headers.update({"User-Agent": config.USER_AGENT})


class _Throttle:
    """Minimum spacing between calls to one host. GeckoTerminal's free tier
    is ~30 req/min and answers 429 the moment you exceed it."""

    def __init__(self, min_interval: float):
        self.min_interval = min_interval
        self._last = 0.0

    def wait(self):
        gap = time.monotonic() - self._last
        if gap < self.min_interval:
            time.sleep(self.min_interval - gap)
        self._last = time.monotonic()


_GT_THROTTLE = _Throttle(3.0)          # GitHub runners share egress IPs with
                                       # other GeckoTerminal users, so the
                                       # practical ceiling is below 30/min
_DISCOVERY_CACHE: dict = {}            # (source, network) -> (ts, result)
_DISCOVERY_TTL = 90                    # seconds


def http_get(url: str, params: dict | None = None,
             timeout: int | None = None, retries: int | None = None):
    """GET with retry/backoff. Returns parsed JSON or None. Never raises."""
    timeout = timeout or config.HTTP_TIMEOUT
    retries = config.HTTP_RETRIES if retries is None else retries
    delay = 1.0
    for attempt in range(retries + 1):
        try:
            r = _session.get(url, params=params, timeout=timeout)
            if r.status_code == 200:
                return r.json()
            if r.status_code in (429, 500, 502, 503, 504) and attempt < retries:
                time.sleep(delay * (4 if r.status_code == 429 else 1))
                delay *= config.HTTP_BACKOFF
                continue
            log.warning("GET %s -> HTTP %s", url, r.status_code)
            return None
        except Exception as e:
            if attempt < retries:
                time.sleep(delay)
                delay *= config.HTTP_BACKOFF
                continue
            log.warning("GET %s failed: %s", url, e)
            return None
    return None


def safe_float(v, default=0.0) -> float:
    try:
        if v is None:
            return default
        return float(v)
    except (TypeError, ValueError):
        return default


def safe_int(v, default=0) -> int:
    try:
        if v is None:
            return default
        return int(v)
    except (TypeError, ValueError):
        return default


# ── DEXSCREENER (shared by every chain) ───────────────────────────

DEX_BASE = "https://api.dexscreener.com"


GT_BASE = "https://api.geckoterminal.com/api/v2"


def geckoterminal_discover(network: str, pages: int = 2) -> list[str]:
    """
    Newest and trending pools for a network, via GeckoTerminal.

    DexScreener's profile/boost feeds only surface tokens whose devs paid to
    promote them — that is 49 candidates on Solana but 2 on Base. This is the
    real new-pair firehose: free, no key, ~30 req/min.
    """
    if not network:
        return []

    key = ("gt", network, pages)
    hit = _DISCOVERY_CACHE.get(key)
    if hit and (time.time() - hit[0]) < _DISCOVERY_TTL:
        return hit[1]

    found, seen = [], set()
    urls = [f"{GT_BASE}/networks/{network}/new_pools"]
    urls += [f"{GT_BASE}/networks/{network}/new_pools?page={p}" for p in range(2, pages + 1)]
    urls.append(f"{GT_BASE}/networks/{network}/trending_pools")

    for url in urls:
        _GT_THROTTLE.wait()
        data = http_get(url, retries=3)
        if not isinstance(data, dict):
            continue
        for pool in (data.get("data") or []):
            rel = ((pool.get("relationships") or {}).get("base_token") or {}).get("data") or {}
            token_id = rel.get("id") or ""
            # ids look like "base_0xabc..." / "solana_9xQ..."
            ca = token_id.split("_", 1)[1] if "_" in token_id else token_id
            if ca and ca not in seen:
                seen.add(ca)
                found.append(ca)

    _DISCOVERY_CACHE[key] = (time.time(), found)
    return found


def dexscreener_discover(chain_id: str) -> list[str]:
    """
    Candidate CAs for a chain from DexScreener's public discovery feeds.
    Promoted tokens only — thin on newer chains. Use alongside GeckoTerminal.
    """
    key = ("ds", chain_id)
    hit = _DISCOVERY_CACHE.get(key)
    if hit and (time.time() - hit[0]) < _DISCOVERY_TTL:
        return hit[1]

    found, seen = [], set()
    endpoints = [
        f"{DEX_BASE}/token-profiles/latest/v1",
        f"{DEX_BASE}/token-boosts/latest/v1",
        f"{DEX_BASE}/token-boosts/top/v1",
    ]
    for url in endpoints:
        data = http_get(url)
        if not isinstance(data, list):
            continue
        for item in data:
            if not isinstance(item, dict):
                continue
            if item.get("chainId") != chain_id:
                continue
            ca = item.get("tokenAddress")
            if ca and ca not in seen:
                seen.add(ca)
                found.append(ca)

    _DISCOVERY_CACHE[key] = (time.time(), found)
    return found


def dexscreener_market(ca: str, chain: str, chain_id: str) -> TokenMarket:
    """Fetch and normalise the deepest pair for a token on one chain."""
    data = http_get(f"{DEX_BASE}/latest/dex/tokens/{ca}")
    if not data:
        return TokenMarket(ca=ca, chain=chain, ok=False, error="dexscreener_unreachable")

    pairs = [p for p in (data.get("pairs") or []) if p.get("chainId") == chain_id]
    if not pairs:
        return TokenMarket(ca=ca, chain=chain, ok=False, error="no_pairs")

    # Deepest liquidity is the honest reference pool.
    pair = max(pairs, key=lambda p: safe_float((p.get("liquidity") or {}).get("usd")))

    vol   = pair.get("volume") or {}
    chg   = pair.get("priceChange") or {}
    txns  = pair.get("txns") or {}
    t5m   = txns.get("m5") or {}
    t1h   = txns.get("h1") or {}
    base  = pair.get("baseToken") or {}

    created_ms = safe_float(pair.get("pairCreatedAt"), 0)
    age_known = created_ms > 0
    age_hours = ((time.time() * 1000) - created_ms) / 3_600_000 if age_known else 999.0

    return TokenMarket(
        ca=ca,
        chain=chain,
        name=base.get("name") or "Unknown",
        symbol=base.get("symbol") or "???",
        price_usd=safe_float(pair.get("priceUsd")),
        liquidity_usd=safe_float((pair.get("liquidity") or {}).get("usd")),
        fdv=safe_float(pair.get("fdv")),
        market_cap=safe_float(pair.get("marketCap")),
        volume_24h=safe_float(vol.get("h24")),
        volume_6h=safe_float(vol.get("h6")),
        volume_1h=safe_float(vol.get("h1")),
        volume_5m=safe_float(vol.get("m5")),
        change_24h=safe_float(chg.get("h24")),
        change_6h=safe_float(chg.get("h6")),
        change_1h=safe_float(chg.get("h1")),
        change_5m=safe_float(chg.get("m5")),
        buys_5m=safe_int(t5m.get("buys")),
        sells_5m=safe_int(t5m.get("sells")),
        buys_1h=safe_int(t1h.get("buys")),
        sells_1h=safe_int(t1h.get("sells")),
        age_hours=round(age_hours, 4),
        age_known=age_known,
        dex=pair.get("dexId") or "",
        pair_address=pair.get("pairAddress") or "",
        launchpad=detect_launchpad(ca, pair),
    )


BURN_ADDRESSES = {
    "0x0000000000000000000000000000000000000000",
    "0x000000000000000000000000000000000000dead",
    "11111111111111111111111111111111",
}

NON_HOLDER_TAGS = (
    "pair", "pool", " lp", "liquidity", "router", "dex", "amm",
    "lock", "vault", "bridge", "burn", "staking", "curve", "escrow",
)


def is_infrastructure_holder(addr: str, tag: str = "",
                             pair_address: str | None = None) -> bool:
    """
    True when a "holder" is really a pool, locker, bridge or burn address.

    Counting these as whales is why a healthy ten-minute-old token reads as
    50-100% concentrated: most of its float sits in the LP by design.
    """
    a = (addr or "").lower()
    if a in BURN_ADDRESSES:
        return True
    if pair_address and a == pair_address.lower():
        return True
    low = (tag or "").lower()
    return bool(low) and any(k in low for k in NON_HOLDER_TAGS)


def market_sanity(m: "TokenMarket") -> list[str]:
    """
    Reasons this market snapshot should not be trusted.

    A pair minutes old often reports nonsense. Scoring garbage as if it were
    momentum is how a 1-holder contract ends up looking like a 1700%-in-5min
    breakout.
    """
    s = config.SANITY
    bad = []
    if not m.age_known:
        bad.append("age_unknown")   # pairCreatedAt absent, not "very old"
    if m.liquidity_usd < s["min_liquidity_usd"]:
        bad.append(f"liquidity_${m.liquidity_usd:,.0f}")
    if m.liquidity_usd > 0 and m.fdv > 0:
        ratio = m.fdv / m.liquidity_usd
        if ratio > s["max_fdv_liq_ratio"]:
            bad.append(f"fdv_{ratio:,.0f}x_liquidity")
    for label, val in (("5m", m.change_5m), ("1h", m.change_1h),
                       ("24h", m.change_24h)):
        if abs(val) > s["max_abs_change_pct"]:
            bad.append(f"change_{label}_implausible")
    if not m.dex or m.dex == "unknown":
        bad.append("dex_unknown")
    return bad


def detect_launchpad(ca: str, pair: dict) -> Optional[str]:
    dex = (pair.get("dexId") or "").lower()
    labels = " ".join(str(x).lower() for x in (pair.get("labels") or []))
    if ca.lower().endswith("pump") or "pump" in dex:
        return "pumpfun"
    if "bonk" in dex or "bonk" in labels:
        return "letsbonk"
    if "moonshot" in dex:
        return "moonshot"
    if "four" in dex or "fourmeme" in labels:
        return "fourmeme"
    return None


# ── ADAPTER ABC ───────────────────────────────────────────────────

class ChainAdapter(ABC):
    key: str = ""

    def __init__(self, key: str):
        self.key = key
        self.cfg = config.CHAINS[key]
        self.chain_id = self.cfg["dexscreener_id"]

    # -- identity -------------------------------------------------
    @property
    def display(self) -> str:
        return self.cfg["display"]

    def validate_address(self, addr: str) -> bool:
        return bool(re.match(self.cfg["addr_regex"], (addr or "").strip()))

    def explorer_url(self, ca: str) -> str:
        return self.cfg["explorer"].format(ca=ca)

    def chart_url(self, ca: str) -> str:
        return self.cfg["chart"].format(ca=ca)

    # -- data -----------------------------------------------------
    def discover(self) -> list[str]:
        """
        New pools first (GeckoTerminal), then promoted tokens (DexScreener).
        Deduped, order preserved — freshest launches lead.
        """
        out, seen = [], set()
        for src in (geckoterminal_discover(self.cfg.get("geckoterminal_id")),
                    dexscreener_discover(self.chain_id)):
            for ca in src:
                if ca not in seen:
                    seen.add(ca)
                    out.append(ca)
        return out

    def discover_breakdown(self) -> dict:
        """Per-source counts — used by the verify workflow."""
        gt = geckoterminal_discover(self.cfg.get("geckoterminal_id"))
        ds = dexscreener_discover(self.chain_id)
        return {"geckoterminal": len(gt), "dexscreener": len(ds),
                "merged": len(set(gt) | set(ds))}

    def market(self, ca: str) -> TokenMarket:
        return dexscreener_market(ca, self.key, self.chain_id)

    @staticmethod
    def apply_common_gates(rep: SafetyReport) -> SafetyReport:
        """
        Chain-independent rejects that run after every adapter's own checks.
        These exist because a missing top_holder_pct used to mean no holder
        check happened at all.
        """
        s = config.SAFETY

        if (rep.creator_holds_pct is not None
                and rep.creator_holds_pct > s["max_creator_holds_pct"]):
            rep.hard_rejects.append(f"creator_holds_{rep.creator_holds_pct:.0f}pct")

        if (rep.holder_count is not None
                and rep.holder_count < s["min_holder_count"]):
            rep.hard_rejects.append(f"only_{rep.holder_count}_holders")

        if (s["reject_unverified_contract_if_thin"]
                and "unverified_contract" in rep.flags
                and (rep.holder_count is None or rep.holder_count < 50)):
            rep.hard_rejects.append("unverified_contract_thin_holders")

        return rep

    @abstractmethod
    def safety(self, ca: str, pair_address: str | None = None) -> SafetyReport:
        """
        Holder distribution, LP lock, authorities, taxes, creator.

        pair_address, when known, is excluded from holder concentration —
        the liquidity pool holding most of the float is the normal case,
        not a whale.
        """

    @abstractmethod
    def creator_activity(self, ca: str, creator: str | None = None) -> CreatorActivity:
        """Has the deployer dumped since launch?"""

    def __repr__(self) -> str:
        return f"<{self.__class__.__name__} {self.key}>"
