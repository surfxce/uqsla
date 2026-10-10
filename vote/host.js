// Host page: run the AGM one position at a time, manage candidates and voting codes.
import {
  db, ref, update, remove, push, onValue, accessGate, signOutAndReload,
  randomCode, normalizeCode, formatCode, CODE_RE, esc, count, withParams, voteUrlText,
  sortedContests, sortedCandidates, tally
} from "./firebase.js";

const $ = s => document.querySelector(s);
const D = { state: { phase: "idle" }, contests: {}, votes: {}, codes: {}, claims: {} };
let lastBatch = [];

accessGate($("#gate"), "host", () => {
  $("#main").hidden = false;
  $("#screenLink").href = withParams("screen.html");
  $("#voteLink").href = withParams("./");
  $("#signOut").onclick = signOutAndReload;
  const sub = (key, fallback) => onValue(ref(db, key), s => { D[key] = s.val() || fallback; render(); },
    e => toast(`Couldn't load ${key}: ${e.message}`, true));
  sub("state", { phase: "idle" });
  sub("contests", {});
  sub("votes", {});
  sub("codes", {});
  sub("claims", {});
});

// ---- Derived state ----
const currentId = () => (D.state.current && D.contests[D.state.current] ? D.state.current : null);
const phaseOf = () => (currentId() ? D.state.phase || "idle" : "idle");
const statusOf = c => c.status || "pending";
const nextPending = () => sortedContests(D.contests).find(c => c.id !== currentId() && statusOf(c) === "pending");
const votesFor = id => count(D.votes[id]);
const STATUS = { pending: "Not started", open: "Voting open", closed: "Closed", revealed: "Results shown" };

// ---- Rendering (inputs keep their text and focus across live updates) ----
function render() {
  rerender($("#live"), liveHtml());
  rerender($("#contests"), contestsHtml());
  rerender($("#codes"), codesHtml());
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
  const cur = currentId();
  const phase = phaseOf();
  const c = cur ? D.contests[cur] : null;
  const checked = count(D.claims);
  const cast = cur ? votesFor(cur) : 0;
  const next = nextPending();
  const pct = checked ? Math.min(100, Math.round(cast / checked * 100)) : 0;
  const label = { idle: "Waiting screen", open: "Voting open", closed: "Voting closed", revealed: "Results on screen" }[phase];

  let actions = "";
  if (phase === "open") {
    actions = `<button class="btn btn-primary btn-lg btn-block" data-action="close">Close voting</button>`;
  } else if (phase === "closed") {
    actions = `<button class="btn btn-primary btn-lg btn-block" data-action="reveal">Show results on screen</button>
      <div class="row-actions"><button class="btn btn-sm" data-action="reopen">Reopen voting</button>
      <button class="btn btn-sm" data-action="clear">Show welcome screen</button></div>`;
  } else {
    actions = next
      ? `<button class="btn btn-primary btn-lg btn-block" data-action="open" data-id="${esc(next.id)}">Open voting: ${esc(next.title)}</button>`
      : `<p class="muted">${count(D.contests) ? "Every position has been run." : "Add positions on the right to get started."}</p>`;
    if (phase === "revealed") actions += `<div class="row-actions"><button class="btn btn-sm" data-action="clear">Show welcome screen</button></div>`;
  }

  // Tallies stay hidden from the host until voting closes
  let tallyHtml = "";
  if (c && (phase === "closed" || phase === "revealed")) {
    const t = tally(c, D.votes[cur]);
    tallyHtml = `<div class="tally">${t.rows.map(r => `
      <div class="tally-row ${t.leaders.includes(r.id) ? "is-lead" : ""}"><span>${esc(r.name)}</span><b>${r.n}</b>
        <div class="meter"><span style="width:${t.max ? r.n / t.max * 100 : 0}%"></span></div></div>`).join("")}
      ${t.abstain ? `<div class="tally-row"><span class="muted">Abstain</span><b class="muted">${t.abstain}</b></div>` : ""}
    </div>`;
  }

  const target = phase === "open" ? { id: cur, ...c } : next;
  const floor = target ? `
    <form data-form="floor" data-id="${esc(target.id)}" class="field">
      <span>Floor nomination · ${esc(target.title)}</span>
      <div class="cand-row">
        <input class="input draft" data-keep="floor" placeholder="Nominee's name" maxlength="80" autocomplete="off">
        <button class="btn">Add</button>
      </div>
      <span class="small muted">${phase === "open" ? "Appears on everyone's ballot straight away." : "Added to the ballot before voting opens."}</span>
    </form>` : "";

  return `
    <h2>Live</h2>
    <div>
      <p class="eyebrow">${phase === "open" ? `<span class="live-dot"></span>` : ""}${label}</p>
      <h3 class="live-title">${c ? esc(c.title) : "Nothing open"}</h3>
    </div>
    <div class="stats">
      <div class="stat"><b>${cur ? cast : "–"}</b><span>votes in</span></div>
      <div class="stat"><b>${checked}</b><span>checked in</span></div>
    </div>
    <div class="meter" aria-hidden="true"><span style="width:${pct}%"></span></div>
    ${tallyHtml}
    <div class="live-actions">${actions}</div>
    ${floor}`;
}

