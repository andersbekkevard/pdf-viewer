#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Print local open aggregates, without source identifiers."""
import argparse
import json
import urllib.request
p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--daemon', default='http://127.0.0.1:7435')
p.add_argument('--json', action='store_true')
a = p.parse_args()
with urllib.request.urlopen(a.daemon.rstrip('/')+'/stats', timeout=10) as r:
    stats = json.load(r)['opens']
if a.json:
    print(json.dumps(stats, indent=2))
else:
    for days, s in stats.items():
        print(f"{days} days: {s['opens']} opens; reader {s['reader_share']:.1%}; first page p50/p95 {s['p50_first_page_ms']}/{s['p95_first_page_ms']} ms ({s['timing_samples']} samples)")
        for c, v in s['fallback_by_class'].items():
            print(f"  fallback {c}: {v['count']} ({v['share']:.1%})")
        for r in s['slowest_routes']:
            print(f"  {r['route']}: shell p50/p95 {r['p50_shell_ms']}/{r['p95_shell_ms']} ms")
