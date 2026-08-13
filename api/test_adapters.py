#!/usr/bin/env python3
"""
Adapter smoke test. Run this before wiring anything else up.

    python3 test_adapters.py              # every enabled chain
    python3 test_adapters.py base         # one chain
    python3 test_adapters.py <CA>         # analyse a specific token

For each chain it discovers a live token, pulls market data, runs the
safety check, and prints exactly which fields came back and which did
not. A chain that reports "top_holder_pct: UNAVAILABLE" is telling you
its safety source needs configuring — not that the token is clean.
"""

import sys

import config
from chains import get_adapter, active_adapters, resolve_chain


def line(c="-", n=64):
    print(c * n)


def show_market(m):
    if not m.ok:
        print(f"  market:  FAILED ({m.error})")
        return False
    print(f"  token:   {m.name} ({m.symbol})")
    print(f"  price:   ${m.price_usd:.8f}".rstrip("0").rstrip("."))
    print(f"  liq:     ${m.liquidity_usd:,.0f}   fdv: ${m.fdv:,.0f}")
    print(f"  vol24h:  ${m.volume_24h:,.0f}   vol5m: ${m.volume_5m:,.0f}")
    print(f"  change:  5m {m.change_5m:+.1f}%  1h {m.change_1h:+.1f}%  "
          f"24h {m.change_24h:+.1f}%")
    print(f"  txns5m:  {m.buys_5m} buys / {m.sells_5m} sells")
    print(f"  age:     {m.age_hours:.2f}h    dex: {m.dex}"
          f"{'   launchpad: ' + m.launchpad if m.launchpad else ''}")
    issues = m.sanity_issues
    print(f"  data:    {'TRUSTWORTHY' if not issues else 'SUSPECT — ' + ', '.join(issues)}")
    return True


def show_safety(s):
    print(f"  sources: {', '.join(s.sources) or 'NONE'}")
    fields = [
        ("top_holder_pct",  "%"), ("top10_pct", "%"), ("lp_locked_pct", "%"),
        ("holder_count",    ""),  ("buy_tax_pct", "%"), ("sell_tax_pct", "%"),
        ("honeypot",        ""),  ("mint_authority", ""), ("freeze_authority", ""),
        ("creator_holds_pct","%"),("risk_raw", ""),
    ]
    for name, unit in fields:
        val = getattr(s, name)
        if val is None:
            state = "UNAVAILABLE" if name in s.unavailable else "not applicable"
            print(f"  {name:<18} {state}")
        else:
            print(f"  {name:<18} {val}{unit}")
    print(f"  creator: {s.creator or 'unknown'}")
    if s.flags:
        print(f"  flags:   {', '.join(s.flags[:6])}")
    print(f"  verdict: {s.verdict}")
    if s.hard_rejects:
        print(f"  reasons: {', '.join(s.hard_rejects)}")
    print(f"  display: {s.display()}")


def test_chain(key: str) -> bool:
    ad = get_adapter(key)
    line("=")
    print(f"{ad.display}  [{key}]")
    line("=")

    try:
        bd = ad.discover_breakdown()
        print(f"  discovered: geckoterminal={bd['geckoterminal']}  "
              f"dexscreener={bd['dexscreener']}  merged={bd['merged']}")
    except Exception as e:
        print(f"  discovery breakdown failed: {e}")
    cas = ad.discover()
    if not cas:
        print("  -> nothing to test (chain may have no promoted tokens now)")
        return False

    # Prefer a young token — that is what Surgeon actually hunts. Scanning a
    # 74-day-old $15m coin tells us nothing about early-detection quality.
    picked = None
    for ca in cas[:8]:
        m = ad.market(ca)
        if not (m.ok and m.liquidity_usd > 0):
            continue
        if picked is None or m.age_hours < picked[1].age_hours:
            picked = (ca, m)
        if m.age_hours < 6:
            break

    if picked:
        ca, m = picked
        if True:
            print(f"\n  testing {ca}")
            line()
            show_market(m)
            print()
            show_safety(ad.safety(ca, m.pair_address))
            print(f"\n  chart:   {ad.chart_url(ca)}")
            return True
    print("  -> no candidate had a live pair on this chain")
    return False


def test_ca(ca: str):
    key, m = resolve_chain(ca)
    line("=")
    if not key:
        print(f"could not resolve {ca} on any enabled chain")
        print(f"enabled: {', '.join(config.enabled_chains())}")
        return
    ad = get_adapter(key)
    print(f"{ca}\nresolved to {ad.display}")
    line("=")
    show_market(m)
    print()
    show_safety(ad.safety(ca, m.pair_address))
    print(f"\n  explorer: {ad.explorer_url(ca)}")
    print(f"  chart:    {ad.chart_url(ca)}")


def main() -> int:
    arg = sys.argv[1] if len(sys.argv) > 1 else None

    if arg and arg in config.CHAINS:
        test_chain(arg)
    elif arg:
        test_ca(arg)
    else:
        results = {}
        for ad in active_adapters():
            try:
                results[ad.key] = test_chain(ad.key)
            except Exception as e:
                print(f"  !! {ad.key} raised: {e}")
                results[ad.key] = False
            print()
        line("=")
        print("SUMMARY")
        line("=")
        for k, ok in results.items():
            print(f"  {'OK  ' if ok else 'FAIL'}  {config.CHAINS[k]['display']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
