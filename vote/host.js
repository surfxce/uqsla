// Host page: run the AGM one position at a time, manage candidates and voting codes.
import {
  db, ref, get, update, remove, push, onValue, accessGate, signOutAndReload,
  randomCode, normalizeCode, formatCode, CODE_RE, esc, count, withParams, voteUrlText,
  sortedContests, sortedCandidates, tally, isPermissionDenied
} from "./firebase.js";

const $ = s => document.querySelector(s);
const D = { state: { phase: "idle" }, contests: {}, votes: {}, codes: {}, claims: {} };
let lastBatch = [];

// The positions are fixed by the constitution, always run in this order
const ROLES = [
  { id: "president", title: "President" },
  { id: "vp-events", title: "Vice President - Events" },
  { id: "vp-marketing", title: "Vice President - Marketing" },
  { id: "treasurer", title: "Treasurer" },
  { id: "secretary", title: "Secretary" }
];

accessGate($("#gate"), "host", () => {
  $("#main").hidden = false;
  $("#screenLink").href = withParams("screen.html");
  $("#voteLink").href = withParams("./");
  $("#signOut").onclick = signOutAndReload;
  let rolesChecked = false;
  const sub = (key, fallback) => onValue(ref(db, key), s => {
    D[key] = s.val() || fallback;
    if (key === "contests" && !rolesChecked) { rolesChecked = true; ensureRoles(); }
    render();
  }, e => toast(`Couldn't load ${key}: ${e.message}`, true));
  sub("state", { phase: "idle" });
  sub("contests", {});
  sub("votes", {});
  sub("codes", {});
  sub("claims", {});
});

// Make sure the five roles exist with the right titles and order. Any other position (from
// before the roles were fixed) is removed, keeping its candidates if it has the same name.
async function ensureRoles() {
  const norm = s => String(s || "").toLowerCase().replace(/[^a-z]/g, "");
  const strays = Object.entries(D.contests).filter(([id]) => !ROLES.some(r => r.id === id));
  const u = {};
  ROLES.forEach((r, i) => {
    const existing = D.contests[r.id];
    if (!existing) {
      const match = strays.find(([, c]) => norm(c.title) === norm(r.title));
      u[`contests/${r.id}`] = { title: r.title, order: i + 1, allowAbstain: true, status: "pending",
        ...(match?.[1].candidates ? { candidates: match[1].candidates } : {}) };
    } else {
      if (existing.title !== r.title) u[`contests/${r.id}/title`] = r.title;
      if (existing.order !== i + 1) u[`contests/${r.id}/order`] = i + 1;
    }
  });
  for (const [id] of strays) { u[`contests/${id}`] = null; u[`votes/${id}`] = null; }
  if (!Object.keys(u).length) return;
  const current = (await get(ref(db, "state/current")).catch(() => null))?.val();
  if (current && strays.some(([id]) => id === current)) u.state = { phase: "idle" };
  run(() => update(ref(db), u));
}

// ---- Derived state ----
const currentId = () => (D.state.current && D.contests[D.state.current] ? D.state.current : null);
const phaseOf = () => (currentId() ? D.state.phase || "idle" : "idle");
const statusOf = c => c.status || "pending";
const nextPending = () => sortedContests(D.contests).find(c => c.id !== currentId() && statusOf(c) === "pending");
const votesFor = id => count(D.votes[id]);
const STATUS = { pending: "Not started", speeches: "Speeches", open: "Voting", closed: "Closed", revealed: "Results shown" };

// ---- Rendering (inputs keep their text and focus across live updates) ----
function render() {
  rerender($("#live"), liveHtml());
  rerender($("#contests"), contestsHtml());
  rerender($("#codes"), codesHtml());
  autoAdvance();
}

// Once everyone checked in has voted, wait a moment, then show the results automatically
let autoTimer = null;
function autoAdvance() {
  const cur = currentId();
  const allIn = () => phaseOf() === "open" && currentId() === cur && count(D.claims) > 0 && votesFor(cur) >= count(D.claims);
  if (!allIn() || autoTimer) return;
  autoTimer = setTimeout(() => {
    autoTimer = null;
    if (allIn()) actions.reveal();
  }, 2500);
}

