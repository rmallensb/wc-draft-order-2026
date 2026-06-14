(function () {
  const $ = (sel) => document.querySelector(sel);

  const STAGE_LABELS = {
    GROUP_STAGE: "Group Stage",
    LAST_32: "Round of 32",
    LAST_16: "Round of 16",
    QUARTER_FINALS: "Quarterfinals",
    SEMI_FINALS: "Semifinals",
    FINAL: "Final",
    THIRD_PLACE: "Third-Place Match",
  };

  const STAGE_ORDER = [
    "GROUP_STAGE",
    "LAST_32",
    "LAST_16",
    "QUARTER_FINALS",
    "SEMI_FINALS",
    "THIRD_PLACE",
    "FINAL",
  ];

  const data = window.RESULTS;
  if (!data) {
    $("#synced").textContent = "Failed to load data/results.js — run `make sync` first.";
    return;
  }

  renderSynced(data);
  renderWarnings(data.warnings);
  renderLeaderboard(data.leaderboard);
  renderBreakdown(data.leaderboard);
  renderKnockoutGrid(data.teamResults);
  renderMatchLog(data.matches);

  function el(tag, opts = {}, children = []) {
    const node = document.createElement(tag);
    if (opts.className) node.className = opts.className;
    if (opts.title) node.title = opts.title;
    if (opts.text !== undefined) node.textContent = String(opts.text);
    for (const child of children) {
      if (child === null || child === undefined || child === false) continue;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function renderSynced(d) {
    if (!d.lastSynced) {
      $("#synced").textContent = "Awaiting first sync.";
      return;
    }
    const dt = new Date(d.lastSynced);
    const ts = dt.toLocaleString(undefined, {
      year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
    const finished = d.matchesFinished ?? 0;
    const total = d.matchesProcessed ?? 0;
    $("#synced").textContent = `Last synced: ${ts} • ${finished} of ${total} league-relevant matches finished`;
  }

  function renderWarnings(warnings) {
    if (!warnings || !warnings.length) return;
    const main = document.querySelector("main");
    warnings.forEach((w) => {
      main.prepend(el("div", { className: "warning", text: w }));
    });
  }

  function renderLeaderboard(rows) {
    const tbody = document.querySelector("#leaderboard tbody");
    clear(tbody);
    if (!rows || !rows.length) {
      const td = el("td", { className: "missing", text: "No leaderboard yet — fill in data/managers.json with each manager's trio, then run sync.py." });
      td.colSpan = 9;
      tbody.appendChild(el("tr", {}, [td]));
      return;
    }
    rows.forEach((r) => {
      const tr = el("tr", { className: `rank-${r.rank}` }, [
        el("td", { text: r.rank }),
        el("td", { text: r.manager }),
        el("td", {}, [teamChip(r.teams[0], 1)]),
        el("td", {}, [teamChip(r.teams[1], 2)]),
        el("td", {}, [teamChip(r.teams[2], 3)]),
        el("td", { className: "num", text: r.groupPoints }),
        el("td", { className: "num", text: r.knockoutBonus }),
        el("td", { className: "num total", text: r.totalPoints }),
        el("td", { className: "num", text: r.fifaRankSum }),
      ]);
      tbody.appendChild(tr);
    });
  }

  function renderBreakdown(rows) {
    const tbody = document.querySelector("#breakdown tbody");
    clear(tbody);
    if (!rows || !rows.length) {
      const td = el("td", { className: "missing", text: "No data yet — run sync." });
      td.colSpan = 8;
      tbody.appendChild(el("tr", {}, [td]));
      return;
    }
    rows.forEach((r) => {
      const c = r.categories || { wins: 0, draws: 0, goalsFor: 0, cleanSheets: 0 };
      const winPts = c.wins * 3;
      const drawPts = c.draws;
      const goalPts = c.goalsFor;
      const cleanPts = c.cleanSheets;
      const tr = el("tr", { className: `rank-${r.rank}` }, [
        el("td", { text: r.manager }),
        el("td", { className: "num", title: `${winPts} pts`, text: c.wins }),
        el("td", { className: "num", title: `${drawPts} pts`, text: c.draws }),
        el("td", { className: "num", title: `${goalPts} pts`, text: c.goalsFor }),
        el("td", { className: "num", title: `${cleanPts} pts`, text: c.cleanSheets }),
        el("td", { className: "num", text: r.groupPoints }),
        el("td", { className: "num", text: r.knockoutBonus }),
        el("td", { className: "num total", text: r.totalPoints }),
      ]);
      tbody.appendChild(tr);
    });
  }

  function teamChip(team, potHint) {
    if (!team) return el("span", { className: "missing", text: "—" });
    if (team.missing) return el("span", { className: "missing", text: `${team.team}?` });
    const pot = team.pot || potHint;
    const total = (team.groupPoints || 0) + (team.knockoutBonus || 0);
    const title = `Group ${team.groupPoints} + KO ${team.knockoutBonus} = ${total} pts • ${team.finishLabel}`;
    return el("span", { className: `team-chip pot-${pot}`, title, text: team.team });
  }

  function renderKnockoutGrid(teamResults) {
    const grid = $("#knockout-grid");
    clear(grid);
    if (!teamResults || !teamResults.length) {
      grid.appendChild(el("p", { className: "missing", text: "No team data yet. Run sync.py." }));
      return;
    }
    teamResults.forEach((t) => {
      const total = (t.groupPoints || 0) + (t.knockoutBonus || 0);
      const record = `${t.wins}W-${t.draws}D-${t.losses}L`;
      const card = el("div", { className: `knockout-card pot-${t.pot}` }, [
        el("div", { className: "team", text: t.team }),
        el("div", { className: "meta" }, [
          el("span", { text: `Pot ${t.pot} • FIFA #${t.fifaRank}` }),
          el("span", { text: record }),
        ]),
        el("div", { className: "stage" }, [
          `${t.finishLabel} `,
          el("span", { className: "bonus", text: `+${t.knockoutBonus}` }),
        ]),
        el("div", { className: "meta" }, [
          el("span", { text: `GF/GA ${t.goalsFor}/${t.goalsAgainst}` }),
          (function () {
            const span = el("span");
            const strong = el("strong", { text: total });
            span.appendChild(strong);
            span.appendChild(document.createTextNode(" pts"));
            return span;
          })(),
        ]),
      ]);
      grid.appendChild(card);
    });
  }

  function renderMatchLog(matches) {
    const wrap = $("#match-log");
    clear(wrap);
    if (!matches || !matches.length) {
      wrap.appendChild(el("p", { className: "missing", text: "No matches yet." }));
      return;
    }

    const byStage = new Map();
    matches.forEach((m) => {
      const list = byStage.get(m.stage) || [];
      list.push(m);
      byStage.set(m.stage, list);
    });

    STAGE_ORDER.forEach((stage) => {
      const list = byStage.get(stage);
      if (!list) return;
      wrap.appendChild(el("div", { className: "stage-divider", text: STAGE_LABELS[stage] || stage }));
      list.forEach((m) => wrap.appendChild(matchRow(m)));
    });
  }

  function matchRow(m) {
    const finished = m.status === "FINISHED";
    const cls = `match-row ${finished ? "finished" : "upcoming"}`;
    const score = (typeof m.homeGoals === "number" && typeof m.awayGoals === "number")
      ? `${m.homeGoals} – ${m.awayGoals}`
      : "vs";
    const when = m.utcDate
      ? new Date(m.utcDate).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
      : "";
    return el("div", { className: cls }, [
      el("div", { className: "when", text: when }),
      el("div", { className: "home" }, [
        el("span", { className: `team-name ${m.homeIsLeague ? "is-league" : ""}`, text: m.home }),
      ]),
      el("div", { className: "score", text: score }),
      el("div", { className: "away" }, [
        el("span", { className: `team-name ${m.awayIsLeague ? "is-league" : ""}`, text: m.away }),
      ]),
      el("div", { className: "status", text: finished ? "Final" : (m.status || "").toLowerCase() }),
    ]);
  }
})();
