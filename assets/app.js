(async function () {
  const $ = (sel) => document.querySelector(sel);

  setupSectionPersistence();

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

  const loaded = await loadData();
  if (!loaded) {
    $("#synced").textContent = "No data available — run `make sync` or configure config.js → workerUrl.";
    return;
  }
  const { data, source } = loaded;

  const modal = setupTeamModal(data);

  renderSynced(data, source);
  renderWarnings(data.warnings);
  renderLeaderboard(data.leaderboard, modal);
  renderBreakdown(data.leaderboard, modal);
  renderKnockoutGrid(data.teamResults, modal);
  renderMatchLog(data.matches);

  async function loadData() {
    const workerUrl = (window.CONFIG && window.CONFIG.workerUrl) || "";
    if (workerUrl) {
      try {
        const resp = await fetch(workerUrl, { cache: "no-store" });
        if (resp.ok) {
          return { data: await resp.json(), source: "worker" };
        }
        console.warn(`Worker returned HTTP ${resp.status}, falling back to static data`);
      } catch (err) {
        console.warn("Worker fetch failed, falling back to static data:", err);
      }
    }
    if (window.RESULTS) {
      return { data: window.RESULTS, source: "static" };
    }
    return null;
  }

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

  function renderSynced(d, source) {
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
    const prefix = source === "worker" ? "Live · fetched" : "Last manual sync";
    $("#synced").textContent = `${prefix} ${ts} • ${finished} of ${total} league-relevant matches finished`;
  }

  function renderWarnings(warnings) {
    if (!warnings || !warnings.length) return;
    const main = document.querySelector("main");
    warnings.forEach((w) => {
      main.prepend(el("div", { className: "warning", text: w }));
    });
  }

  function setupSectionPersistence() {
    const STORAGE_KEY = "wc-draft-order:sections";
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") || {};
    } catch (e) {
      saved = {};
    }

    const sections = document.querySelectorAll("details.section");
    sections.forEach((section) => {
      const id = section.id;
      if (!id) return;
      if (id in saved) {
        section.open = Boolean(saved[id]);
      }
      section.addEventListener("toggle", () => {
        saved[id] = section.open;
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
        } catch (e) {
          // localStorage may be unavailable (Safari private mode pre-iOS 11) — ignore.
        }
      });
    });
  }

  function setupTeamModal(data) {
    const dialog = document.getElementById("team-modal");
    const body = document.getElementById("team-modal-body");
    const closeBtn = dialog.querySelector(".modal-close");

    closeBtn.addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) dialog.close();
    });

    const teamsByName = new Map((data.teamResults || []).map(t => [t.team, t]));
    const ownersByTeam = new Map();
    for (const row of data.leaderboard || []) {
      for (const t of row.teams || []) {
        if (!t || !t.team) continue;
        const list = ownersByTeam.get(t.team) || [];
        list.push(row.manager);
        ownersByTeam.set(t.team, list);
      }
    }
    const managersById = new Map((data.leaderboard || []).map(r => [r.id, r]));

    const api = {
      openTeam(teamName) {
        const team = teamsByName.get(teamName);
        if (!team) return;
        renderTeamModalBody(body, team, ownersByTeam.get(teamName) || [], api);
        dialog.showModal();
      },
      openManager(managerId) {
        const row = managersById.get(managerId);
        if (!row) return;
        renderManagerModalBody(body, row, teamsByName, api);
        dialog.showModal();
      },
      // Legacy alias so existing chip/card callers continue to work.
      open(teamName) { api.openTeam(teamName); },
    };
    return api;
  }

  function renderTeamModalBody(body, team, owners) {
    clear(body);
    const total = (team.groupPoints || 0) + (team.knockoutBonus || 0);

    body.appendChild(el("h2", { className: "modal-team-name", text: team.team }));
    body.appendChild(el("p", { className: "modal-subtitle", text: `Pot ${team.pot} · FIFA #${team.fifaRank}` }));
    body.appendChild(el("p", {
      className: "modal-owners",
      text: owners.length ? `Drawn by ${owners.join(", ")}` : "Drawn by nobody",
    }));

    body.appendChild(el("div", { className: "modal-stats" }, [
      statBlock("Record", `${team.wins}-${team.draws}-${team.losses}`),
      statBlock("Goals F/A", `${team.goalsFor} / ${team.goalsAgainst}`),
      statBlock("Clean Sheets", String(team.cleanSheets)),
      statBlock("Group Pts", String(team.groupPoints)),
      statBlock("KO Bonus", `+${team.knockoutBonus}`),
      statBlock("Total Pts", String(total), true),
    ]));

    body.appendChild(el("h3", { className: "modal-section-title", text: "Group Stage Matches" }));
    if (!team.matches || team.matches.length === 0) {
      body.appendChild(el("p", { className: "missing", text: "No group stage matches played yet." }));
    } else {
      const list = el("div", { className: "modal-match-list" });
      team.matches.forEach((m) => {
        const result = (m.result || "").toLowerCase();
        list.appendChild(el("div", { className: `modal-match-row result-${result}` }, [
          el("div", { className: "result-badge", text: m.result }),
          el("div", { className: "match-detail", text: `vs ${m.opponent}` }),
          el("div", { className: "match-score", text: `${m.gf}–${m.ga}` }),
          el("div", { className: "match-points", text: `+${m.points}` }),
        ]));
      });
      body.appendChild(list);
    }

    body.appendChild(el("h3", { className: "modal-section-title", text: "Knockout Stage" }));
    body.appendChild(el("p", { className: "modal-finish", text: team.finishLabel }));
  }

  function renderManagerModalBody(body, row, teamsByName, modalApi) {
    clear(body);
    const c = row.categories || { wins: 0, draws: 0, losses: 0, goalsFor: 0, cleanSheets: 0 };
    const gp = c.wins + c.draws + c.losses;

    body.appendChild(el("h2", { className: "modal-team-name", text: row.manager }));
    body.appendChild(el("p", {
      className: "modal-subtitle",
      text: `Rank #${row.rank} · ${row.totalPoints} pts · ${gp}/9 group games played`,
    }));

    // Three team chips, clickable through to the team modal
    const teamRow = el("div", { className: "modal-team-row" });
    row.teams.forEach((t, i) => {
      const potHint = i + 1;
      teamRow.appendChild(teamChip(t, potHint, modalApi));
    });
    body.appendChild(teamRow);

    body.appendChild(el("div", { className: "modal-stats" }, [
      statBlock("Wins (×3)", `${c.wins} = ${c.wins * 3}`),
      statBlock("Draws (×1)", String(c.draws)),
      statBlock("Goals (×1)", String(c.goalsFor)),
      statBlock("Clean Sheets (×1)", String(c.cleanSheets)),
      statBlock("KO Bonus", `+${row.knockoutBonus}`),
      statBlock("Total Pts", String(row.totalPoints), true),
    ]));

    row.teams.forEach((t) => {
      if (!t || t.missing || !t.team) return;
      const team = teamsByName.get(t.team);
      const teamTotal = (t.groupPoints || 0) + (t.knockoutBonus || 0);
      body.appendChild(el("h3", {
        className: "modal-section-title",
        text: `${t.team} (Pot ${t.pot}) — ${teamTotal} pts · ${t.finishLabel}`,
      }));
      if (!team || !team.matches || team.matches.length === 0) {
        body.appendChild(el("p", { className: "missing", text: "No matches played yet." }));
        return;
      }
      const list = el("div", { className: "modal-match-list" });
      team.matches.forEach((m) => {
        const result = (m.result || "").toLowerCase();
        list.appendChild(el("div", { className: `modal-match-row result-${result}` }, [
          el("div", { className: "result-badge", text: m.result }),
          el("div", { className: "match-detail", text: `vs ${m.opponent}` }),
          el("div", { className: "match-score", text: `${m.gf}–${m.ga}` }),
          el("div", { className: "match-points", text: `+${m.points}` }),
        ]));
      });
      body.appendChild(list);
    });
  }

  function statBlock(label, value, highlight = false) {
    return el("div", { className: highlight ? "stat-block highlight" : "stat-block" }, [
      el("div", { className: "stat-label", text: label }),
      el("div", { className: "stat-value", text: value }),
    ]);
  }

  function renderLeaderboard(rows, modal) {
    const tbody = document.querySelector("#leaderboard tbody");
    clear(tbody);
    if (!rows || !rows.length) {
      const td = el("td", { className: "missing", text: "No leaderboard yet — fill in data/managers.json with each manager's trio, then run sync.py." });
      td.colSpan = 10;
      tbody.appendChild(el("tr", {}, [td]));
      return;
    }
    rows.forEach((r) => {
      const c = r.categories || { wins: 0, draws: 0, losses: 0 };
      const gamesPlayed = c.wins + c.draws + c.losses;
      const tr = el("tr", { className: `rank-${r.rank}` }, [
        el("td", { text: r.rank }),
        el("td", {}, [managerName(r, modal)]),
        el("td", {}, [teamChip(r.teams[0], 1, modal)]),
        el("td", {}, [teamChip(r.teams[1], 2, modal)]),
        el("td", {}, [teamChip(r.teams[2], 3, modal)]),
        el("td", { className: "num", title: `${c.wins}W-${c.draws}D-${c.losses}L of 9 possible`, text: `${gamesPlayed}/9` }),
        el("td", { className: "num", text: r.groupPoints }),
        el("td", { className: "num", text: r.knockoutBonus }),
        el("td", { className: "num total", text: r.totalPoints }),
        el("td", { className: "num", text: r.fifaRankSum }),
      ]);
      tbody.appendChild(tr);
    });
  }

  function managerName(row, modal) {
    if (!modal) return el("span", { text: row.manager });
    const span = el("span", { className: "manager-name clickable", text: row.manager, title: "Click for details" });
    span.setAttribute("role", "button");
    span.tabIndex = 0;
    span.addEventListener("click", () => modal.openManager(row.id));
    span.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); modal.openManager(row.id); }
    });
    return span;
  }

  function renderBreakdown(rows, modal) {
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
        el("td", {}, [managerName(r, modal)]),
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

  function teamChip(team, potHint, modal) {
    if (!team) return el("span", { className: "missing", text: "—" });
    if (team.missing) return el("span", { className: "missing", text: `${team.team}?` });
    const pot = team.pot || potHint;
    const total = (team.groupPoints || 0) + (team.knockoutBonus || 0);
    const baseTitle = `Group ${team.groupPoints} + KO ${team.knockoutBonus} = ${total} pts • ${team.finishLabel}`;
    const title = modal ? `${baseTitle} (click for details)` : baseTitle;
    const chip = el("span", {
      className: `team-chip pot-${pot}${modal ? " clickable" : ""}`,
      title,
      text: team.team,
    });
    if (modal) {
      chip.setAttribute("role", "button");
      chip.tabIndex = 0;
      chip.addEventListener("click", () => modal.open(team.team));
      chip.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); modal.open(team.team); }
      });
    }
    return chip;
  }

  function renderKnockoutGrid(teamResults, modal) {
    const grid = $("#knockout-grid");
    clear(grid);
    if (!teamResults || !teamResults.length) {
      grid.appendChild(el("p", { className: "missing", text: "No team data yet. Run sync.py." }));
      return;
    }
    teamResults.forEach((t) => {
      const total = (t.groupPoints || 0) + (t.knockoutBonus || 0);
      const record = `${t.wins}W-${t.draws}D-${t.losses}L`;
      const card = el("div", { className: `knockout-card pot-${t.pot}${modal ? " clickable" : ""}` }, [
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
      if (modal) {
        card.setAttribute("role", "button");
        card.tabIndex = 0;
        card.title = "Click for details";
        card.addEventListener("click", () => modal.open(t.team));
        card.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); modal.open(t.team); }
        });
      }
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
