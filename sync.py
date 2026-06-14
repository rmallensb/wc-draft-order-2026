"""Fetch 2026 FIFA World Cup match data from football-data.org and recompute
results.json for the static site.

Usage:
    FOOTBALL_DATA_API_KEY=<key> python sync.py

Get a free key at https://www.football-data.org/client/register
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests

DATA_DIR = Path(__file__).parent / "data"
API_URL = "https://api.football-data.org/v4/competitions/WC/matches"

STAGE_RANK = {
    "GROUP_STAGE": 0,
    "LAST_32": 1,
    "LAST_16": 2,
    "QUARTER_FINALS": 3,
    "SEMI_FINALS": 4,
    "FINAL": 5,
    "THIRD_PLACE": 4,  # treated as semifinal exit
}


def load_json(name: str) -> dict[str, Any]:
    with (DATA_DIR / name).open() as f:
        return json.load(f)


def fetch_matches(api_key: str) -> list[dict[str, Any]]:
    try:
        resp = requests.get(API_URL, headers={"X-Auth-Token": api_key}, timeout=30)
    except requests.RequestException as e:
        sys.exit(f"Network error contacting football-data.org: {e}")
    if resp.status_code != 200:
        sys.exit(f"football-data.org returned HTTP {resp.status_code}: {resp.text[:500]}")
    return resp.json().get("matches", [])


def build_team_index(teams_doc: dict[str, Any]) -> tuple[dict[str, dict], dict[str, str]]:
    """Returns (teams_by_name, api_name_to_name).

    teams_by_name keys by canonical league name ("Türkiye", "USA", ...);
    api_name_to_name maps the API's team string -> canonical name.
    """
    by_name: dict[str, dict] = {}
    api_lookup: dict[str, str] = {}
    for pot_id, pot in teams_doc["pots"].items():
        for t in pot["teams"]:
            row = {**t, "pot": int(pot_id)}
            by_name[t["name"]] = row
            api_lookup[t["apiName"]] = t["name"]
    return by_name, api_lookup


def stage_to_label(stage: str) -> str:
    return {
        "GROUP_STAGE": "Eliminated in group",
        "LAST_32": "Advanced from group",
        "LAST_16": "Reached round of 16",
        "QUARTER_FINALS": "Reached quarterfinals",
        "SEMI_FINALS": "Reached semifinals",
        "FINAL": "Reached final",
        "WINNER": "Won World Cup",
    }.get(stage, stage)


def derive_team_results(
    matches: list[dict],
    teams_by_name: dict[str, dict],
    api_lookup: dict[str, str],
    scoring: dict[str, Any],
) -> tuple[dict[str, dict], list[dict], list[str]]:
    """For each league team, compute group-stage match log, max stage reached,
    knockout bonus, and an overall finish label.

    Returns (team_results_by_name, all_match_log, warnings).
    """
    warnings: list[str] = []
    league_api_names_seen: set[str] = set()

    team_state: dict[str, dict] = {
        name: {
            "team": name,
            "apiName": meta["apiName"],
            "pot": meta["pot"],
            "fifaRank": meta["fifaRank"],
            "matches": [],
            "groupPoints": 0,
            "goalsFor": 0,
            "goalsAgainst": 0,
            "wins": 0,
            "draws": 0,
            "losses": 0,
            "cleanSheets": 0,
            "maxStageRank": -1,
            "maxStage": None,
            "lostInStage": None,
            "wonFinal": False,
            "knockoutBonus": 0,
            "finishLabel": "Not yet started",
        }
        for name, meta in teams_by_name.items()
    }

    g_win = scoring["groupStage"]["win"]
    g_draw = scoring["groupStage"]["draw"]
    g_goal = scoring["groupStage"]["goalScored"]
    g_clean = scoring["groupStage"]["cleanSheet"]

    match_log: list[dict] = []

    for m in matches:
        home_api = (m.get("homeTeam") or {}).get("name") or ""
        away_api = (m.get("awayTeam") or {}).get("name") or ""
        stage = m.get("stage", "GROUP_STAGE")
        status = m.get("status", "TIMED")
        utc_date = m.get("utcDate")

        home_name = api_lookup.get(home_api)
        away_name = api_lookup.get(away_api)

        if home_name is not None:
            league_api_names_seen.add(home_api)
        if away_name is not None:
            league_api_names_seen.add(away_api)

        # Only matches involving at least one league team appear in the log
        if home_name is None and away_name is None:
            continue

        ft = (m.get("score") or {}).get("fullTime") or {}
        home_goals = ft.get("home")
        away_goals = ft.get("away")
        winner = (m.get("score") or {}).get("winner")
        is_final = status == "FINISHED" and isinstance(home_goals, int) and isinstance(away_goals, int)

        # Update max stage reached for any league team that appears in this match,
        # regardless of finished/not — a team listed in a QF fixture has at least reached QF.
        for league_name in (home_name, away_name):
            if not league_name:
                continue
            s = team_state[league_name]
            rank = STAGE_RANK.get(stage, -1)
            if rank > s["maxStageRank"]:
                s["maxStageRank"] = rank
                s["maxStage"] = stage

        # Match log row (visible regardless of league involvement on at least one side)
        match_log.append({
            "id": m.get("id"),
            "stage": stage,
            "status": status,
            "utcDate": utc_date,
            "matchday": m.get("matchday"),
            "home": home_name or home_api,
            "away": away_name or away_api,
            "homeIsLeague": home_name is not None,
            "awayIsLeague": away_name is not None,
            "homeGoals": home_goals,
            "awayGoals": away_goals,
        })

        if not is_final:
            continue

        # Group-stage scoring only applies in GROUP_STAGE matches.
        if stage == "GROUP_STAGE":
            for league_name, gf, ga in (
                (home_name, home_goals, away_goals),
                (away_name, away_goals, home_goals),
            ):
                if not league_name:
                    continue
                s = team_state[league_name]
                if gf > ga:
                    pts = g_win + gf * g_goal + (g_clean if ga == 0 else 0)
                    s["wins"] += 1
                elif gf == ga:
                    pts = g_draw + gf * g_goal + (g_clean if ga == 0 else 0)
                    s["draws"] += 1
                else:
                    pts = gf * g_goal + (g_clean if ga == 0 else 0)
                    s["losses"] += 1
                s["groupPoints"] += pts
                s["goalsFor"] += gf
                s["goalsAgainst"] += ga
                if ga == 0:
                    s["cleanSheets"] += 1
                s["matches"].append({
                    "stage": stage,
                    "matchday": m.get("matchday"),
                    "utcDate": utc_date,
                    "opponent": (away_name or away_api) if league_name == home_name else (home_name or home_api),
                    "gf": gf,
                    "ga": ga,
                    "result": "W" if gf > ga else ("D" if gf == ga else "L"),
                    "points": pts,
                })

        # Knockout: if the league team LOST this finished knockout game, they were eliminated AT this stage.
        # If they won the FINAL, mark wonFinal.
        if stage != "GROUP_STAGE" and is_final:
            home_won = winner == "HOME_TEAM"
            away_won = winner == "AWAY_TEAM"
            if home_name and away_won:
                team_state[home_name]["lostInStage"] = stage
            if away_name and home_won:
                team_state[away_name]["lostInStage"] = stage
            if stage == "FINAL":
                if home_name and home_won:
                    team_state[home_name]["wonFinal"] = True
                if away_name and away_won:
                    team_state[away_name]["wonFinal"] = True

    # Derive knockout bonus per team
    k = scoring["knockout"]
    for name, s in team_state.items():
        if s["wonFinal"]:
            s["knockoutBonus"] = k["WINNER"]
            s["finishLabel"] = "Won World Cup"
        elif s["maxStage"] == "FINAL":
            s["knockoutBonus"] = k["FINAL"]
            s["finishLabel"] = "Reached final"
        elif s["maxStage"] == "SEMI_FINALS":
            s["knockoutBonus"] = k["SEMI_FINALS"]
            s["finishLabel"] = "Reached semifinals"
        elif s["maxStage"] == "QUARTER_FINALS":
            s["knockoutBonus"] = k["QUARTER_FINALS"]
            s["finishLabel"] = "Reached quarterfinals"
        elif s["maxStage"] == "LAST_16":
            s["knockoutBonus"] = k["LAST_16"]
            s["finishLabel"] = "Reached round of 16"
        elif s["maxStage"] == "LAST_32":
            s["knockoutBonus"] = k["LAST_32"]
            s["finishLabel"] = "Advanced from group"
        elif s["maxStage"] == "GROUP_STAGE":
            # Group stage played but did not appear in any knockout fixture yet.
            # If all 3 group matches are FINISHED and they didn't appear in LAST_32+, they're eliminated.
            played = len(s["matches"])
            if played >= 3:
                s["knockoutBonus"] = k["GROUP_STAGE"]
                s["finishLabel"] = "Eliminated in group"
            else:
                s["finishLabel"] = "Group stage in progress"

    # Real problem: a league team's apiName doesn't match anything in the API response.
    expected_api_names = {meta["apiName"] for meta in teams_by_name.values()}
    missing = sorted(expected_api_names - league_api_names_seen)
    if missing:
        warnings.append(
            "These apiName values in teams.json never appeared in the API response — "
            "they probably need correcting: " + ", ".join(missing)
        )

    return team_state, match_log, warnings


def build_leaderboard(
    managers_doc: dict[str, Any],
    team_state: dict[str, dict],
) -> list[dict]:
    rows = []
    for mgr in managers_doc["managers"]:
        trio = [mgr["pot1"], mgr["pot2"], mgr["pot3"]]
        group_pts = 0
        knockout_pts = 0
        fifa_sum = 0
        wins = draws = losses = goals_for = goals_against = clean_sheets = 0
        team_rows = []
        for team_name in trio:
            if not team_name:
                team_rows.append(None)
                continue
            t = team_state.get(team_name)
            if not t:
                team_rows.append({"team": team_name, "missing": True})
                continue
            group_pts += t["groupPoints"]
            knockout_pts += t["knockoutBonus"]
            fifa_sum += t["fifaRank"]
            wins += t["wins"]
            draws += t["draws"]
            losses += t["losses"]
            goals_for += t["goalsFor"]
            goals_against += t["goalsAgainst"]
            clean_sheets += t["cleanSheets"]
            team_rows.append({
                "team": team_name,
                "pot": t["pot"],
                "groupPoints": t["groupPoints"],
                "knockoutBonus": t["knockoutBonus"],
                "finishLabel": t["finishLabel"],
                "fifaRank": t["fifaRank"],
                "wins": t["wins"],
                "draws": t["draws"],
                "losses": t["losses"],
                "goalsFor": t["goalsFor"],
                "goalsAgainst": t["goalsAgainst"],
                "cleanSheets": t["cleanSheets"],
            })
        rows.append({
            "id": mgr["id"],
            "manager": mgr["name"],
            "teams": team_rows,
            "categories": {
                "wins": wins,
                "draws": draws,
                "losses": losses,
                "goalsFor": goals_for,
                "goalsAgainst": goals_against,
                "cleanSheets": clean_sheets,
            },
            "groupPoints": group_pts,
            "knockoutBonus": knockout_pts,
            "totalPoints": group_pts + knockout_pts,
            "fifaRankSum": fifa_sum,
        })

    # Sort: total DESC, then FIFA rank sum DESC (higher = weaker squad = underdog),
    # then manager id ASC for stable order.
    rows.sort(key=lambda r: (-r["totalPoints"], -r["fifaRankSum"], r["id"]))
    for rank, row in enumerate(rows, start=1):
        row["rank"] = rank
    return rows


def main() -> int:
    api_key = os.environ.get("FOOTBALL_DATA_API_KEY", "").strip()
    if not api_key:
        sys.exit(
            "FOOTBALL_DATA_API_KEY is not set. Register a free key at "
            "https://www.football-data.org/client/register and export it before running sync.py."
        )

    teams_doc = load_json("teams.json")
    managers_doc = load_json("managers.json")
    scoring = load_json("scoring.json")

    teams_by_name, api_lookup = build_team_index(teams_doc)

    print(f"Fetching {API_URL} ...")
    matches = fetch_matches(api_key)
    print(f"  got {len(matches)} matches")

    team_state, match_log, warnings = derive_team_results(matches, teams_by_name, api_lookup, scoring)
    leaderboard = build_leaderboard(managers_doc, team_state)

    # Render team_results in pot order, then alphabetical, for stable UI display
    team_results = sorted(
        team_state.values(),
        key=lambda t: (t["pot"], t["team"]),
    )
    for t in team_results:
        t.pop("maxStageRank", None)

    finished = sum(1 for m in match_log if m.get("status") == "FINISHED")

    output = {
        "lastSynced": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "matchesProcessed": len(match_log),
        "matchesFinished": finished,
        "leaderboard": leaderboard,
        "teamResults": team_results,
        "matches": sorted(match_log, key=lambda m: (m.get("utcDate") or "")),
        "warnings": warnings,
    }

    out_path = DATA_DIR / "results.json"
    out_path.write_text(json.dumps(output, indent=2, ensure_ascii=False) + "\n")

    # Mirror the same payload into a JS file the page can <script src=> directly.
    # This lets index.html work when opened from the filesystem (file://) — fetch()
    # is blocked there, but a <script> tag is not.
    js_path = DATA_DIR / "results.js"
    js_path.write_text(
        "// Auto-generated by sync.py — do not edit by hand.\n"
        "window.RESULTS = "
        + json.dumps(output, indent=2, ensure_ascii=False)
        + ";\n"
    )

    print(f"Wrote {out_path} ({finished} finished matches)")

    if leaderboard:
        top = leaderboard[0]
        print(f"Top of leaderboard: {top['manager']} @ {top['totalPoints']} pts")
    for w in warnings:
        print(f"WARNING: {w}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
