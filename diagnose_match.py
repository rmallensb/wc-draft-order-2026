"""One-off diagnostic: print the raw shape of football-data.org's per-match
response for a recent finished match. Helps us figure out whether goal events
are missing because of a free-tier limit or a parsing bug.

Usage:
    .venv/bin/python diagnose_match.py
"""

import json
from datetime import datetime, timedelta
from pathlib import Path

import requests

ROOT = Path(__file__).parent
API_BASE = "https://api.football-data.org/v4/matches"


def load_api_key() -> str:
    for line in (ROOT / ".env").read_text().splitlines():
        if line.startswith("FOOTBALL_DATA_API_KEY="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("FOOTBALL_DATA_API_KEY not found in .env")


def pick_match() -> dict:
    matches = json.loads((ROOT / "data" / "results.json").read_text())["matches"]
    # Prefer a high-scoring finished match (more likely to expose goal events if available)
    finished = [
        m for m in matches
        if m.get("status") == "FINISHED"
        and (m.get("homeGoals") or 0) + (m.get("awayGoals") or 0) >= 4
    ]
    if not finished:
        finished = [m for m in matches if m.get("status") == "FINISHED"]
    if not finished:
        raise SystemExit("No finished matches found in data/results.json — run `make sync` first.")
    return finished[0]


ALIASES = {
    "usa": ["united states"],
    "south korea": ["korea republic", "republic of korea"],
    "ivory coast": ["côte d'ivoire", "cote d'ivoire"],
    "turkey": ["türkiye"],
    "türkiye": ["turkey"],
    "czech republic": ["czechia"],
    "czechia": ["czech republic"],
}


def name_candidates(name: str) -> list:
    n = name.lower().strip()
    return [n] + ALIASES.get(n, [])


def _probe_espn_date(home: str, away: str, date_yyyymmdd: str):
    base = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world"
    sb = requests.get(f"{base}/scoreboard?dates={date_yyyymmdd}", timeout=30)
    if not sb.ok:
        return None, []
    events = sb.json().get("events", [])
    home_opts = name_candidates(home)
    away_opts = name_candidates(away)
    target = None
    for e in events:
        name = e.get("name", "").lower()
        if any(h in name for h in home_opts) and any(a in name for a in away_opts):
            target = e
            break
    if not target:
        for e in events:
            comps = (e.get("competitions") or [{}])[0].get("competitors", [])
            names = [c.get("team", {}).get("displayName", "").lower() for c in comps]
            if any(any(h in n for n in names) for h in home_opts) and any(any(a in n for n in names) for a in away_opts):
                target = e
                break
    return target, events


def probe_espn(home: str, away: str, utc_date: str) -> None:
    """Confirm ESPN has 2026 WC coverage and surface goal events."""
    print("\n--- Probing ESPN (unofficial) ---")
    print(f"Looking for: {home} vs {away}")
    print(f"utcDate: {utc_date}")
    if not utc_date:
        print("No utcDate, skipping ESPN probe.")
        return

    base = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world"
    base_date = datetime.strptime(utc_date[:10], "%Y-%m-%d")
    target = None
    found_date = None
    for delta in (0, -1, 1, -2, 2):
        d = base_date + timedelta(days=delta)
        ddmd = d.strftime("%Y%m%d")
        print(f"  trying date={ddmd} (delta {delta:+d})")
        t, events = _probe_espn_date(home, away, ddmd)
        print(f"    events returned: {len(events)}")
        for e in events[:6]:
            print(f"      - id={e.get('id')} name={e.get('name')!r}")
        if t:
            target = t
            found_date = ddmd
            print(f"    MATCH found on {ddmd}")
            break

    if not target:
        print("  No matching event found across ±2 days. ESPN may name teams differently.")
        return

    print(f"  Match found: id={target.get('id')} name={target.get('name')}")
    summary_url = f"{base}/summary?event={target.get('id')}"
    print(f"GET {summary_url}")
    summary = requests.get(summary_url, timeout=30)
    print(f"  HTTP {summary.status_code}")
    if not summary.ok:
        print(f"  body: {summary.text[:300]}")
        return

    sd = summary.json()
    print(f"  Top-level keys: {sorted(sd.keys())}")

    key_events = sd.get("keyEvents") or []
    print(f"  keyEvents: {len(key_events)} items")

    # Group keyEvents by type.text to see categories
    types = {}
    for e in key_events:
        label = (e.get("type") or {}).get("text", "?")
        types[label] = types.get(label, 0) + 1
    print(f"  keyEvents types: {types}")

    # Print the first goal event in full so we can see scorer field structure
    goal_events = [e for e in key_events if (e.get("type") or {}).get("type") == "goal" or e.get("scoringPlay")]
    print(f"\n  Goal events: {len(goal_events)}")
    if goal_events:
        print(f"  Full structure of first goal:\n{json.dumps(goal_events[0], indent=2)}")
        print(f"\n  Compact list of all goals:")
        for g in goal_events:
            clock = (g.get("clock") or {}).get("displayValue", "?")
            team = (g.get("team") or {}).get("displayName") or "?"
            text = g.get("text", "")
            print(f"    {clock} [{team}] {text}")


def main() -> None:
    key = load_api_key()
    m = pick_match()
    print(f"Testing match {m['id']}: {m['home']} {m['homeGoals']}-{m['awayGoals']} {m['away']}")

    resp = requests.get(f"{API_BASE}/{m['id']}", headers={"X-Auth-Token": key}, timeout=30)
    print(f"HTTP {resp.status_code}")
    if not resp.ok:
        print(resp.text[:500])
        return

    data = resp.json()
    print(f"Top-level keys: {sorted(data.keys())}")
    match = data.get("match", data)
    print(f"Match keys: {sorted(match.keys())}")

    goals = match.get("goals")
    print(f"goals field: type={type(goals).__name__}, value={goals!r}")

    # Other fields that might hold goal events on different tiers
    for alt in ("events", "incidents", "scorers", "matchEvents"):
        if alt in match:
            print(f"{alt!r}: {match[alt]!r}")

    # Show the resourceSet / availability info football-data.org sometimes includes
    if "resultSet" in data:
        print(f"resultSet: {data['resultSet']!r}")
    if "filters" in data:
        print(f"filters: {data['filters']!r}")

    probe_espn(m["home"], m["away"], m.get("utcDate", ""))


if __name__ == "__main__":
    main()
