// Shared Firebase setup and helpers for the AGM voting pages.
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";
import {
  getAuth, connectAuthEmulator, onAuthStateChanged, signInAnonymously, signOut
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";
import {
  getDatabase, connectDatabaseEmulator, ref, get, set, update, remove, push, onValue
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-database.js";

// The apiKey is a public identifier, not a secret. What protects the data is
// database.rules.json, which must be published in the Firebase console.
const firebaseConfig = {
  apiKey: "AIzaSyCo9EeHleafX53S5XOhRRF81sPc2beNYZw",
  authDomain: "uqsla-98165.firebaseapp.com",
  databaseURL: "https://uqsla-98165-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "uqsla-98165",
  storageBucket: "uqsla-98165.firebasestorage.app",
  messagingSenderId: "471906650190",
  appId: "1:471906650190:web:a4c90f604f31a3b4f31b1f"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getDatabase(app);

// Local testing against the Firebase emulators: open any page with ?emulator on localhost.
export const EMULATOR = new URLSearchParams(location.search).has("emulator") &&
  ["localhost", "127.0.0.1"].includes(location.hostname);
if (EMULATOR) {
  connectAuthEmulator(auth, `http://${location.hostname}:9099`, { disableWarnings: true });
  connectDatabaseEmulator(db, location.hostname, 9000);
}

export { onAuthStateChanged, signInAnonymously, signOut, ref, get, set, update, remove, push, onValue };

// ---- Codes ----
// 6 characters from a 32-letter alphabet with no look-alikes (no I, O, 0 or 1).
// Keep CODE_RE in sync with the regex in database.rules.json.
export const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;
export const normalizeCode = s => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
export const formatCode = c => (c.length > 3 ? c.slice(0, 3) + "-" + c.slice(3) : c);
export function randomCode() {
  // 32 divides 256, so masking a random byte has no bias
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), b => ALPHABET[b & 31]).join("");
}

// ---- Small helpers ----
export const esc = s => String(s ?? "").replace(/[&<>"']/g, ch =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
export const count = obj => (obj ? Object.keys(obj).length : 0);
export const isPermissionDenied = e => /permission/i.test(String(e && (e.code || e.message)));

// Keep ?emulator on links between pages while testing locally
export const withParams = path => path + (EMULATOR ? "?emulator" : "");
// The attendee page, as a full URL (for QR codes) and as short display text
export const voteUrl = () => new URL(withParams("./"), location.href).href;
export const voteUrlText = () => (location.host + location.pathname.replace(/[^/]*$/, "")).replace(/\/$/, "");

const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0);
export const sortedContests = contests =>
  Object.entries(contests || {}).map(([id, c]) => ({ id, ...c })).sort(byOrder);
export const sortedCandidates = contest =>
  Object.entries(contest?.candidates || {}).map(([id, c]) => ({ id, ...c })).sort(byOrder);

// Vote counts for one position: candidates sorted by votes (ties keep ballot order)
export function tally(contest, votes) {
  const counts = {};
  for (const v of Object.values(votes || {})) counts[v] = (counts[v] || 0) + 1;
  const rows = sortedCandidates(contest).map(k => ({ id: k.id, name: k.name, n: counts[k.id] || 0 }));
  rows.sort((a, b) => b.n - a.n);
  const valid = rows.reduce((s, r) => s + r.n, 0);
  const max = rows.length ? rows[0].n : 0;
  const leaders = max > 0 ? rows.filter(r => r.n === max).map(r => r.id) : [];
  return { rows, valid, max, leaders, winner: leaders.length === 1 ? leaders[0] : null };
}

// ---- Motions (special resolutions): For / Against with a pass threshold ----
export const isMotion = c => c?.kind === "motion";
export const motionPoints = c => String(c?.description || "").split("\n").filter(Boolean);
export const pct = x => Math.round(x * 100) + "%";
export function motionResult(contest, votes) {
  let yes = 0, no = 0;
  for (const v of Object.values(votes || {})) { if (v === "for") yes++; else if (v === "against") no++; }
  const total = yes + no, threshold = contest?.threshold ?? 0.5;
  const share = total ? yes / total : 0;
  return { yes, no, total, share, threshold, passed: total > 0 && share > threshold };   // a tie fails
}

// ---- Access-code gate shared by the host and screen pages ----
// Execs unlock a page with a passphrase of 3+ words stored under hostKeys in the database
// (which no client can read). The rules check it on every request, so deleting it in the
// console locks out every browser that used it. Keep KEY_RE in sync with database.rules.json.
export const KEY_RE = /^[a-z0-9]+(-[a-z0-9]+)(-[a-z0-9]+)+$/;
// "Mango Anchor  velvet-tide" -> "mango-anchor-velvet-tide"
export const normalizeKey = s => String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join("-");

export function accessGate(mount, role, onReady) {
  let admitted = false;
  const admit = r => {
    admitted = true;
    mount.hidden = true;
    mount.innerHTML = "";
    onReady(r);
  };

  onAuthStateChanged(auth, async user => {
    if (admitted) return;
    if (!user) {
      signInAnonymously(auth).catch(e => showForm(e?.code === "auth/operation-not-allowed"
        ? "Anonymous sign-in isn't turned on in Firebase yet (Authentication → Sign-in method)."
        : "Couldn't connect. Check the internet connection and reload."));
      return;
    }
    // Already unlocked in this browser? Check the code still works before letting them in.
    const sessionRef = ref(db, `sessions/${user.uid}`);
    const session = await get(sessionRef).then(s => s.val()).catch(() => null);
    if (session && (session.role === "host" || role === "screen")) {
      const valid = await get(ref(db, "claims")).then(() => true).catch(() => false);
      if (valid) return admit(session.role);
      await remove(sessionRef).catch(() => {});
      return showForm("That access code has been turned off. Enter the current one.");
    }
    showForm();
  });

  function showForm(message = "") {
    mount.hidden = false;
    mount.innerHTML = `
      <div class="gate">
        <img class="lion" src="../logo.png" alt="" width="96" height="96">
        <p class="eyebrow">UQSLA AGM</p>
        <h1>${role === "host" ? "Host access" : "Screen access"}</h1>
        <p class="hint">${role === "host" ? "Enter the host code." : "Enter the screen code."}</p>
        <form id="gateForm" novalidate>
          <div class="cand-row">
            <input class="input key-input" id="gateKey" type="password" placeholder="e.g. three random words"
              autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" aria-label="Access code" aria-describedby="gateErr">
            <button type="button" class="btn btn-sm" id="gateShow">Show</button>
          </div>
          <p class="error" id="gateErr" role="alert">${esc(message)}</p>
          <button class="btn btn-primary btn-block">Unlock</button>
        </form>
      </div>`;
    const form = mount.querySelector("#gateForm");
    const input = mount.querySelector("#gateKey");
    const err = mount.querySelector("#gateErr");
    const btn = form.querySelector(".btn-primary");
    mount.querySelector("#gateShow").onclick = e => {
      const hidden = input.type === "password";
      input.type = hidden ? "text" : "password";
      e.target.textContent = hidden ? "Hide" : "Show";
    };
    input.focus({ preventScroll: true });

    form.onsubmit = async e => {
      e.preventDefault();
      const key = normalizeKey(input.value);
      if (!KEY_RE.test(key) || key.length < 12 || key.length > 64) { err.textContent = "Access codes are at least three words."; return; }
      if (!auth.currentUser) { err.textContent = "Still connecting. Try again in a moment."; return; }
      btn.disabled = true; btn.textContent = "Checking…"; err.textContent = "";
      // The rules only accept the session if the role matches the code, so try the roles this page allows
      const roles = role === "host" ? ["host"] : ["screen", "host"];
      for (const r of roles) {
        try {
          await set(ref(db, `sessions/${auth.currentUser.uid}`), { key, role: r });
          return admit(r);
        } catch (ex) {
          if (!isPermissionDenied(ex)) {
            err.textContent = "Couldn't reach Firebase. Check the internet connection.";
            btn.disabled = false; btn.textContent = "Unlock";
            return;
          }
        }
      }
      err.textContent = role === "host" ? "That isn't the host code." : "That code isn't valid.";
      btn.disabled = false; btn.textContent = "Unlock";
    };
  }
}

// Forget this browser's access and start over with a fresh anonymous user
export async function signOutAndReload() {
  const uid = auth.currentUser?.uid;
  if (uid) await remove(ref(db, `sessions/${uid}`)).catch(() => {});
  await signOut(auth).catch(() => {});
  location.reload();
}
