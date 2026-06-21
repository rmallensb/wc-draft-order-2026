// Cloudflare Worker that mirrors sync.py: pull WC matches, compute scoring,
// return the same JSON shape as data/results.json. Cached at the edge for
// CACHE_TTL_SECONDS to keep us well under football-data.org's 10 req/min cap.

import managersDoc from "../../data/managers.json";
import teamsDoc    from "../../data/teams.json";
import scoring     from "../../data/scoring.json";
import overridesDoc from "../../data/overrides.json";

const API_URL = "https://api.football-data.org/v4/competitions/WC/matches";

const STAGE_RANK = {
  GROUP_STAGE: 0,
  LAST_32: 1,
  LAST_16: 2,
  QUARTER_FINALS: 3,
  SEMI_FINALS: 4,
  FINAL: 5,
  THIRD_PLACE: 4, // semifinal-exit equivalent
};

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", { status: 405, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    if (url.pathname.match(/^\/match-events\/?$/)) {
      return handleMatchEvents(request, env, ctx);
    }
    return handleLeaderboard(request, env, ctx);
  },
};

// ESPN uses different team naming than football-data.org in a few spots.
// Most of our teams.json `apiName` values line up; these are the exceptions.
const ESPN_ALIASES = {
  "usa": ["united states"],
  "south korea": ["korea republic"],
  "ivory coast": ["côte d'ivoire", "cote d'ivoire"],
  "turkey": ["türkiye"],
  "türkiye": ["turkey"],
  "czechia": ["czech republic"],
  "czech republic": ["czechia"],
};

function nameCandidates(name) {
  const n = (name || "").toLowerCase().trim();
  return [n, ...(ESPN_ALIASES[n] || [])];
}

function findEspnEvent(home, away, events) {
  const hOpts = nameCandidates(home);
  const aOpts = nameCandidates(away);
  for (const e of events) {
    const name = (e.name || "").toLowerCase();
    if (hOpts.some(h => name.includes(h)) && aOpts.some(a => name.includes(a))) return e;
  }
  for (const e of events) {
    const comps = (e.competitions?.[0]?.competitors || []).map(c => (c.team?.displayName || "").toLowerCase());
    const hasHome = hOpts.some(h => comps.some(n => n.includes(h)));
    const hasAway = aOpts.some(a => comps.some(n => n.includes(a)));
    if (hasHome && hasAway) return e;
  }
  return null;
}

