// Projector screen: welcome + check-in QR, speeches, voting, then congratulations + results.
import {
  db, ref, onValue, accessGate, esc, count, voteUrl, voteUrlText, sortedCandidates, tally,
  isMotion, motionPoints, motionResult, pct
} from "./firebase.js";
import { confetti } from "./confetti.js";

const stage = document.getElementById("stage");
const D = { state: { phase: "idle" }, contests: {}, votes: {}, claims: {} };
let signature = null;

accessGate(document.getElementById("gate"), "screen", () => {
  stage.hidden = false;
  for (const key of Object.keys(D)) {
    onValue(ref(db, key), s => { D[key] = s.val() || (key === "state" ? { phase: "idle" } : {}); render(); });
  }
  showHint();
});

const lockup = (cls = "") => `
  <div class="lockup ${cls}">
    <img class="lion" src="../logo.png" alt="UQSLA lion">
    <div class="lockup-rule"></div>
    <div class="lockup-text">
      <span class="l1">The University of<br>Queensland</span>
      <span class="l2">Sri Lankan<br>Association</span>
    </div>
  </div>`;

const qrCard = () => `<div class="qr-card" data-qr></div>`;

function render() {
  const cur = D.state.current && D.contests[D.state.current] ? D.state.current : null;
  const phase = cur ? D.state.phase || "idle" : "idle";
  const c = cur ? D.contests[cur] : null;

  let sig, html, celebrate = false;
  const points = () => `<ul class="s-points">${motionPoints(c).map(p => `<li>${esc(p)}</li>`).join("")}</ul>`;
  if (phase === "speeches" && isMotion(c)) {
    sig = JSON.stringify(["motion", cur, c.title, c.description]);
    html = `
      <header class="s-head">${lockup("sm")}<span class="s-pill">Special resolution</span></header>
      <div class="s-body">
        <div class="s-main">
          <p class="eyebrow">Up next · Special resolution</p>
          <h1 class="s-title">${esc(c.title)}</h1>
          ${points()}
          <p class="s-sub">Needs more than ${pct(c.threshold ?? 0.5)} of votes For to pass. Voting opens on your phone after the motion is presented.</p>
        </div>
        <aside class="s-side">${qrCard()}<p class="url">${esc(voteUrlText())}</p><p class="muted">Not checked in? Scan now.</p></aside>
      </div>`;
  } else if (phase === "speeches") {
    const cands = sortedCandidates(c);
    const speaker = cands.find(k => k.id === D.state.speaker);
    sig = JSON.stringify(["speeches", cur, c.title, cands.map(k => k.name), speaker?.id]);
    const others = cands.filter(k => k !== speaker);
    html = `
      <header class="s-head">${lockup("sm")}<span class="s-pill">Candidate speeches</span></header>
      <div class="s-body">
        <div class="s-main">
          ${speaker ? `
            <p class="eyebrow">Candidate for</p>
            <p class="s-role">${esc(c.title)}</p>
            <h1 class="s-speaker">${esc(speaker.name)}</h1>
            ${others.length ? `<p class="s-also">Also standing: ${others.map(k => esc(k.name)).join(" · ")}</p>` : ""}` : `
            <p class="eyebrow">Up next</p>
            <h1 class="s-title">${esc(c.title)}</h1>
            <ul class="s-cands">${cands.map(k => `<li>${esc(k.name)}</li>`).join("")}</ul>
            <p class="s-sub">Candidate speeches, then voting opens on your phone.</p>`}
        </div>
        <aside class="s-side">${qrCard()}<p class="url">${esc(voteUrlText())}</p><p class="muted">Not checked in? Scan now.</p></aside>
      </div>`;
  } else if (phase === "open") {
    const names = sortedCandidates(c).map(k => k.name);
    sig = JSON.stringify(["open", cur, c.title, names]);
    html = `
      <header class="s-head">${lockup("sm")}<span class="s-pill is-open"><span class="live-dot"></span>Voting open</span></header>
      <div class="s-body">
        <div class="s-main">
          <p class="eyebrow">Now voting${isMotion(c) ? " · Special resolution" : ""}</p>
          <h1 class="s-title">${esc(c.title)}</h1>
          ${isMotion(c) ? points() : `<ul class="s-cands">${names.map(n => `<li>${esc(n)}</li>`).join("")}</ul>`}
        </div>
        <aside class="s-side">${qrCard()}<p class="url">${esc(voteUrlText())}</p><p class="muted">Not checked in? Scan to vote.</p></aside>
      </div>
      <p class="s-allin" data-bind="allin" hidden>All votes are in</p>
      ${turnoutHtml()}`;
  } else if (phase === "closed") {
    sig = JSON.stringify(["closed", cur, c.title]);
    html = `
      <header class="s-head">${lockup("sm")}<span class="s-pill">Voting closed</span></header>
      <div class="s-body">
        <div class="s-main">
          <p class="eyebrow">${esc(c.title)}</p>
          <h1 class="s-title">Voting closed</h1>
          <p class="s-sub"><b data-bind="cast">0</b> votes cast. Results coming up.</p>
        </div>
      </div>`;
  } else if (phase === "revealed" && isMotion(c)) {
    const m = motionResult(c, D.votes[cur]);
    sig = JSON.stringify(["motion-result", cur, c.title, m.yes, m.no]);
    celebrate = m.passed;
    html = `
      <header class="s-head">${lockup("sm")}<span class="s-pill">Result</span></header>
      <div class="s-results">
        <div class="s-hero">
          <p class="eyebrow">Special resolution · ${esc(c.title)}</p>
          ${m.passed ? `<p class="congrats-line">Passed</p>` : `<h1 class="s-title">${m.total ? "Not passed" : "No votes"}</h1>`}
          <p class="s-sub">${m.total ? `${pct(m.share)} voted For. It needed more than ${pct(m.threshold)}.` : "No votes were cast."}</p>
        </div>
        ${m.total ? motionChartHtml(m) : ""}
      </div>`;
  } else if (phase === "revealed") {
    const t = tally(c, D.votes[cur]);
    const winner = t.rows.find(r => r.id === t.winner);
    sig = JSON.stringify(["revealed", cur, c.title, t.rows]);
    celebrate = !!winner;
    const hero = winner ? `
      <p class="eyebrow">${esc(c.title)} · Elected</p>
      <p class="congrats-line">Congratulations</p>
      <h1 class="congrats-name">${esc(winner.name)}</h1>` : t.leaders.length > 1 ? `
      <p class="eyebrow">${esc(c.title)}</p>
      <h1 class="s-title">It's a tie</h1>` : `
      <p class="eyebrow">Results</p>
      <h1 class="s-title">${esc(c.title)}</h1>`;
    html = `
      <header class="s-head">${lockup("sm")}<span class="s-pill">Results</span></header>
      <div class="s-results">
        <div class="s-hero">${hero}</div>
        ${chartHtml(c, t)}
      </div>`;
  } else {
    sig = "idle";
    html = `
      <div class="s-idle">
        ${lockup()}
        <p class="s-agm">Annual General Meeting</p>
        <div class="checkin">
          ${qrCard()}
          <div class="checkin-text">
            <p class="eyebrow">Check in to vote</p>
            <p class="url">${esc(voteUrlText())}</p>
            <p class="count"><b data-bind="checked">0</b> checked in</p>
          </div>
        </div>
      </div>`;
  }

  if (sig !== signature) {
    signature = sig;
    stage.innerHTML = html;
    if (celebrate) confetti();
    stage.querySelectorAll("[data-qr]").forEach(el => {
      if (window.QRCode) new QRCode(el, { text: voteUrl(), width: 480, height: 480, colorDark: "#081729", colorLight: "#ffffff", correctLevel: QRCode.CorrectLevel.M });
    });
  }
  updateNumbers(cur);
}

