// Attendee page: check in with a code, vote on whichever position is open, then wait.
import {
  auth, db, onAuthStateChanged, signInAnonymously, ref, get, set, onValue,
  CODE_RE, normalizeCode, formatCode, esc, sortedCandidates, isPermissionDenied
} from "./firebase.js";
import { confetti } from "./confetti.js";

const app = document.getElementById("app");
const STORE_KEY = "uqsla-agm-code";

const S = {
  uid: null,
  code: null,
  draft: "",
  state: null,         // { current, phase } from the host
  contest: null,       // the position currently on the ballot
  myVote: undefined,   // undefined = loading, null = not voted yet, string = voted
  selected: null,
  confirming: false,
  busy: false,
  error: "",
  celebrated: null     // contest id we've already thrown confetti for
};
let watching;                    // contest id the listeners below are attached to
let stopContest = () => {}, stopVote = () => {};

const saved = { get: () => { try { return localStorage.getItem(STORE_KEY); } catch { return null; } },
                put: c => { try { c ? localStorage.setItem(STORE_KEY, c) : localStorage.removeItem(STORE_KEY); } catch { /* private mode */ } } };

// ---- Auth: every phone gets an anonymous Firebase user, which "owns" the code it checks in with ----
onAuthStateChanged(auth, async user => {
  if (!user) {
    signInAnonymously(auth).catch(e => fatal(e?.code === "auth/operation-not-allowed"
      ? "Voting isn't switched on yet. Let an exec know."
      : "Couldn't connect. Check your internet connection, then reload."));
    return;
  }
  if (S.uid === user.uid) return;
  S.uid = user.uid;
  const code = saved.get();
  if (code) {
    const mine = await get(ref(db, `claims/${code}`)).then(s => s.val() === S.uid).catch(() => false);
    if (mine) return enter(code);
    saved.put(null);
  }
  render();
});

// Show a banner if the connection drops (after it has connected once)
let wasConnected = false;
onValue(ref(db, ".info/connected"), s => {
  const on = s.val() === true;
  if (on) wasConnected = true;
  document.getElementById("net").hidden = on || !wasConnected;
});

// ---- Checking in ----
async function checkIn() {
  const code = normalizeCode(S.draft);
  if (!CODE_RE.test(code)) {
    S.error = "Codes are 6 letters and numbers, like ABC-234.";
    return render();
  }
  S.busy = true; S.error = ""; render();
  const claimRef = ref(db, `claims/${code}`);
  try {
    const owner = (await get(claimRef)).val();
    if (owner === S.uid) return enter(code);
    if (owner) throw new Error("taken");
    await set(claimRef, S.uid);
    enter(code);
  } catch (e) {
    let msg = "Couldn't check you in. Check your connection and try again.";
    if (e.message === "taken") msg = "That code has already been used on another device. If it's yours, see an exec at the front.";
    else if (isPermissionDenied(e)) {
      // Denied either because the code doesn't exist or someone claimed it a moment ago
      const owner = await get(claimRef).then(s => s.val()).catch(() => null);
      msg = owner ? "That code has already been used on another device. If it's yours, see an exec at the front."
                  : "That code isn't valid. Check the slip and try again.";
    }
    S.busy = false; S.error = msg; render();
  }
}

function enter(code) {
  S.code = code; S.busy = false; S.error = "";
  saved.put(code);
  onValue(ref(db, "state"), snap => {
    S.state = snap.val() || { phase: "idle" };
    const current = S.state.current || null;
    if (current !== watching) watch(current);
    render();
  }, () => fatal("Lost access to the vote. Reload the page."));
}

function watch(id) {
  stopContest(); stopVote();
  watching = id;
  Object.assign(S, { contest: null, contestLoaded: false, myVote: id ? undefined : null, selected: null, confirming: false, error: "" });
  if (!id) return;
  stopContest = onValue(ref(db, `contests/${id}`), s => { S.contest = s.val(); S.contestLoaded = true; render(); });
  stopVote = onValue(ref(db, `votes/${id}/${S.code}`), s => { S.myVote = s.val(); render(); });
}