function rerender(el, html) {
  const active = document.activeElement;
  const keep = {};
  el.querySelectorAll("[data-keep]").forEach(i => {
    if (i.classList.contains("draft") || i === active) keep[i.dataset.keep] = i.value;
  });
  const focusKey = active && el.contains(active) ? active.dataset.keep : null;
  let selStart, selEnd;
  if (focusKey) { try { selStart = active.selectionStart; selEnd = active.selectionEnd; } catch { /* not a text field */ } }
  el.innerHTML = html;
  const find = k => el.querySelector(`[data-keep="${CSS.escape(k)}"]`);
  for (const [k, v] of Object.entries(keep)) { const i = find(k); if (i) i.value = v; }
  if (focusKey) {
    const i = find(focusKey);
    if (i) { i.focus({ preventScroll: true }); try { i.setSelectionRange(selStart, selEnd); } catch { /* number input */ } }
  }
}

function liveHtml() {
  const list = sortedContests(D.contests);
  const cur = currentId();
  const phase = phaseOf();
  const c = cur ? D.contests[cur] : null;
  const checked = count(D.claims);
  const cast = cur ? votesFor(cur) : 0;
  const next = nextPending();
  const cands = c ? sortedCandidates(c) : [];

  // Speeches -> Voting -> Results for the current position
  const step = c ? { speeches: 0, open: 1, closed: 1, revealed: 2 }[phase] ?? -1 : -1;
  const stepper = step < 0 ? "" : `
    <ol class="stepper">${["Speeches", "Voting", "Results"].map((s, i) => `
      <li class="${i < step ? "is-done" : ""} ${i === step ? "is-now" : ""}"><span>${i < step ? "✓" : i + 1}</span>${s}</li>`).join("")}
    </ol>`;
  const heading = (eyebrow, title) => `
    <div>
      <p class="eyebrow">${eyebrow}</p>
      <h3 class="live-title">${esc(title)}</h3>
    </div>`;
  const position = c ? `Position ${list.findIndex(x => x.id === cur) + 1} of ${list.length}` : "";
  const floor = id => `
    <form data-form="floor" data-id="${esc(id)}" class="field">
      <span>Floor nomination</span>
      <div class="cand-row">
        <input class="input draft" data-keep="floor" placeholder="Nominee's name" maxlength="80" autocomplete="off">
        <button class="btn">Add</button>
      </div>
    </form>`;
  const nextButton = label => next
    ? `<button class="btn btn-primary btn-lg btn-block" data-action="speeches" data-id="${esc(next.id)}">${label}: ${esc(next.title)}</button>`
    : "";

  // Between positions (or before the first one)
  if (!c || phase === "idle") {
    return `
      <h2>Live</h2>
      ${heading(next ? "Up next" : "Welcome screen", next ? next.title : "All positions done")}
      <p class="small muted">${next
        ? "The screen is showing the welcome page and check-in QR code."
        : "Every position has been run."}</p>
      <div class="live-actions">${nextButton("Start speeches")}</div>
      ${checkedInStat(checked)}`;
  }

  if (phase === "speeches") {
    const speaker = D.state.speaker;
    return `
      <h2>Live</h2>
      ${stepper}
      ${heading(`${position} · Speeches`, c.title)}
      <div class="field">
        <span>Who's speaking? <span class="muted">(shown big on the screen)</span></span>
        <div class="speaker-list">
          ${cands.map(k => `<button class="speaker ${speaker === k.id ? "is-on" : ""}" data-action="speaker" data-cid="${esc(k.id)}">${esc(k.name)}</button>`).join("")
            || `<p class="small muted">No candidates yet. Add them below.</p>`}
        </div>
        ${speaker ? `<button class="btn btn-sm" data-action="speaker" data-cid="">Show all candidates</button>` : ""}
      </div>
      ${floor(cur)}
      <div class="live-actions">
        <button class="btn btn-primary btn-lg btn-block" data-action="open" ${cands.length ? "" : "disabled"}>Open voting</button>
      </div>
      <p class="small muted">Phones show the candidates now but can't vote until you open voting.</p>`;
  }

  if (phase === "open" || phase === "closed") {
    const pct = checked ? Math.min(100, Math.round(cast / checked * 100)) : 0;
    const left = Math.max(0, checked - cast);
    return `
      <h2>Live</h2>
      ${stepper}
      ${heading(`${position} · <span class="live-dot"></span>Voting open`, c.title)}
      <div class="stats">
        <div class="stat"><b>${cast}</b><span>votes in</span></div>
        <div class="stat"><b>${checked}</b><span>checked in</span></div>
      </div>
      <div class="meter" aria-hidden="true"><span style="width:${pct}%"></span></div>
      <p class="small ${left ? "muted" : ""}">${left
        ? `Results appear automatically once everyone checked in has voted (${left} to go).`
        : "Everyone has voted. Showing results…"}</p>
      <div class="live-actions">
        <button class="btn btn-primary btn-lg btn-block" data-action="reveal">Close voting and show results</button>
        ${cast === 0 ? `<div class="row-actions"><button class="btn btn-sm" data-action="toSpeeches">Back to speeches</button></div>` : ""}
      </div>`;
  }

  // Results
  const t = tally(c, D.votes[cur]);
  const name = id => esc(cands.find(k => k.id === id)?.name || "");
  const outcome = t.winner ? `<p class="outcome">🎉 <b>${name(t.winner)}</b> elected</p>`
    : t.leaders.length > 1 ? `<p class="outcome is-tie">Tie between ${t.leaders.map(name).join(" and ")}</p>`
    : `<p class="outcome muted">No votes were cast.</p>`;
  return `
    <h2>Live</h2>
    ${stepper}
    ${heading(`${position} · Results on screen`, c.title)}
    ${outcome}
    <div class="tally">${t.rows.map(r => `
      <div class="tally-row ${t.leaders.includes(r.id) ? "is-lead" : ""}"><span>${esc(r.name)}</span><b>${r.n}</b>
        <div class="meter"><span style="width:${t.max ? r.n / t.max * 100 : 0}%"></span></div></div>`).join("")}
      ${t.abstain ? `<div class="tally-row"><span class="muted">Abstain</span><b class="muted">${t.abstain}</b></div>` : ""}
    </div>
    <div class="live-actions">
      ${nextButton("Next: start speeches")}
      <div class="row-actions">
        <button class="btn btn-sm" data-action="rerun" data-id="${esc(cur)}">Re-run this vote</button>
        <button class="btn btn-sm ${next ? "" : "btn-primary"}" data-action="clear">Show welcome screen</button>
      </div>
    </div>`;
}