function turnoutHtml() {
  return `
    <footer class="turnout">
      <p class="turnout-label"><b data-bind="cast">0</b> of <b data-bind="checked">0</b> checked-in members have voted</p>
      <div class="t-bar"><span data-bind="bar" style="width:0%"></span></div>
    </footer>`;
}

// Live numbers update in place so the page doesn't flicker on every vote
function updateNumbers(cur) {
  const cast = cur ? count(D.votes[cur]) : 0;
  const checked = count(D.claims);
  stage.querySelectorAll('[data-bind="cast"]').forEach(el => { el.textContent = cast; });
  stage.querySelectorAll('[data-bind="checked"]').forEach(el => { el.textContent = checked; });
  stage.querySelectorAll('[data-bind="bar"]').forEach(el => {
    el.style.width = (checked ? Math.min(100, cast / checked * 100) : 0) + "%";
  });
  stage.querySelectorAll('[data-bind="allin"]').forEach(el => { el.hidden = !(checked > 0 && cast >= checked); });
}

// For / Against as shares of all votes, with a dashed marker at the pass threshold
function motionChartHtml(m) {
  const row = (label, n, lead, i) => `
    <div class="bar-row ${lead ? "is-lead" : ""}" style="--w:${n / m.total * 100}%;--d:${(i * 0.12).toFixed(2)}s">
      <div class="bar-name">${label}</div>
      <div class="bar-track has-threshold" style="--t:${m.threshold * 100}%"><div class="bar"></div></div>
      <div class="bar-val">${n}<span>${pct(n / m.total)}</span></div>
    </div>`;
  return `
    <div class="chart compact" role="img" aria-label="${esc(`For ${m.yes}, Against ${m.no}. ${pct(m.share)} For, needed more than ${pct(m.threshold)}.`)}">
      ${row("For", m.yes, m.passed, 0)}${row("Against", m.no, false, 1)}
    </div>
    <p class="chart-note">${m.total} vote${m.total === 1 ? "" : "s"} · dashed line marks ${pct(m.threshold)}</p>`;
}