// ---- Voting ----
async function submitVote() {
  S.busy = true; render();
  try {
    await set(ref(db, `votes/${watching}/${S.code}`), S.selected);
    S.confirming = false;
  } catch (e) {
    S.confirming = false;
    S.error = isPermissionDenied(e)
      ? "Your vote wasn't accepted. Voting for this position may have just closed."
      : "Couldn't send your vote. Check your connection and try again.";
  }
  S.busy = false; render();
}

// ---- Screens ----
function render() {
  if (!S.uid) return show(`<div class="spinner" aria-label="Loading"></div>`);
  if (!S.code) return screenCode();
  const st = S.state;
  if (!st) return show(`<div class="spinner" aria-label="Loading"></div>`);
  const phase = st.phase || "idle";
  if (!st.current || phase === "idle") {
    return screenWait("You're checked in", "Voting opens here when the next position is called. Keep this page open. It updates by itself.");
  }
  if (S.contestLoaded && !S.contest) {
    return screenWait("You're checked in", "Voting opens here when the next position is called. Keep this page open. It updates by itself.");
  }
  if (!S.contest || S.myVote === undefined) return show(`<div class="spinner" aria-label="Loading"></div>`);
  if (phase === "speeches") return screenSpeeches();
  if (phase === "revealed") return screenResult();
  if (S.myVote) return screenDone();
  if (phase !== "open") {
    return screenWait(`Voting for ${S.contest.title} has closed`, "Results will be shown on the main screen. The next vote will appear here automatically.");
  }
  screenBallot();
}

function screenSpeeches() {
  const speaker = S.state.speaker;
  show(`
    <section class="screen center">
      <p class="eyebrow">Up next</p>
      <h1 class="contest-title">${esc(S.contest.title)}</h1>
      <p class="hint">Candidate speeches are on now. Voting opens on this page straight after.</p>
      <ul class="speech-list">
        ${sortedCandidates(S.contest).map(k => `
          <li class="${k.id === speaker ? "is-speaking" : ""}">${esc(k.name)}${k.id === speaker ? `<span class="badge badge-open">Speaking</span>` : ""}</li>`).join("")}
      </ul>
      ${codeChip()}
    </section>`);
}

function screenResult() {
  const c = S.contest;
  const winner = sortedCandidates(c).find(k => k.id === c.winner);
  if (winner) {
    show(`
      <section class="screen center">
        <p class="eyebrow">${esc(c.title)} · Elected</p>
        <p class="congrats-line">Congratulations</p>
        <h1 class="congrats-name">${esc(winner.name)}</h1>
        <p class="hint">${S.myVote ? "Your vote was counted. " : ""}The next position will appear here when it's called.</p>
        ${codeChip()}
      </section>`);
    if (S.celebrated !== watching) { S.celebrated = watching; confetti({ count: 90 }); }
    return;
  }
  screenWait(c.winner === "tie" ? `It's a tie for ${c.title}` : `Voting for ${c.title} has closed`,
    c.winner === "tie" ? "The exec will explain what happens next. Keep this page open." : "The next position will appear here when it's called.");
}

function show(html) { app.innerHTML = html; }

function screenCode() {
  show(`
    <section class="screen center">
      <img class="lion lion-lg" src="../logo.png" alt="" width="128" height="128">
      <p class="eyebrow">Annual General Meeting</p>
      <h1>Enter your code</h1>
      <p class="hint">It's on the slip you were given at the door.</p>
      <form class="code-form" id="codeForm" novalidate>
        <input class="code-input" id="code" value="${esc(S.draft)}" placeholder="ABC-234" maxlength="7"
          autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false"
          aria-label="Voting code" aria-describedby="codeErr">
        <p class="error" id="codeErr" role="alert">${esc(S.error)}</p>
        <button class="btn btn-primary btn-block btn-lg" ${S.busy ? "disabled" : ""}>${S.busy ? "Checking…" : "Check in"}</button>
      </form>
    </section>`);
  const input = app.querySelector("#code");
  input.addEventListener("input", () => {
    const pos = input.selectionStart === input.value.length;
    input.value = formatCode(normalizeCode(input.value).slice(0, 6));
    if (pos) input.setSelectionRange(input.value.length, input.value.length);
    S.draft = input.value;
  });
  app.querySelector("#codeForm").addEventListener("submit", e => { e.preventDefault(); if (!S.busy) checkIn(); });
  if (!S.busy) input.focus({ preventScroll: true });
}