function checkedInStat(checked) {
  return `<div class="stats"><div class="stat"><b>${checked}</b><span>checked in</span></div><div class="stat"><b>${count(D.codes)}</b><span>codes issued</span></div></div>`;
}

function contestsHtml() {
  const list = sortedContests(D.contests).filter(c => ROLES.some(r => r.id === c.id));
  const cur = currentId(), phase = phaseOf();
  const cards = list.map((c, i) => {
    const status = statusOf(c);
    const n = votesFor(c.id);
    const isCurrent = c.id === cur && phase !== "idle";
    const voted = new Set(Object.values(D.votes[c.id] || {}));
    const cands = sortedCandidates(c).map(k => `
      <div class="cand-row">
        <input class="input" data-keep="cand-${esc(c.id)}-${esc(k.id)}" data-edit="candidate" data-id="${esc(c.id)}" data-cid="${esc(k.id)}"
          value="${esc(k.name)}" maxlength="80" aria-label="Candidate name">
        <button class="btn btn-sm" data-action="removeCandidate" data-id="${esc(c.id)}" data-cid="${esc(k.id)}"
          ${voted.has(k.id) ? `disabled title="Already has votes"` : ""} aria-label="Remove ${esc(k.name)}">✕</button>
      </div>`).join("");
    return `
      <article class="contest ${c.id === cur ? "is-live" : ""}">
        <div class="contest-head">
          <span class="num">${i + 1}</span>
          <h3 class="role-title">${esc(c.title)}</h3>
          <span class="badge badge-${status}">${STATUS[status]}${n && status !== "open" ? ` · ${n}` : ""}</span>
        </div>
        <div class="cands">
          ${cands}
          <form data-form="candidate" data-id="${esc(c.id)}" class="cand-row">
            <input class="input draft" data-keep="new-${esc(c.id)}" placeholder="Add a candidate's name" maxlength="80" autocomplete="off">
            <button class="btn btn-sm">Add</button>
          </form>
        </div>
        <div class="row-actions">
          <label class="check"><input type="checkbox" data-edit="abstain" data-id="${esc(c.id)}" ${c.allowAbstain ? "checked" : ""}> Allow abstain</label>
          <span class="spacer"></span>
          ${isCurrent ? "" : status === "revealed" || status === "closed"
            ? `<button class="btn btn-sm" data-action="rerun" data-id="${esc(c.id)}">Re-run</button>`
            : `<button class="btn btn-sm" data-action="speeches" data-id="${esc(c.id)}">Start now</button>`}
        </div>
      </article>`;
  }).join("");

  return `
    <div class="panel-head"><h2>Candidates</h2><span class="small muted">Run top to bottom</span></div>
    <div class="role-grid">${cards || `<p class="muted">Setting up the roles…</p>`}</div>`;
}