function contestsHtml() {
  const list = sortedContests(D.contests);
  const cur = currentId(), phase = phaseOf();
  const cards = list.map((c, i) => {
    const status = statusOf(c);
    const n = votesFor(c.id);
    const isLive = c.id === cur && phase === "open";
    const voted = new Set(Object.values(D.votes[c.id] || {}));
    const cands = sortedCandidates(c).map(k => `
      <div class="cand-row">
        <input class="input" data-keep="cand-${esc(c.id)}-${esc(k.id)}" data-edit="candidate" data-id="${esc(c.id)}" data-cid="${esc(k.id)}"
          value="${esc(k.name)}" maxlength="80" aria-label="Candidate name">
        <button class="btn btn-sm" data-action="removeCandidate" data-id="${esc(c.id)}" data-cid="${esc(k.id)}"
          ${voted.has(k.id) ? `disabled title="Already has votes"` : ""}>Remove</button>
      </div>`).join("");
    return `
      <article class="contest ${c.id === cur ? "is-live" : ""}">
        <div class="contest-head">
          <span class="num">${i + 1}</span>
          <input class="input" data-keep="title-${esc(c.id)}" data-edit="title" data-id="${esc(c.id)}" value="${esc(c.title)}" maxlength="80" aria-label="Position title">
          <span class="badge badge-${status}">${STATUS[status]}${n && status !== "open" ? ` · ${n}` : ""}</span>
        </div>
        <div class="cands">
          ${cands || `<p class="small muted">No candidates yet.</p>`}
          <form data-form="candidate" data-id="${esc(c.id)}" class="cand-row">
            <input class="input draft" data-keep="new-${esc(c.id)}" placeholder="Add a candidate" maxlength="80" autocomplete="off">
            <button class="btn btn-sm">Add</button>
          </form>
        </div>
        <div class="row-actions">
          <label class="check"><input type="checkbox" data-edit="abstain" data-id="${esc(c.id)}" ${c.allowAbstain ? "checked" : ""}> Allow abstain</label>
          <span class="spacer"></span>
          <button class="btn btn-sm" data-action="move" data-id="${esc(c.id)}" data-dir="-1" ${i === 0 ? "disabled" : ""} aria-label="Move up">↑</button>
          <button class="btn btn-sm" data-action="move" data-id="${esc(c.id)}" data-dir="1" ${i === list.length - 1 ? "disabled" : ""} aria-label="Move down">↓</button>
          <button class="btn btn-sm btn-danger" data-action="deleteContest" data-id="${esc(c.id)}">Delete</button>
          ${isLive ? "" : `<button class="btn btn-sm" data-action="open" data-id="${esc(c.id)}">${status === "pending" ? "Open voting" : "Reopen voting"}</button>`}
        </div>
      </article>`;
  }).join("");

  return `
    <div class="panel-head"><h2>Positions</h2><span class="small muted">Run top to bottom</span></div>
    ${cards || `<p class="muted">No positions yet.</p>
      <div><button class="btn btn-sm" data-action="standard">Add President, Vice President, Secretary and Treasurer</button></div>`}
    <form data-form="contest" class="cand-row">
      <input class="input draft" data-keep="newContest" placeholder="Add a position, e.g. Events Officer" maxlength="80" autocomplete="off">
      <button class="btn">Add position</button>
    </form>`;
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
  catch (e) { toast(e.message || String(e), true); }
}