function screenWait(title, body) {
  show(`
    <section class="screen center">
      <img class="lion lion-lg breathe" src="../logo.png" alt="" width="128" height="128">
      <h1>${esc(title)}</h1>
      <p class="hint">${esc(body)}</p>
      ${codeChip()}
    </section>`);
}

function screenDone() {
  show(`
    <section class="screen center">
      <div class="done-mark" aria-hidden="true">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>
      </div>
      <h1>Vote recorded</h1>
      <p class="hint">Your vote for <b>${esc(S.contest.title)}</b> is in. Stay on this page and the next position will appear when it's called.</p>
      ${codeChip()}
    </section>`);
}

function codeChip() {
  return `<p class="code-chip">Your code <b>${esc(formatCode(S.code))}</b></p>`;
}

function screenBallot() {
  const c = S.contest;
  const cands = sortedCandidates(c);
  if (S.selected && !cands.some(k => k.id === S.selected)) S.selected = null;
  const option = (id, name, cls = "") => `
    <button type="button" class="choice ${cls} ${S.selected === id ? "is-on" : ""}" role="radio"
      aria-checked="${S.selected === id}" data-id="${esc(id)}">
      <span class="dot"></span><span>${esc(name)}</span>
    </button>`;
  const chosenName = cands.find(k => k.id === S.selected)?.name;

  show(`
    <section class="screen">
      <p class="eyebrow"><span class="live-dot"></span>Now voting</p>
      <h1 class="contest-title">${esc(c.title)}</h1>
      <p class="hint">Choose one. You can't change your vote after you submit it.</p>
      <div class="choices" role="radiogroup" aria-label="${esc(c.title)}">
        ${cands.length ? cands.map(k => option(k.id, k.name)).join("") : `<p class="empty">Candidates are being added…</p>`}
      </div>
      <p class="error" role="alert">${esc(S.error)}</p>
      <div class="action-bar">
        <button class="btn btn-primary btn-block btn-lg" id="submit" ${S.selected ? "" : "disabled"}>Submit vote</button>
      </div>
    </section>
    ${S.confirming && chosenName ? `
    <div class="sheet-backdrop" id="backdrop">
      <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="confirmName">
        <p class="eyebrow">Confirm your vote · ${esc(c.title)}</p>
        <p class="sheet-name" id="confirmName">${esc(chosenName)}</p>
        <p class="hint">Once it's submitted it can't be changed.</p>
        <div class="sheet-actions">
          <button class="btn" id="back" ${S.busy ? "disabled" : ""}>Go back</button>
          <button class="btn btn-primary" id="confirm" ${S.busy ? "disabled" : ""}>${S.busy ? "Submitting…" : "Confirm vote"}</button>
        </div>
      </div>
    </div>` : ""}`);

  app.querySelectorAll(".choice").forEach(b => b.addEventListener("click", () => {
    S.selected = b.dataset.id; S.error = ""; render();
  }));
  app.querySelector("#submit").addEventListener("click", () => { if (S.selected) { S.confirming = true; render(); } });
  if (S.confirming) {
    app.querySelector("#back").addEventListener("click", () => { S.confirming = false; render(); });
    app.querySelector("#backdrop").addEventListener("click", e => { if (e.target.id === "backdrop" && !S.busy) { S.confirming = false; render(); } });
    app.querySelector("#confirm").addEventListener("click", () => { if (!S.busy) submitVote(); });
    app.querySelector("#confirm").focus({ preventScroll: true });
  }
}

function fatal(msg) {
  show(`
    <section class="screen center">
      <img class="lion lion-lg" src="../logo.png" alt="" width="128" height="128">
      <h1>Something's wrong</h1>
      <p class="hint">${esc(msg)}</p>
      <button class="btn btn-primary" onclick="location.reload()">Reload</button>
    </section>`);
}