function codesHtml() {
  const issued = count(D.codes), checked = count(D.claims);
  return `
    <h2>Codes</h2>
    <div class="stats">
      <div class="stat"><b>${issued}</b><span>issued</span></div>
      <div class="stat"><b>${checked}</b><span>checked in</span></div>
    </div>
    <form data-form="generate" class="cand-row">
      <input class="input draft" data-keep="gen" type="number" min="1" max="1000" value="100" style="max-width:110px" aria-label="How many codes">
      <button class="btn">Generate codes</button>
    </form>
    <div class="row-actions">
      <button class="btn btn-sm" data-action="printBatch" ${lastBatch.length ? "" : "disabled"}>Print new batch (${lastBatch.length})</button>
      <button class="btn btn-sm" data-action="printAll" ${issued ? "" : "disabled"}>Print all codes (${issued})</button>
    </div>
    <p class="small muted">Hand out one slip per member. Print a new batch only once, so no code is handed out twice.</p>
    <form data-form="release" class="field">
      <span>Release a code</span>
      <div class="cand-row">
        <input class="input draft code-mini" data-keep="release" placeholder="ABC-234" maxlength="7" autocomplete="off">
        <button class="btn">Release</button>
      </div>
      <span class="small muted">Phone died? Release their code so they can check in again on another device. Votes already cast with it still count and can't be cast twice.</span>
    </form>`;
}

// ---- Actions ----
async function run(fn, ok) {
  try { await fn(); if (ok) toast(ok); }
  catch (e) {
    toast(isPermissionDenied(e)
      ? "Firebase refused that change. If the site was just updated, re-publish database.rules.json in the Firebase console."
      : e.message || String(e), true);
  }
}

const actions = {
  // Speeches for a position: the screen shows its candidates, phones see them but can't vote
  speeches: id => {
    const u = { state: { current: id, phase: "speeches" }, [`contests/${id}/status`]: "speeches" };
    const prev = currentId();
    if (prev && prev !== id && phaseOf() === "open") u[`contests/${prev}/status`] = "closed";
    return run(() => update(ref(db), u));
  },
  speaker: (_id, cid) => run(() => update(ref(db, "state"), { speaker: cid && cid !== D.state.speaker ? cid : null })),
  open: () => run(() => update(ref(db), { "state/phase": "open", "state/speaker": null, [`contests/${currentId()}/status`]: "open" })),
  toSpeeches: () => run(() => update(ref(db), { "state/phase": "speeches", [`contests/${currentId()}/status`]: "speeches" })),
  // Close voting and show the results; the winner is saved so phones can congratulate them too
  reveal: () => {
    const cur = currentId();
    const t = tally(D.contests[cur], D.votes[cur]);
    return run(() => update(ref(db), {
      "state/phase": "revealed",
      "state/speaker": null,
      [`contests/${cur}/status`]: "revealed",
      [`contests/${cur}/winner`]: t.winner || (t.leaders.length > 1 ? "tie" : "none")
    }));
  },
  rerun: id => {
    const c = D.contests[id], n = votesFor(id);
    if (!confirm(`Re-run the vote for ${c.title}?${n ? ` Its ${n} vote${n === 1 ? "" : "s"} will be deleted.` : ""} It goes back to speeches, so you can remove candidates first if it's a run-off.`)) return;
    return run(() => update(ref(db), {
      [`votes/${id}`]: null,
      [`contests/${id}/winner`]: null,
      [`contests/${id}/status`]: "speeches",
      state: { current: id, phase: "speeches" }
    }));
  },
  clear: () => run(() => update(ref(db), { state: { phase: "idle" } })),

  removeCandidate: (id, cid) => {
    const name = D.contests[id]?.candidates?.[cid]?.name;
    if (!confirm(`Remove ${name} from ${D.contests[id].title}?`)) return;
    return run(() => remove(ref(db, `contests/${id}/candidates/${cid}`)));
  },

  printBatch: () => printCodes(lastBatch),
  printAll: () => printCodes(Object.keys(D.codes).sort()),

  resetVotes: () => {
    if (prompt("This deletes every vote and puts the screen back to the welcome page. Codes and check-ins are kept.\n\nType RESET to confirm.") !== "RESET") return;
    const u = { votes: null, state: { phase: "idle" } };
    Object.keys(D.contests).forEach(id => { u[`contests/${id}/status`] = "pending"; u[`contests/${id}/winner`] = null; });
    return run(() => update(ref(db), u), "All votes cleared");
  },
  resetAll: () => {
    if (prompt("This deletes every vote, every code and every check-in. Old code slips will stop working.\n\nType RESET to confirm.") !== "RESET") return;
    const u = { votes: null, claims: null, codes: null, state: { phase: "idle" } };
    Object.keys(D.contests).forEach(id => { u[`contests/${id}/status`] = "pending"; u[`contests/${id}/winner`] = null; });
    lastBatch = [];
    return run(() => update(ref(db), u), "Votes, codes and check-ins cleared");
  }
};