function chartHtml(c, t) {
  if (!t.valid) return `<p class="s-sub">No votes were cast.</p>`;
  const tie = t.leaders.length > 1;
  const rows = t.rows.map((r, i) => {
    const lead = t.leaders.includes(r.id);
    const pct = t.valid ? Math.round(r.n / t.valid * 100) : 0;
    const tag = r.id === t.winner ? `<span class="tag">Elected</span>` : lead && tie ? `<span class="tag tag-tie">Tie</span>` : "";
    return `
      <div class="bar-row ${lead ? "is-lead" : ""}" style="--w:${t.max ? r.n / t.max * 100 : 0}%;--d:${(i * 0.12).toFixed(2)}s">
        <div class="bar-name">${esc(r.name)}${tag}</div>
        <div class="bar-track"><div class="bar"></div></div>
        <div class="bar-val">${r.n}<span>${pct}%</span></div>
      </div>`;
  }).join("");
  const label = t.rows.map(r => `${r.name} ${r.n}`).join(", ");
  return `
    <div class="chart compact" role="img" aria-label="${esc(`Results for ${c.title}: ${label}`)}">${rows}</div>
    <p class="chart-note">${t.valid} vote${t.valid === 1 ? "" : "s"}</p>`;
}

// ---- Projector niceties: F for full screen, hide an idle cursor ----
function showHint() {
  const hint = document.getElementById("fsHint");
  hint.hidden = false;
  setTimeout(() => { hint.style.opacity = "0"; }, 6000);
}
addEventListener("keydown", e => {
  if (e.key.toLowerCase() !== "f" || e.target.closest?.("input")) return;
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
});
let cursorTimer;
addEventListener("mousemove", () => {
  document.body.classList.remove("hide-cursor");
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(() => document.body.classList.add("hide-cursor"), 2500);
});