const actions = {
  open: id => {
    const u = { state: { current: id, phase: "open" }, [`contests/${id}/status`]: "open" };
    const prev = currentId();
    if (prev && prev !== id && phaseOf() === "open") u[`contests/${prev}/status`] = "closed";
    return run(() => update(ref(db), u));
  },
  close: () => run(() => update(ref(db), { "state/phase": "closed", [`contests/${currentId()}/status`]: "closed" })),
  reveal: () => run(() => update(ref(db), { "state/phase": "revealed", [`contests/${currentId()}/status`]: "revealed" })),
  reopen: () => run(() => update(ref(db), { "state/phase": "open", [`contests/${currentId()}/status`]: "open" })),
  clear: () => run(() => update(ref(db), { state: { phase: "idle" } })),

  standard: () => {
    const u = {};
    ["President", "Vice President", "Secretary", "Treasurer"].forEach((title, i) => {
      u[push(ref(db, "contests")).key] = { title, order: i + 1, allowAbstain: true, status: "pending" };
    });
    return run(() => update(ref(db, "contests"), u));
  },
  move: (id, _cid, btn) => {
    const list = sortedContests(D.contests);
    const i = list.findIndex(c => c.id === id), j = i + Number(btn.dataset.dir);
    if (!list[j]) return;
    // Re-number everything so equal or missing orders can't get stuck
    [list[i], list[j]] = [list[j], list[i]];
    const u = {};
    list.forEach((c, k) => { u[`${c.id}/order`] = k + 1; });
    return run(() => update(ref(db, "contests"), u));
  },
  deleteContest: id => {
    const c = D.contests[id], n = votesFor(id);
    if (!confirm(`Delete ${c.title}${n ? ` and its ${n} vote${n === 1 ? "" : "s"}` : ""}?`)) return;
    const u = { [`contests/${id}`]: null, [`votes/${id}`]: null };
    if (D.state.current === id) u.state = { phase: "idle" };
    return run(() => update(ref(db), u));
  },
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
    Object.keys(D.contests).forEach(id => { u[`contests/${id}/status`] = "pending"; });
    return run(() => update(ref(db), u), "All votes cleared");
  },
  resetAll: () => {
    if (prompt("This deletes every vote, every code and every check-in. Old code slips will stop working.\n\nType RESET to confirm.") !== "RESET") return;
    const u = { votes: null, claims: null, codes: null, state: { phase: "idle" } };
    Object.keys(D.contests).forEach(id => { u[`contests/${id}/status`] = "pending"; });
    lastBatch = [];
    return run(() => update(ref(db), u), "Votes, codes and check-ins cleared");
  }
};

const forms = {
  contest: (_id, value) => {
    const order = Math.max(0, ...Object.values(D.contests).map(c => c.order || 0)) + 1;
    return run(() => push(ref(db, "contests"), { title: value, order, allowAbstain: true, status: "pending" }));
  },
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
    const path = edit === "title" ? `contests/${id}/title` : `contests/${id}/candidates/${cid}/name`;
    run(() => update(ref(db), { [path]: value }));
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