const forms = {
  candidate: (id, value) => addCandidate(id, value),
  floor: (id, value) => addCandidate(id, value, `${value} added to ${D.contests[id]?.title}`),
  generate: (_id, value) => {
    const n = Math.max(1, Math.min(1000, Math.floor(Number(value) || 0)));
    const batch = {};
    while (count(batch) < n) {
      const c = randomCode();
      if (!D.codes[c]) batch[c] = true;
    }
    return run(async () => {
      await update(ref(db, "codes"), batch);
      lastBatch = Object.keys(batch).sort();
      render();
    }, `${n} codes generated. Print the new batch to hand them out.`);
  },
  release: (_id, value) => {
    const code = normalizeCode(value);
    if (!CODE_RE.test(code)) return toast("That isn't a valid code format.", true);
    if (!D.codes[code]) return toast(`${formatCode(code)} was never issued.`, true);
    if (!D.claims[code]) return toast(`${formatCode(code)} hasn't been used yet. Nothing to release.`, true);
    return run(() => remove(ref(db, `claims/${code}`)), `${formatCode(code)} released. It can be entered on a new device.`);
  }
};

function addCandidate(contestId, name, ok) {
  const orders = Object.values(D.contests[contestId]?.candidates || {}).map(k => k.order || 0);
  return run(() => push(ref(db, `contests/${contestId}/candidates`), { name, order: Math.max(0, ...orders) + 1 }), ok);
}

// Text edits save shortly after typing stops; the checkbox saves immediately
const timers = {};
function saveEdit(el) {
  const { edit, id, cid } = el.dataset;
  if (edit === "abstain") return run(() => update(ref(db, `contests/${id}`), { allowAbstain: el.checked }));
  const key = el.dataset.keep;
  clearTimeout(timers[key]);
  timers[key] = setTimeout(() => {
    const live = document.querySelector(`[data-keep="${CSS.escape(key)}"]`) || el;
    const value = live.value.trim();
    if (!value) return;
    run(() => update(ref(db), { [`contests/${id}/candidates/${cid}/name`]: value }));
  }, 500);
}

const main = $("#main");
main.addEventListener("click", e => {
  const b = e.target.closest("[data-action]");
  if (b && !b.disabled) actions[b.dataset.action]?.(b.dataset.id, b.dataset.cid, b);
});
main.addEventListener("submit", e => {
  e.preventDefault();
  const form = e.target, input = form.querySelector("input");
  const value = input.value.trim();
  if (!value) return;
  if (input.classList.contains("draft") && form.dataset.form !== "generate") input.value = "";
  forms[form.dataset.form]?.(form.dataset.id, value);
});
main.addEventListener("input", e => { if (e.target.dataset.edit && e.target.type !== "checkbox") saveEdit(e.target); });
main.addEventListener("change", e => { if (e.target.dataset.edit === "abstain") saveEdit(e.target); });

// ---- Printing code slips ----
function printCodes(codes) {
  if (!codes.length) return;
  const url = voteUrlText();
  $("#print").innerHTML = codes.map(c => `
    <div class="slip">
      <div class="slip-org">UQSLA AGM · Voting code</div>
      <div class="slip-code">${formatCode(c)}</div>
      <div class="slip-url">Vote at ${esc(url)}</div>
      <div class="slip-note">Keep this private. It works on one device only.</div>
    </div>`).join("");
  window.print();
}

// ---- Toast ----
let toastTimer;
function toast(msg, isError = false) {
  let el = $(".toast");
  if (!el) { el = document.createElement("div"); el.className = "toast"; el.setAttribute("role", "status"); document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.toggle("is-error", isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 6000 : 3000);
}