async function handleMatchEvents(request, env, ctx) {
  const url = new URL(request.url);
  const home = url.searchParams.get("home");
  const away = url.searchParams.get("away");
  const date = url.searchParams.get("date");
  if (!home || !away || !date) {
    return jsonResponse({ error: "Missing required query params: home, away, date" }, 400);
  }

  const cache = caches.default;
  const cacheKey = new Request(url.toString(), { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) {
    console.log(`match-events cache HIT for ${home} vs ${away}`);
    const headers = new Headers(cached.headers);
    headers.set("x-cache", "HIT");
    return new Response(cached.body, { status: cached.status, headers });
  }

  console.log(`match-events cache MISS for ${home} vs ${away} on ${date}`);
  const baseDate = new Date(date);
  if (isNaN(baseDate)) {
    return jsonResponse({ goals: [], cards: [], error: "Invalid date" }, 400);
  }

  // Probe ±2 days because ESPN sometimes partitions by venue local time, not UTC.
  const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world";
  let target = null;
  let foundDate = null;
  for (const delta of [0, -1, 1, -2, 2]) {
    const d = new Date(baseDate);
    d.setUTCDate(d.getUTCDate() + delta);
    const yyyymmdd = d.toISOString().slice(0, 10).replace(/-/g, "");
    let sb;
    try {
      sb = await fetch(`${ESPN_BASE}/scoreboard?dates=${yyyymmdd}`);
    } catch (err) {
      continue;
    }
    if (!sb.ok) continue;
    const data = await sb.json();
    const events = data.events || [];
    target = findEspnEvent(home, away, events);
    if (target) { foundDate = yyyymmdd; break; }
  }

  if (!target) {
    console.warn(`No ESPN match found for ${home} vs ${away}`);
    const out = { goals: [], cards: [], error: "No matching ESPN event found" };
    const r = jsonResponse(out, 200, { "cache-control": "public, max-age=300" });
    ctx.waitUntil(cache.put(cacheKey, r.clone()));
    return r;
  }

  let summary;
  try {
    summary = await fetch(`${ESPN_BASE}/summary?event=${target.id}`);
  } catch (err) {
    return jsonResponse({ goals: [], cards: [], error: String(err.message || err) }, 502);
  }
  if (!summary.ok) {
    return jsonResponse({ goals: [], cards: [], error: `Summary HTTP ${summary.status}` }, 502);
  }
  const sd = await summary.json();
  const keyEvents = sd.keyEvents || [];

  const goals = [];
  const cards = [];
  for (const e of keyEvents) {
    const typeId = (e.type?.type || "").toLowerCase();
    const typeText = e.type?.text || "";
    const minute = e.clock?.displayValue || "?";
    const team = e.team?.displayName || "?";
    const playerName = e.participants?.[0]?.athlete?.displayName || null;
    const isGoal = typeId === "goal" || typeId === "own-goal" || typeId === "penalty-goal" || e.scoringPlay;
    const isCard = typeId.includes("card") || typeText.toLowerCase().includes("card");

    if (isGoal) {
      goals.push({
        minute,
        team,
        scorer: playerName,
        type: typeText || "Goal",
        text: e.shortText || e.text || "",
        ownGoal: typeId === "own-goal",
      });
    } else if (isCard) {
      cards.push({
        minute,
        team,
        player: playerName,
        card: typeText || "Card",
      });
    }
  }

  console.log(`ESPN id=${target.id} on ${foundDate} → ${goals.length} goals, ${cards.length} cards`);
  const out = { source: "espn", espnEventId: target.id, espnDate: foundDate, goals, cards };
  // Match data only changes during live games. Cache 30s — fresh enough for new goals,
  // long enough to absorb 12 friends F5'ing during a match.
  const r = jsonResponse(out, 200, { "cache-control": "public, max-age=30", "x-cache": "MISS" });
  ctx.waitUntil(cache.put(cacheKey, r.clone()));
  return r;
}

async function handleLeaderboard(request, env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(new URL("/results", request.url).toString(), { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) {
    console.log("cache HIT");
    const headers = new Headers(cached.headers);
    headers.set("x-cache", "HIT");
    return new Response(cached.body, { status: cached.status, headers });
  }

  if (!env.FOOTBALL_DATA_API_KEY) {
    console.error("FOOTBALL_DATA_API_KEY secret is not configured");
    return jsonResponse({ error: "FOOTBALL_DATA_API_KEY secret is not configured on this Worker." }, 500);
  }

  console.log("cache MISS — fetching upstream from football-data.org");
  let matches;
  try {
    matches = await fetchMatches(env.FOOTBALL_DATA_API_KEY);
  } catch (err) {
    console.error("upstream fetch failed:", err.message || err);
    return jsonResponse({ error: String(err.message || err) }, 502);
  }

  const output = computeResults(matches);
  console.log(
    `computed: ${output.matchesFinished}/${output.matchesProcessed} finished · top: ${output.leaderboard[0]?.manager ?? "(none)"} @ ${output.leaderboard[0]?.totalPoints ?? 0}`
  );
  if (output.warnings.length) {
    console.warn("warnings:", output.warnings.join(" | "));
  }
  const ttl = Number(env.CACHE_TTL_SECONDS || 60);
  const response = jsonResponse(output, 200, {
    "cache-control": `public, max-age=${ttl}`,
    "x-cache": "MISS",
  });

  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

async function fetchMatches(apiKey) {
  const resp = await fetch(API_URL, { headers: { "X-Auth-Token": apiKey } });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`football-data.org returned HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  const body = await resp.json();
  return body.matches || [];
}

function buildTeamIndex(teams) {
  const byName = new Map();
  const apiLookup = new Map();
  for (const [potId, pot] of Object.entries(teams.pots)) {
    for (const t of pot.teams) {
      byName.set(t.name, { ...t, pot: Number(potId) });
      apiLookup.set(t.apiName, t.name);
    }
  }
  return { byName, apiLookup };
}

function newTeamState(name, meta) {
  return {
    team: name,
    apiName: meta.apiName,
    pot: meta.pot,
    fifaRank: meta.fifaRank,
    matches: [],
    groupPoints: 0,
    goalsFor: 0,
    goalsAgainst: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    cleanSheets: 0,
    maxStageRank: -1,
    maxStage: null,
    lostInStage: null,
    wonFinal: false,
    knockoutBonus: 0,
    finishLabel: "Not yet started",
  };
}

function deriveTeamResults(matches, byName, apiLookup) {
  const teamState = new Map();
  for (const [name, meta] of byName) {
    teamState.set(name, newTeamState(name, meta));
  }

  const g_win = scoring.groupStage.win;
  const g_draw = scoring.groupStage.draw;
  const g_goal = scoring.groupStage.goalScored;
  const g_clean = scoring.groupStage.cleanSheet;

  const leagueApiNamesSeen = new Set();
  const matchLog = [];

  for (const m of matches) {
    const homeApi = m.homeTeam?.name ?? "";
    const awayApi = m.awayTeam?.name ?? "";
    const stage = m.stage ?? "GROUP_STAGE";
    const status = m.status ?? "TIMED";
    const utcDate = m.utcDate ?? null;

    const homeName = apiLookup.get(homeApi) ?? null;
    const awayName = apiLookup.get(awayApi) ?? null;

    if (homeName) leagueApiNamesSeen.add(homeApi);
    if (awayName) leagueApiNamesSeen.add(awayApi);

    const ft = m.score?.fullTime ?? {};
    const ht = m.score?.halfTime ?? {};
    const homeGoals = typeof ft.home === "number" ? ft.home : null;
    const awayGoals = typeof ft.away === "number" ? ft.away : null;
    const winner = m.score?.winner ?? null;
    const isFinal = status === "FINISHED" && homeGoals !== null && awayGoals !== null;

    for (const name of [homeName, awayName]) {
      if (!name) continue;
      const s = teamState.get(name);
      const rank = STAGE_RANK[stage] ?? -1;
      if (rank > s.maxStageRank) {
        s.maxStageRank = rank;
        s.maxStage = stage;
      }
    }

    matchLog.push({
      id: m.id,
      stage,
      status,
      utcDate,
      matchday: m.matchday ?? null,
      minute: m.minute ?? null,
      home: homeName || homeApi,
      away: awayName || awayApi,
      homeIsLeague: homeName !== null,
      awayIsLeague: awayName !== null,
      homeGoals,
      awayGoals,
      halfTimeHome: typeof ht.home === "number" ? ht.home : null,
      halfTimeAway: typeof ht.away === "number" ? ht.away : null,
    });

    if (!isFinal) continue;

    if (stage === "GROUP_STAGE") {
      for (const [leagueName, gf, ga] of [
        [homeName, homeGoals, awayGoals],
        [awayName, awayGoals, homeGoals],
      ]) {
        if (!leagueName) continue;
        const s = teamState.get(leagueName);
        let pts;
        if (gf > ga) {
          pts = g_win + gf * g_goal + (ga === 0 ? g_clean : 0);
          s.wins += 1;
        } else if (gf === ga) {
          pts = g_draw + gf * g_goal + (ga === 0 ? g_clean : 0);
          s.draws += 1;
        } else {
          pts = gf * g_goal + (ga === 0 ? g_clean : 0);
          s.losses += 1;
        }
        s.groupPoints += pts;
        s.goalsFor += gf;
        s.goalsAgainst += ga;
        if (ga === 0) s.cleanSheets += 1;
        s.matches.push({
          stage,
          matchday: m.matchday ?? null,
          utcDate,
          opponent: leagueName === homeName ? (awayName || awayApi) : (homeName || homeApi),
          gf,
          ga,
          result: gf > ga ? "W" : (gf === ga ? "D" : "L"),
          points: pts,
        });
      }
    }

    if (stage !== "GROUP_STAGE") {
      const homeWon = winner === "HOME_TEAM";
      const awayWon = winner === "AWAY_TEAM";
      if (homeName && awayWon) teamState.get(homeName).lostInStage = stage;
      if (awayName && homeWon) teamState.get(awayName).lostInStage = stage;
      if (stage === "FINAL") {
        if (homeName && homeWon) teamState.get(homeName).wonFinal = true;
        if (awayName && awayWon) teamState.get(awayName).wonFinal = true;
      }
    }
  }

  const k = scoring.knockout;
  for (const s of teamState.values()) {
    if (s.wonFinal) {
      s.knockoutBonus = k.WINNER;
      s.finishLabel = "Won World Cup";
    } else if (s.maxStage === "FINAL") {
      s.knockoutBonus = k.FINAL;
      s.finishLabel = "Reached final";
    } else if (s.maxStage === "SEMI_FINALS") {
      s.knockoutBonus = k.SEMI_FINALS;
      s.finishLabel = "Reached semifinals";
    } else if (s.maxStage === "QUARTER_FINALS") {
      s.knockoutBonus = k.QUARTER_FINALS;
      s.finishLabel = "Reached quarterfinals";
    } else if (s.maxStage === "LAST_16") {
      s.knockoutBonus = k.LAST_16;
      s.finishLabel = "Reached round of 16";
    } else if (s.maxStage === "LAST_32") {
      s.knockoutBonus = k.LAST_32;
      s.finishLabel = "Advanced from group";
    } else if (s.maxStage === "GROUP_STAGE") {
      if (s.matches.length >= 3) {
        s.knockoutBonus = k.GROUP_STAGE;
        s.finishLabel = "Eliminated in group";
      } else {
        s.finishLabel = "Group stage in progress";
      }
    }
  }

  const warnings = [];
  const expectedApiNames = new Set([...byName.values()].map(meta => meta.apiName));
  const missing = [...expectedApiNames].filter(n => !leagueApiNamesSeen.has(n)).sort();
  if (missing.length) {
    warnings.push(
      "These apiName values in teams.json never appeared in the API response — " +
      "they probably need correcting: " + missing.join(", ")
    );
  }

  return { teamState, matchLog, warnings };
}

function buildLeaderboard(managersDoc, teamState) {
  const rows = [];
  for (const mgr of managersDoc.managers) {
    const trio = [mgr.pot1, mgr.pot2, mgr.pot3];
    let groupPts = 0, knockoutPts = 0, fifaSum = 0;
    let wins = 0, draws = 0, losses = 0, goalsFor = 0, goalsAgainst = 0, cleanSheets = 0;
    const teamRows = [];
    for (const teamName of trio) {
      if (!teamName) { teamRows.push(null); continue; }
      const t = teamState.get(teamName);
      if (!t) { teamRows.push({ team: teamName, missing: true }); continue; }
      groupPts += t.groupPoints;
      knockoutPts += t.knockoutBonus;
      fifaSum += t.fifaRank;
      wins += t.wins;
      draws += t.draws;
      losses += t.losses;
      goalsFor += t.goalsFor;
      goalsAgainst += t.goalsAgainst;
      cleanSheets += t.cleanSheets;
      teamRows.push({
        team: teamName,
        pot: t.pot,
        groupPoints: t.groupPoints,
        knockoutBonus: t.knockoutBonus,
        finishLabel: t.finishLabel,
        fifaRank: t.fifaRank,
        wins: t.wins,
        draws: t.draws,
        losses: t.losses,
        goalsFor: t.goalsFor,
        goalsAgainst: t.goalsAgainst,
        cleanSheets: t.cleanSheets,
      });
    }
    rows.push({
      id: mgr.id,
      manager: mgr.name,
      teams: teamRows,
      categories: { wins, draws, losses, goalsFor, goalsAgainst, cleanSheets },
      groupPoints: groupPts,
      knockoutBonus: knockoutPts,
      totalPoints: groupPts + knockoutPts,
      fifaRankSum: fifaSum,
    });
  }

  // total DESC, fifaRankSum DESC (underdog tiebreak), id ASC for stability
  rows.sort((a, b) =>
    (b.totalPoints - a.totalPoints) ||
    (b.fifaRankSum - a.fifaRankSum) ||
    (a.id - b.id)
  );
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}

function applyOverrides(matches) {
  const overrides = overridesDoc.matches || {};
  const ids = Object.keys(overrides);
  if (ids.length === 0) return [];
  const byId = new Map(matches.filter(m => m && m.id != null).map(m => [String(m.id), m]));
  const applied = [];
  for (const [mid, ov] of Object.entries(overrides)) {
    const m = byId.get(String(mid));
    if (!m) continue;
    m.score = m.score || {};
    m.score.fullTime = m.score.fullTime || {};
    if (typeof ov.homeGoals === "number") m.score.fullTime.home = ov.homeGoals;
    if (typeof ov.awayGoals === "number") m.score.fullTime.away = ov.awayGoals;
    if (typeof ov.status === "string") m.status = ov.status;
    const h = m.score.fullTime.home, a = m.score.fullTime.away;
    if (typeof h === "number" && typeof a === "number") {
      m.score.winner = h > a ? "HOME_TEAM" : a > h ? "AWAY_TEAM" : "DRAW";
    }
    applied.push({ id: mid, note: ov.note || "" });
  }
  return applied;
}

function computeResults(matches) {
  const { byName, apiLookup } = buildTeamIndex(teamsDoc);
  const applied = applyOverrides(matches);
  if (applied.length > 0) {
    console.log(`applied ${applied.length} manual override(s):`);
    for (const ov of applied) console.log(`  - match ${ov.id}: ${ov.note}`);
  }
  const { teamState, matchLog, warnings } = deriveTeamResults(matches, byName, apiLookup);
  const leaderboard = buildLeaderboard(managersDoc, teamState);

  const teamResults = [...teamState.values()].sort(
    (a, b) => a.pot - b.pot || a.team.localeCompare(b.team)
  );
  for (const t of teamResults) delete t.maxStageRank;

  const finished = matchLog.filter(m => m.status === "FINISHED").length;
  matchLog.sort((a, b) => (a.utcDate || "").localeCompare(b.utcDate || ""));

  return {
    lastSynced: new Date().toISOString(),
    matchesProcessed: matchLog.length,
    matchesFinished: finished,
    leaderboard,
    teamResults,
    matches: matchLog,
    warnings,
  };
}
