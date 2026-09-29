// ===================================================================
// PIKE Attendance — Main App
// ===================================================================

import { authApi, events, roster, checkins } from "./data.js";

// ---- App state (mirrors Firestore in memory for fast rendering) ----
const state = {
  events:   [],
  roster:   [],
  checkins: [],
  user:     null,
};

let selectedBrother = null;
let pendingImport   = null;
let currentQrEvent  = null;
let currentQrCanvas = null;

// ===================================================================
// UTILITIES
// ===================================================================
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch]);
}

function formatDate(d) {
  if (!d) return "TBD";
  const [y, m, day] = d.split("-");
  return `${m}/${day}/${y}`;
}

function brotherKeyOf(b) {
  return (b.firstName + "_" + b.lastName).toLowerCase().replace(/[^a-z0-9_]/g, "");
}

function toast(msg, isError) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.toggle("error", !!isError);
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2600);
}

const $ = (id) => document.getElementById(id);

// ===================================================================
// AUTH UI
// ===================================================================
// ===================================================================
// WELCOME BACK CARD (exec only). Last visit stored in this browser only.
// ===================================================================
let _welcome = null;
function toMs(v) {
  if (!v) return 0;
  if (typeof v === "number") return v;
  if (typeof v.toMillis === "function") return v.toMillis();
  const n = Date.parse(v); return isNaN(n) ? 0 : n;
}
function startWelcomeBack(email) {
  const key = "pike-attendance:lastSeen:" + String(email || "").toLowerCase();
  let since = null;
  try { const v = Number(localStorage.getItem(key)); if (v > 0) since = v; } catch (e) {}
  try { localStorage.setItem(key, String(Date.now())); } catch (e) {}
  _welcome = { since, dismissed: false };
}
function renderWelcomeBack() {
  const el = $("welcome-back");
  if (!el) return;
  if (!state.user || !_welcome || _welcome.dismissed) { el.dataset.html = ""; el.innerHTML = ""; return; }
  const since = _welcome.since;
  const isNew = t => since != null && toMs(t) > since;
  const items = [];
  const newCi = state.checkins.filter(c => isNew(c.timestamp));
  if (newCi.length) {
    const evs = new Set(newCi.map(c => c.eventId)).size;
    items.push({ num: newCi.length, label: "New check-in" + (newCi.length === 1 ? "" : "s"), detail: `across ${evs} event${evs === 1 ? "" : "s"}` });
  }
  const newEv = state.events.filter(e => isNew(e.createdAt));
  if (newEv.length) items.push({ num: newEv.length, label: "New event" + (newEv.length === 1 ? "" : "s"), detail: newEv.map(e => e.name).slice(0, 2).join(", ") });
  const today = new Date().toISOString().slice(0, 10);
  const next = state.events.filter(e => e.date && e.date >= today).sort((a, b) => a.date.localeCompare(b.date))[0];
  if (next) items.push({ num: next.date === today ? "Today" : formatDate(next.date).slice(0, 5), label: "Next event", detail: next.name });
  if (state.roster.length) items.push({ num: state.roster.length, label: "Brothers on roster", detail: "" });
  const _em = String(state.user.email || "").toLowerCase();
  const _me = state.roster.find(b => String(b.email || "").toLowerCase() === _em);
  const name = _me ? _me.firstName : _em.split("@")[0];
  const sub = since == null ? "Here's where things stand." :
    `Here's what's new since ${new Date(since).toLocaleDateString(undefined, { month: "short", day: "numeric" })}.`;
  const hasNews = newCi.length || newEv.length;
  const html = `
    <section class="welcome-card" aria-label="Welcome back">
      <button class="wb-close" type="button" aria-label="Dismiss" id="wb-close">&times;</button>
      <div class="wb-eyebrow">Iota Pi · Event Tracker</div>
      <div class="wb-title">${since == null ? "Hey" : "Welcome back"}, ${escapeHtml(name)}</div>
      <div class="wb-sub">${sub}</div>
      ${items.length ? `<div class="wb-grid">${items.map(i => `
        <div class="wb-item"><div class="wb-num">${escapeHtml(String(i.num))}</div>
        <div><div class="wb-label">${escapeHtml(i.label)}</div>${i.detail ? `<div class="wb-detail">${escapeHtml(i.detail)}</div>` : ""}</div></div>`).join("")}</div>` : ""}
      ${!hasNews && since != null ? `<div class="wb-caught">You're all caught up. No new check-ins since your last visit.</div>` : ""}
    </section>`;
  if (el.dataset.html === html) return;
  el.dataset.html = html;
  el.innerHTML = html;
  $("wb-close").addEventListener("click", () => { _welcome.dismissed = true; el.dataset.html = ""; el.innerHTML = ""; });
}
function safeWelcome() { try { renderWelcomeBack(); } catch (e) { console.warn("Welcome card skipped:", e); } }

authApi.onChange((user) => {
  if (user && !state.user) startWelcomeBack(user.email);
  if (!user) _welcome = null;
  state.user = user;
  $("auth-status").innerHTML = user
    ? `Signed in as <strong>${escapeHtml(user.email)}</strong>`
    : "Not signed in";
  $("auth-signin").style.display  = user ? "none" : "";
  $("auth-signout").style.display = user ? ""    : "none";
  document.body.classList.toggle("is-exec", !!user);
  // Re-render to show/hide exec-only controls (delete buttons, create event, etc.)
  renderEventsList();
  renderEventsListInChecklist();
  renderRoster();
  renderAttendance();
  safeWelcome();
});

$("auth-signin").addEventListener("click", async () => {
  try {
    await authApi.signIn();
    toast("Signed in");
  } catch (e) {
    console.error(e);
    toast("Sign-in failed", true);
  }
});

$("auth-signout").addEventListener("click", async () => {
  await authApi.signOut();
  toast("Signed out");
});

// ===================================================================
// REAL-TIME SUBSCRIPTIONS
// ===================================================================
events.subscribe((list) => {
  state.events = list;
  safeWelcome();
  setTimeout(safeGetStarted, 0);
  renderEventsList();
  renderEventsListInChecklist();
  renderAttendance();
  renderRoster();
});

roster.subscribe((list) => {
  state.roster = list;
  safeWelcome();
  $("roster-loading").style.display = "none";
  renderRoster();
  renderAttendance();
});

checkins.subscribe((list) => {
  state.checkins = list;
  safeWelcome();
  renderAttendance();
  renderRoster();
  renderEventsList();
});

// ===================================================================
// TABS
// ===================================================================
function activateTab(name) {
  document.querySelectorAll(".tab").forEach(t =>
    t.classList.toggle("active", t.dataset.tab === name)
  );
  document.querySelectorAll(".panel").forEach(p =>
    p.classList.toggle("active", p.id === "panel-" + name)
  );
}
document.querySelectorAll(".tab").forEach(t => {
  t.addEventListener("click", () => activateTab(t.dataset.tab));
});

// ===================================================================
// CHECK-IN: brother autocomplete
// ===================================================================
const ciNameInput     = $("ci-name");
const ciSuggestions   = $("ci-suggestions");
const ciSelected      = $("ci-selected");
const ciSelectedName  = $("ci-selected-name");
const ciSelectedStat  = $("ci-selected-status");
const ciClear         = $("ci-clear");
const ciSubmit        = $("ci-submit");

function renderSuggestions(query) {
  if (query.length < 2) {
    ciSuggestions.classList.remove("visible");
    return;
  }
  const q = query.toLowerCase();
  const matches = state.roster.filter(b => {
    const full = (b.firstName + " " + b.lastName).toLowerCase();
    return full.includes(q)
        || b.lastName.toLowerCase().startsWith(q)
        || b.firstName.toLowerCase().startsWith(q);
  }).slice(0, 8);

  if (!matches.length) {
    ciSuggestions.innerHTML =
      '<div class="suggestion" style="font-style:italic; color:var(--gold-ink); cursor:default;">No matches in roster</div>';
    ciSuggestions.classList.add("visible");
    return;
  }
  ciSuggestions.innerHTML = matches.map(b =>
    `<div class="suggestion" data-key="${b.key}">
       <span>${escapeHtml(b.firstName + " " + b.lastName)}</span>
       <span class="status-tag">${escapeHtml(b.status)}</span>
     </div>`
  ).join("");
  ciSuggestions.classList.add("visible");

  ciSuggestions.querySelectorAll("[data-key]").forEach(el => {
    el.addEventListener("click", () => {
      const b = state.roster.find(x => x.key === el.dataset.key);
      if (b) selectBrother(b);
    });
  });
}

function selectBrother(b) {
  selectedBrother = b;
  ciNameInput.value = b.firstName + " " + b.lastName;
  ciSelectedName.textContent = b.firstName + " " + b.lastName;
  ciSelectedStat.textContent = b.status + (b.email ? " • " + b.email : "");
  ciSelected.classList.add("visible");
  ciNameInput.style.display = "none";
  ciSuggestions.classList.remove("visible");
  ciClear.classList.remove("visible");
  ciSubmit.disabled = false;
  safeGetStarted();
}

function deselectBrother() {
  selectedBrother = null;
  ciNameInput.value = "";
  ciNameInput.style.display = "block";
  ciSelected.classList.remove("visible");
  ciSubmit.disabled = true;
  ciNameInput.focus();
  safeGetStarted();
}

ciNameInput.addEventListener("input", (e) => {
  ciClear.classList.toggle("visible", e.target.value.length > 0);
  renderSuggestions(e.target.value);
});
ciNameInput.addEventListener("focus", () => {
  if (ciNameInput.value.length >= 2) renderSuggestions(ciNameInput.value);
});
ciNameInput.addEventListener("blur", () =>
  setTimeout(() => ciSuggestions.classList.remove("visible"), 200)
);
ciClear.addEventListener("click", () => {
  ciNameInput.value = "";
  ciClear.classList.remove("visible");
  ciSuggestions.classList.remove("visible");
  ciNameInput.focus();
});
$("ci-deselect").addEventListener("click", deselectBrother);

// ===================================================================
// CHECK-IN: dropdown + submit
// ===================================================================
function renderEventsListInChecklist(preselectId) {
  const sel  = $("ci-event");
  const msg  = $("no-events-msg");
  const form = $("checkin-form");
  if (!state.events.length) {
    msg.style.display = "block";
    form.style.display = "none";
    return;
  }
  msg.style.display = "none";
  form.style.display = "block";
  sel.innerHTML = state.events.map(ev =>
    `<option value="${ev.id}">${escapeHtml(ev.name)} • ${formatDate(ev.date)} • ${escapeHtml(ev.type)}</option>`
  ).join("");
  if (preselectId && state.events.some(e => e.id === preselectId)) {
    sel.value = preselectId;
  }
}

ciSubmit.addEventListener("click", async () => {
  const eventId = $("ci-event").value;
  if (!eventId) return toast("Pick an event", true);
  if (!selectedBrother) return toast("Select your name from the roster", true);

  const dup = state.checkins.find(c =>
    c.eventId === eventId && c.brotherKey === selectedBrother.key
  );
  if (dup) return toast("You already checked in to this event", true);

  try {
    await checkins.create({
      eventId,
      brotherKey: selectedBrother.key,
      name:       selectedBrother.firstName + " " + selectedBrother.lastName,
      status:     selectedBrother.status,
      email:      selectedBrother.email,
    });
    _ciDone = true;
    deselectBrother();
    toast("Checked in — thanks, brother!");
  } catch (e) {
    console.error(e);
    toast("Could not save — check connection", true);
  }
});

// ===================================================================
// EVENTS PANEL
// ===================================================================
$("ev-create").addEventListener("click", async () => {
  if (!state.user) return toast("Sign in as exec to create events", true);

  const name     = $("ev-name").value.trim();
  const type     = $("ev-type").value;
  const date     = $("ev-date").value;
  const location = $("ev-location").value.trim();
  if (!name) return toast("Event name is required", true);
  if (!date) return toast("Event date is required", true);
  if (/chapter\s*meeting/i.test(name))
    return toast("Chapter meetings are not tracked here", true);

  try {
    await events.create({ name, type, date, location });
    $("ev-name").value     = "";
    $("ev-location").value = "";
    $("ev-date").valueAsDate = new Date();
    toast("Event created");
  } catch (e) {
    console.error(e);
    toast("Permission denied — are you signed in as exec?", true);
  }
});

function renderEventsList() {
  const list = $("event-list");
  if (!state.events.length) {
    list.innerHTML = '<div class="empty">No events yet — create one above.</div>';
    return;
  }
  list.innerHTML = state.events.map(ev => {
    const count = state.checkins.filter(c => c.eventId === ev.id).length;
    const canEdit = !!state.user;
    return `<div class="event-row">
      <div class="event-info">
        <div class="event-name">${escapeHtml(ev.name)}</div>
        <div class="event-meta">
          <span class="badge">${escapeHtml(ev.type)}</span>
          ${formatDate(ev.date)}${ev.location ? " • " + escapeHtml(ev.location) : ""}
        </div>
      </div>
      <div class="event-actions">
        <span class="count-pill">${count} ${count === 1 ? "check-in" : "check-ins"}</span>
        <button class="btn btn-ghost btn-small" data-qr="${ev.id}">QR</button>
        ${canEdit ? `<button class="btn btn-danger btn-small" data-del="${ev.id}">Delete</button>` : ""}
      </div>
    </div>`;
  }).join("");

  list.querySelectorAll("[data-del]").forEach(b =>
    b.addEventListener("click", () => deleteEvent(b.dataset.del))
  );
  list.querySelectorAll("[data-qr]").forEach(b =>
    b.addEventListener("click", () => openQrModal(b.dataset.qr))
  );
}

async function deleteEvent(id) {
  const ev = state.events.find(e => e.id === id);
  if (!ev) return;
  const cnt = state.checkins.filter(c => c.eventId === id).length;
  const msg = cnt > 0
    ? `Delete "${ev.name}" and its ${cnt} check-in${cnt === 1 ? "" : "s"}? This cannot be undone.`
    : `Delete "${ev.name}"?`;
  if (!confirm(msg)) return;
  try {
    await events.remove(id);
    toast("Event deleted");
  } catch (e) {
    console.error(e);
    toast("Permission denied", true);
  }
}

// ===================================================================
// ATTENDANCE PANEL
// ===================================================================
const ATT_PER_PAGE = 10;
let _attPage = 1, _attFilter = null;
function pagerPages(cur, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const out = [1];
  if (cur > 3) out.push("…");
  for (let n = Math.max(2, cur - 1); n <= Math.min(total - 1, cur + 1); n++) out.push(n);
  if (cur < total - 2) out.push("…");
  out.push(total);
  return out;
}
function renderAttendance() {
  $("stat-events").textContent   = state.events.length;
  $("stat-checkins").textContent = state.checkins.length;
  const uniq = new Set(state.checkins.map(c => c.brotherKey || c.name.toLowerCase()));
  $("stat-brothers").textContent = uniq.size;
  const pct = state.roster.length ? Math.round((uniq.size / state.roster.length) * 100) : 0;
  $("stat-participation").textContent = pct + "%";

  const filterSel = $("filter-event");
  const current = filterSel.value;
  filterSel.innerHTML = '<option value="">All events</option>' +
    state.events.map(ev => `<option value="${ev.id}">${escapeHtml(ev.name)}</option>`).join("");
  filterSel.value = current;

  const filterId = filterSel.value;
  const allRows = state.checkins.filter(c => !filterId || c.eventId === filterId);
  // Pagination (10 per page); reset to page 1 when the filter changes
  if (_attFilter !== filterId) { _attFilter = filterId; _attPage = 1; }
  const totalPages = Math.max(1, Math.ceil(allRows.length / ATT_PER_PAGE));
  _attPage = Math.min(Math.max(1, _attPage), totalPages);
  const startIdx = (_attPage - 1) * ATT_PER_PAGE;
  const rows = allRows.slice(startIdx, startIdx + ATT_PER_PAGE);

  const wrap = $("attendance-table-wrap");
  if (!rows.length) {
    wrap.innerHTML = '<div class="empty">No check-ins yet.</div>';
    return;
  }
  const canEdit = !!state.user;
  wrap.innerHTML = `<table>
    <thead><tr>
      <th>Brother</th><th>Status</th><th>Event</th><th>Type</th><th>Checked In</th>
      ${canEdit ? "<th></th>" : ""}
    </tr></thead>
    <tbody>${rows.map(c => {
      const ev = state.events.find(e => e.id === c.eventId);
      return `<tr>
        <td>${escapeHtml(c.name)}</td>
        <td class="status-cell">${escapeHtml(c.status || "")}</td>
        <td>${ev ? escapeHtml(ev.name) : "<em>deleted</em>"}</td>
        <td>${ev ? escapeHtml(ev.type) : "—"}</td>
        <td>${new Date(c.timestamp).toLocaleString()}</td>
        ${canEdit ? `<td><button class="btn btn-danger btn-small" data-del-ci="${c.id}">×</button></td>` : ""}
      </tr>`;
    }).join("")}</tbody>
  </table>
  ${allRows.length > ATT_PER_PAGE ? `
  <div class="pager" role="navigation" aria-label="Attendance pages">
    <span class="pager-summary">${startIdx + 1} to ${Math.min(startIdx + ATT_PER_PAGE, allRows.length)} of ${allRows.length} check-ins</span>
    <span class="pager-controls">
      <button type="button" class="pager-btn" data-page="${_attPage - 1}" ${_attPage === 1 ? "disabled" : ""} aria-label="Previous page">&lsaquo; Prev</button>
      ${pagerPages(_attPage, totalPages).map(n => n === "…" ? `<span class="pager-gap">…</span>` :
        `<button type="button" class="pager-btn pager-num${n === _attPage ? " is-active" : ""}" data-page="${n}" ${n === _attPage ? 'aria-current="page"' : ""}>${n}</button>`).join("")}
      <button type="button" class="pager-btn" data-page="${_attPage + 1}" ${_attPage === totalPages ? "disabled" : ""} aria-label="Next page">Next &rsaquo;</button>
    </span>
  </div>` : ""}`;
  wrap.querySelectorAll(".pager-btn[data-page]").forEach(b =>
    b.addEventListener("click", () => { _attPage = Number(b.dataset.page); renderAttendance(); })
  );

  wrap.querySelectorAll("[data-del-ci]").forEach(b =>
    b.addEventListener("click", async () => {
      if (!confirm("Delete this check-in?")) return;
      try {
        await checkins.remove(b.dataset.delCi);
        toast("Check-in deleted");
      } catch (e) {
        toast("Permission denied", true);
      }
    })
  );
}

$("filter-event").addEventListener("change", renderAttendance);

// ===================================================================
// ROSTER PANEL
// ===================================================================
$("roster-search").addEventListener("input", renderRoster);
$("roster-sort").addEventListener("change", renderRoster);

function renderRoster() {
  const search   = $("roster-search").value.trim().toLowerCase();
  const sortMode = $("roster-sort").value;
  const grid     = $("roster-grid");

  const counts = {};
  state.checkins.forEach(c => {
    const key = c.brotherKey || c.name.toLowerCase();
    counts[key] = (counts[key] || 0) + 1;
  });

  const totalEvents = state.events.length || 1;
  const enriched = state.roster.map(b => ({
    ...b,
    count: counts[b.key] || 0,
    rate:  (counts[b.key] || 0) / totalEvents,
  }));

  let filtered = enriched.filter(b => {
    if (!search) return true;
    return (b.firstName + " " + b.lastName).toLowerCase().includes(search);
  });

  if      (sortMode === "count-desc") filtered.sort((a, b) => b.count - a.count || a.lastName.localeCompare(b.lastName));
  else if (sortMode === "count-asc")  filtered.sort((a, b) => a.count - b.count || a.lastName.localeCompare(b.lastName));
  else                                 filtered.sort((a, b) => a.lastName.localeCompare(b.lastName));

  $("roster-total").textContent = filtered.length;

  if (!state.roster.length) {
    grid.innerHTML = '<div class="empty" style="grid-column: span 2;">Roster is empty. Sign in as exec and use Add or Import to populate it.</div>';
    return;
  }
  if (!filtered.length) {
    grid.innerHTML = '<div class="empty" style="grid-column: span 2;">No brothers match that search.</div>';
    return;
  }

  const canEdit = !!state.user;
  grid.innerHTML = filtered.map(b => {
    const fullName = b.firstName + " " + b.lastName;
    const pct = state.events.length ? Math.round(b.rate * 100) : 0;
    const cls = b.count === 0 ? "zero" : (b.rate >= 0.5 ? "high" : "");
    return `<div class="roster-item ${cls}">
      <span class="roster-name">${escapeHtml(fullName)}</span>
      <div style="display:flex; align-items:center;">
        <div class="roster-bar-wrap">
          <span class="roster-count">${b.count} / ${state.events.length} • ${pct}%</span>
          <div class="roster-bar"><span style="width:${Math.min(100, pct)}%"></span></div>
        </div>
        ${canEdit ? `<button class="roster-delete" data-del-brother="${b.key}" title="Remove from roster">×</button>` : ""}
      </div>
    </div>`;
  }).join("");

  grid.querySelectorAll("[data-del-brother]").forEach(b =>
    b.addEventListener("click", () => deleteBrother(b.dataset.delBrother))
  );
}

async function deleteBrother(key) {
  const b = state.roster.find(x => x.key === key);
  if (!b) return;
  const cnt = state.checkins.filter(c => c.brotherKey === key).length;
  const msg = cnt > 0
    ? `Remove ${b.firstName} ${b.lastName} from the roster? Their ${cnt} check-in${cnt === 1 ? "" : "s"} will stay in the log for history.`
    : `Remove ${b.firstName} ${b.lastName} from the roster?`;
  if (!confirm(msg)) return;
  try {
    await roster.remove(key);
    toast("Brother removed");
  } catch (e) {
    toast("Permission denied", true);
  }
}

$("ab-add").addEventListener("click", async () => {
  if (!state.user) return toast("Sign in as exec to edit the roster", true);
  const first  = $("ab-first").value.trim();
  const last   = $("ab-last").value.trim();
  const status = $("ab-status").value;
  const email  = $("ab-email").value.trim();
  if (!first || !last) return toast("First and last name required", true);

  const key = brotherKeyOf({ firstName: first, lastName: last });
  if (state.roster.some(b => b.key === key))
    return toast("That brother is already in the roster", true);

  try {
    await roster.upsert({ firstName: first, lastName: last, status, email });
    $("ab-first").value = "";
    $("ab-last").value  = "";
    $("ab-email").value = "";
    $("ab-status").value = "New Member";
    toast("Brother added");
  } catch (e) {
    toast("Permission denied", true);
  }
});

["ab-first", "ab-last", "ab-email"].forEach(id =>
  $(id).addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); $("ab-add").click(); }
  })
);

// ===================================================================
// ROSTER IMPORT (CSV / Excel)
// ===================================================================
const importModal = $("import-modal");
const importFile  = $("import-file");

$("import-roster-btn").addEventListener("click", () => {
  if (!state.user) return toast("Sign in as exec to import a roster", true);
  importFile.value = "";
  importFile.click();
});

importFile.addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  if (typeof XLSX === "undefined") return toast("Spreadsheet library still loading", true);
  try {
    const buf = await file.arrayBuffer();
    const wb  = XLSX.read(new Uint8Array(buf), { type: "array" });
    const ws  = wb.Sheets[wb.SheetNames[0]];
    if (!ws) throw new Error("No worksheet");
    const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
    const parsed = rows.map(normalizeImportRow).filter(r => r);
    if (!parsed.length) return toast("No brothers found in that file", true);
    pendingImport = parsed;
    showImportPreview(parsed);
  } catch (err) {
    console.error(err);
    toast("Could not read that file", true);
  }
});

function normalizeImportRow(row) {
  const get = (...names) => {
    for (const wanted of names) {
      for (const k of Object.keys(row)) {
        if (k.replace(/\s+/g, "").toLowerCase() === wanted.replace(/\s+/g, "").toLowerCase()) {
          return String(row[k] == null ? "" : row[k]).trim();
        }
      }
    }
    return "";
  };
  let first = get("First Name", "firstname", "first", "fname", "given name");
  let last  = get("Last Name", "lastname", "last", "lname", "surname", "family name");
  if (!first && !last) {
    const fullName = get("Name", "Full Name", "fullname");
    if (fullName) {
      const parts = fullName.split(/\s+/);
      first = parts[0] || "";
      last  = parts.slice(1).join(" ") || "";
    }
  }
  if (!first || !last) return null;
  return {
    firstName: first,
    lastName:  last,
    status:    get("Status") || "Active",
    email:     get("Email", "E-mail", "Email Address"),
  };
}

function showImportPreview(parsed) {
  const summary    = $("import-summary");
  const previewEl  = $("import-preview");
  const importedKeys = new Set(parsed.map(brotherKeyOf));
  const currentKeys  = new Set(state.roster.map(b => b.key));
  const newCount     = parsed.filter(b => !currentKeys.has(brotherKeyOf(b))).length;
  const updateCount  = parsed.length - newCount;
  const removedIfRep = state.roster.filter(b => !importedKeys.has(b.key)).length;

  summary.innerHTML = `
    <div style="font-family: var(--font-body); font-size: 14px; margin-bottom: 8px;">
      <strong style="color: var(--garnet);">${parsed.length}</strong> brothers found in file
    </div>
    <div style="font-family: var(--font-ui); font-size: 11px; letter-spacing: 1px; text-transform: uppercase; line-height: 1.7;">
      <span style="color: var(--garnet);">+ ${newCount} new</span> &nbsp;·&nbsp;
      <span style="color: var(--gold-ink);">~ ${updateCount} updates</span> &nbsp;·&nbsp;
      <span style="color: var(--burgundy);">${removedIfRep} would be removed if Replace All</span>
    </div>`;

  previewEl.innerHTML = parsed.slice(0, 50).map(b => {
    const isNew = !currentKeys.has(brotherKeyOf(b));
    return `<div style="padding:8px 12px; border-bottom:1px solid var(--light-gold); display:flex; justify-content:space-between; align-items:center; font-family:var(--font-body); font-size:13px;">
      <span>${escapeHtml(b.firstName + " " + b.lastName)} &nbsp;<span style="font-family:var(--font-ui); font-size:9px; letter-spacing:1px; text-transform:uppercase; color:var(--gold-ink);">${escapeHtml(b.status)}</span></span>
      <span style="font-family:var(--font-ui); font-size:9px; letter-spacing:1px; text-transform:uppercase; color:${isNew ? "var(--garnet)" : "var(--slate)"};">${isNew ? "NEW" : "EXISTING"}</span>
    </div>`;
  }).join("") + (parsed.length > 50
    ? `<div style="padding:8px 12px; font-family:var(--font-body); font-style:italic; color:var(--gold-ink); font-size:12px;">+ ${parsed.length - 50} more...</div>`
    : "");

  importModal.classList.add("visible");
}

async function applyImport(mode) {
  if (!pendingImport) return;
  try {
    if (mode === "replace") await roster.bulkReplace(pendingImport);
    else                    await roster.bulkMerge(pendingImport);
    importModal.classList.remove("visible");
    pendingImport = null;
    toast(mode === "replace" ? "Roster replaced" : "Roster merged");
  } catch (e) {
    console.error(e);
    toast("Import failed — check permissions", true);
  }
}

$("import-merge").addEventListener("click",   () => applyImport("merge"));
$("import-replace").addEventListener("click", () => {
  if (confirm("Replace the entire roster? Brothers not in the file will be removed."))
    applyImport("replace");
});
$("import-cancel").addEventListener("click",      () => { pendingImport = null; importModal.classList.remove("visible"); });
$("import-modal-close").addEventListener("click", () => { pendingImport = null; importModal.classList.remove("visible"); });
importModal.addEventListener("click", (e) => {
  if (e.target === importModal) {
    pendingImport = null;
    importModal.classList.remove("visible");
  }
});

// ===================================================================
// EXPORTS (CSV + Excel)
// ===================================================================
$("export-csv").addEventListener("click", () => {
  if (!state.checkins.length) return toast("No check-ins to export", true);
  const headers = ["Brother", "Status", "Email", "Event", "Type", "Date", "Location", "Checked In"];
  const rows = state.checkins.map(c => {
    const ev = state.events.find(e => e.id === c.eventId) || {};
    return [
      c.name, c.status || "", c.email || "",
      ev.name || "", ev.type || "", ev.date || "", ev.location || "",
      new Date(c.timestamp).toISOString(),
    ];
  });
  const csv = [headers, ...rows]
    .map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(","))
    .join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = `pike-attendance-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  toast("CSV exported");
});

$("export-xlsx").addEventListener("click", () => {
  if (typeof XLSX === "undefined") return toast("Excel library still loading", true);
  if (!state.events.length && !state.checkins.length) return toast("Nothing to export yet", true);

  const wb = XLSX.utils.book_new();

  // Sheet 1: Check-Ins
  const ws1 = XLSX.utils.aoa_to_sheet([
    ["Brother", "Status", "Email", "Event", "Type", "Date", "Location", "Checked In"],
    ...state.checkins.map(c => {
      const ev = state.events.find(e => e.id === c.eventId) || {};
      return [c.name, c.status || "", c.email || "", ev.name || "", ev.type || "", ev.date || "", ev.location || "", new Date(c.timestamp).toLocaleString()];
    }),
  ]);
  ws1["!cols"] = [{wch:22},{wch:14},{wch:30},{wch:28},{wch:14},{wch:12},{wch:24},{wch:22}];
  XLSX.utils.book_append_sheet(wb, ws1, "Check-Ins");

  // Sheet 2: By Brother
  const counts = {};
  const evNames = {};
  state.checkins.forEach(c => {
    const k = c.brotherKey || c.name.toLowerCase();
    counts[k] = (counts[k] || 0) + 1;
    const ev = state.events.find(e => e.id === c.eventId);
    if (ev) (evNames[k] = evNames[k] || []).push(ev.name);
  });
  const totalEv = state.events.length;
  const brotherRows = state.roster.map(b => {
    const cnt  = counts[b.key] || 0;
    const rate = totalEv ? cnt / totalEv : 0;
    return [
      b.firstName + " " + b.lastName, b.status, b.email,
      cnt, totalEv, Math.round(rate * 100) + "%",
      (evNames[b.key] || []).join("; "),
    ];
  });
  brotherRows.sort((a, b) => b[3] - a[3] || String(a[0]).localeCompare(String(b[0])));
  const ws2 = XLSX.utils.aoa_to_sheet([
    ["Brother", "Status", "Email", "Events Attended", "Total Events", "Attendance Rate", "Event List"],
    ...brotherRows,
  ]);
  ws2["!cols"] = [{wch:24},{wch:14},{wch:30},{wch:18},{wch:14},{wch:18},{wch:60}];
  XLSX.utils.book_append_sheet(wb, ws2, "By Brother");

  // Sheet 3: By Event
  const evRows = state.events.map(ev => {
    const attendees = state.checkins.filter(c => c.eventId === ev.id).map(c => c.name);
    return [ev.name, ev.type, ev.date, ev.location || "", attendees.length, attendees.join("; ")];
  });
  const ws3 = XLSX.utils.aoa_to_sheet([
    ["Event", "Type", "Date", "Location", "Total Attendees", "Attendees"],
    ...evRows,
  ]);
  ws3["!cols"] = [{wch:30},{wch:18},{wch:12},{wch:24},{wch:18},{wch:80}];
  XLSX.utils.book_append_sheet(wb, ws3, "By Event");

  // Sheet 4: Summary
  const uniq = new Set(state.checkins.map(c => c.brotherKey || c.name.toLowerCase()));
  const ws4 = XLSX.utils.aoa_to_sheet([
    ["PIKE Chapter Attendance Report"],
    ["Generated", new Date().toLocaleString()],
    [],
    ["Total Events", totalEv],
    ["Total Check-Ins", state.checkins.length],
    ["Unique Brothers Checked In", uniq.size],
    ["Roster Size", state.roster.length],
    ["Roster Reached", state.roster.length ? Math.round((uniq.size / state.roster.length) * 100) + "%" : "0%"],
    ["Avg Check-Ins per Event", totalEv ? (state.checkins.length / totalEv).toFixed(1) : "0"],
  ]);
  ws4["!cols"] = [{wch:32},{wch:24}];
  XLSX.utils.book_append_sheet(wb, ws4, "Summary");

  XLSX.writeFile(wb, `pike-attendance-${new Date().toISOString().slice(0, 10)}.xlsx`);
  toast("Excel workbook exported");
});

// ===================================================================
// PIKE QR: one crisp code with a proper quiet zone, a printable poster
// for Download, and a full-screen Present mode for projecting.
// ===================================================================
let _qrPresentTimer = null;

// QR with a white quiet zone (scanners need it) and high error correction
function pikeQrCanvas(text, px) {
  const tmp = document.createElement("div");
  new QRCode(tmp, { text, width: px, height: px, colorDark: "#79242F", colorLight: "#ffffff", correctLevel: QRCode.CorrectLevel.H });
  const src = tmp.querySelector("canvas");
  const quiet = Math.round(px * 0.09);
  const c = document.createElement("canvas");
  c.width = c.height = px + quiet * 2;
  const g = c.getContext("2d");
  g.fillStyle = "#ffffff"; g.fillRect(0, 0, c.width, c.height);
  g.imageSmoothingEnabled = false;
  g.drawImage(src, quiet, quiet, px, px);
  return c;
}

function pikeRoundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

// Printable 1200x1650 poster: PIKE header, title, details, big QR, instructions
async function pikeQrPoster(url, title, meta, instruction) {
  try { await Promise.all([document.fonts.load('600 72px "Cormorant Garamond"'), document.fonts.load('600 30px "Gantari"'), document.fonts.load('500 30px "Gantari"')]); } catch (e) {}
  const W = 1200, H = 1650, c = document.createElement("canvas"); c.width = W; c.height = H;
  const g = c.getContext("2d");
  g.fillStyle = "#F6EFE1"; g.fillRect(0, 0, W, H);
  const hdr = g.createLinearGradient(0, 0, W, 220); hdr.addColorStop(0, "#79242F"); hdr.addColorStop(1, "#572A31");
  g.fillStyle = hdr; g.fillRect(0, 0, W, 220);
  g.textAlign = "center";
  g.fillStyle = "#AA9767"; g.font = '600 96px "Cormorant Garamond", Georgia, serif'; g.fillText("PIKE", W / 2, 118);
  g.fillStyle = "rgba(255,255,255,0.85)"; g.font = '600 26px "Gantari", Arial, sans-serif';
  g.fillText("I O T A   P I   ·   U C L A", W / 2, 172);
  let size = 78; g.font = `600 ${size}px "Cormorant Garamond", Georgia, serif`;
  while (g.measureText(title).width > W - 140 && size > 40) { size -= 4; g.font = `600 ${size}px "Cormorant Garamond", Georgia, serif`; }
  g.fillStyle = "#79242F"; g.fillText(title, W / 2, 330);
  g.fillStyle = "#323E48"; g.font = '500 32px "Gantari", Arial, sans-serif'; g.fillText(meta, W / 2, 390);
  g.save(); g.shadowColor = "rgba(87,42,49,0.18)"; g.shadowBlur = 40; g.shadowOffsetY = 14;
  pikeRoundRect(g, 170, 450, 860, 860, 48); g.fillStyle = "#ffffff"; g.fill(); g.restore();
  g.imageSmoothingEnabled = false; g.drawImage(pikeQrCanvas(url, 700), 200, 480, 800, 800);
  g.fillStyle = "#323E48"; g.font = '600 36px "Gantari", Arial, sans-serif'; g.fillText(instruction, W / 2, 1410);
  g.fillStyle = "#72633E"; g.font = '500 26px "Gantari", Arial, sans-serif'; g.fillText("Open your phone camera and point it at the code.", W / 2, 1462);
  g.fillStyle = "#AA9767"; g.font = '600 24px "Gantari", Arial, sans-serif'; g.fillText("C O U R A G E   T O   B E   M O R E", W / 2, 1570);
  return c;
}

// Draw the code into the modal (one canvas, no duplicates) and prep the poster
function pikeRenderQrModal(holder, url, title, meta, instruction) {
  holder.innerHTML = "";
  const code = pikeQrCanvas(url, 560);
  code.className = "pike-qr-code";
  code.setAttribute("role", "img");
  code.setAttribute("aria-label", "QR code for " + title);
  holder.appendChild(code);
  currentQrCanvas = code;                       // fallback until the poster is ready
  pikeQrPoster(url, title, meta, instruction).then(p => { currentQrCanvas = p; }).catch(() => {});
}

// Full-screen Present mode for projecting at chapter
function pikeQrPresent(url, title, meta, statusFn) {
  pikeQrClosePresent();
  const el = document.createElement("div");
  el.id = "qr-present"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "QR code, presentation mode");
  el.innerHTML = `
    <button class="qp-close" type="button" aria-label="Exit presentation">&times;</button>
    <div class="qp-brand">PIKE · Iota Pi</div>
    <div class="qp-title"></div>
    <div class="qp-meta"></div>
    <div class="qp-code"></div>
    <div class="qp-status"></div>
    <div class="qp-hint">Open your phone camera and point it at the code</div>`;
  el.querySelector(".qp-title").textContent = title;
  el.querySelector(".qp-meta").textContent = meta;
  el.querySelector(".qp-code").appendChild(pikeQrCanvas(url, 900));
  document.body.appendChild(el);
  const tick = () => { const s = statusFn ? statusFn() : ""; el.querySelector(".qp-status").textContent = s; el.querySelector(".qp-status").hidden = !s; };
  tick(); _qrPresentTimer = setInterval(tick, 15000);
  el.querySelector(".qp-close").addEventListener("click", pikeQrClosePresent);
  document.addEventListener("keydown", pikeQrEsc);
  try { if (el.requestFullscreen) el.requestFullscreen().catch(() => {}); } catch (e) {}
}
function pikeQrEsc(e) { if (e.key === "Escape") pikeQrClosePresent(); }
function pikeQrClosePresent() {
  const el = document.getElementById("qr-present");
  if (_qrPresentTimer) { clearInterval(_qrPresentTimer); _qrPresentTimer = null; }
  document.removeEventListener("keydown", pikeQrEsc);
  try { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); } catch (e) {}
  if (el) el.remove();
}

// ===================================================================
// QR CODE MODAL
// ===================================================================
const qrModal = $("qr-modal");

function renderQr(eventId) {
  const ev = state.events.find(e => e.id === eventId);
  const url = window.location.origin + window.location.pathname + "#event=" + eventId;
  const meta = ev ? [ev.type, formatDate(ev.date), ev.location].filter(Boolean).join(" · ") : "";
  pikeRenderQrModal($("qr-holder"), url, ev ? ev.name : "PIKE Event", meta, "Scan to check in");
}

function openQrModal(eventId) {
  const ev = state.events.find(e => e.id === eventId);
  if (!ev) return;
  currentQrEvent = ev;
  $("qr-event-name").textContent = ev.name;
  $("qr-event-meta").textContent = ev.type + " • " + formatDate(ev.date) + (ev.location ? " • " + ev.location : "");
  renderQr(eventId);
  qrModal.classList.add("visible");
}

$("qr-modal-close").addEventListener("click", () => qrModal.classList.remove("visible"));
qrModal.addEventListener("click", (e) => {
  if (e.target === qrModal) qrModal.classList.remove("visible");
});
$("qr-download").addEventListener("click", () => {
  if (!currentQrCanvas || !currentQrEvent) return;
  const a = document.createElement("a");
  a.href = currentQrCanvas.tagName === "CANVAS" ? currentQrCanvas.toDataURL("image/png") : currentQrCanvas.src;
  a.download = `pike-qr-${currentQrEvent.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`;
  a.click();
  toast("QR downloaded");
});
$("qr-present-btn").addEventListener("click", () => {
  if (!currentQrEvent) return;
  const ev = currentQrEvent;
  const url = window.location.origin + window.location.pathname + "#event=" + ev.id;
  pikeQrPresent(url, ev.name, [ev.type, formatDate(ev.date), ev.location].filter(Boolean).join(" · "), () => "Scan to check in");
});
$("qr-copy-url").addEventListener("click", async () => {
  if (!currentQrEvent) return;
  const url = window.location.origin + window.location.pathname + "#event=" + currentQrEvent.id;
  try { await navigator.clipboard.writeText(url); toast("URL copied"); }
  catch { toast("Copy failed — select manually", true); }
});

// ===================================================================
// URL HASH ROUTING (#event=ID auto-selects after QR scan)
// ===================================================================
function readHash() {
  const m = window.location.hash.match(/event=([\w-]+)/);
  return m ? m[1] : null;
}
window.addEventListener("hashchange", () => {
  const id = readHash();
  if (id) {
    renderEventsListInChecklist(id);
    activateTab("checkin");
  }
});

// ===================================================================
// NOW WIDGETS: live clock + Westwood weather (Open-Meteo, no API key)
// Self-contained. If the weather service is unreachable the weather
// card simply hides; nothing else on the page depends on it.
// ===================================================================
var _wx = null;   // latest weather payload (var: safe to read before init)
const NW_TZ = "America/Los_Angeles";
const NW_URL = "https://api.open-meteo.com/v1/forecast?latitude=34.0689&longitude=-118.4452" +
  "&current=temperature_2m,weather_code,is_day&daily=temperature_2m_max,temperature_2m_min" +
  "&hourly=temperature_2m,weather_code&temperature_unit=fahrenheit&timezone=America%2FLos_Angeles&forecast_days=16";

function wxDescribe(code, isDay) {
  const c = Number(code);
  if (c === 0) return { label: "Clear", kind: isDay ? "sun" : "moon" };
  if (c === 1) return { label: "Mostly clear", kind: isDay ? "sun" : "moon" };
  if (c === 2) return { label: "Partly cloudy", kind: isDay ? "sun-cloud" : "moon-cloud" };
  if (c === 3) return { label: "Overcast", kind: "cloud" };
  if (c === 45 || c === 48) return { label: "Fog", kind: "cloud" };
  if (c >= 51 && c <= 57) return { label: "Drizzle", kind: "rain" };
  if ((c >= 61 && c <= 67) || (c >= 80 && c <= 82)) return { label: "Rain", kind: "rain" };
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return { label: "Snow", kind: "rain" };
  if (c >= 95) return { label: "Thunderstorms", kind: "rain" };
  return { label: "—", kind: "cloud" };
}

function wxIcon(kind) {
  const sun  = `<span class="nw-sun"><span class="nw-sun-core"></span><span class="nw-sun-glow"></span></span>`;
  const moon = `<svg class="nw-moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>`;
  const cloud = cls => `<svg class="nw-cloud ${cls || ""}" viewBox="0 0 64 40" aria-hidden="true"><path d="M50 38H16a14 14 0 0 1-1.8-27.9A18 18 0 0 1 49 12a13 13 0 0 1 1 26z"/></svg>`;
  const drops = `<span class="nw-drops"><i></i><i></i><i></i></span>`;
  if (kind === "sun") return sun;
  if (kind === "moon") return moon;
  if (kind === "sun-cloud") return sun + cloud("is-front");
  if (kind === "moon-cloud") return moon + cloud("is-front");
  if (kind === "rain") return cloud("is-solo") + drops;
  return cloud("is-solo");
}

// Forecast for a specific local date + "HH:MM" (used by the Next Meeting card)
function wxForecastAt(dateStr, timeStr) {
  if (!_wx || !_wx.hourly || !dateStr) return null;
  const hr = String(timeStr || "19:00").slice(0, 2);
  const i = _wx.hourly.time.indexOf(`${dateStr}T${hr}:00`);
  if (i < 0) return null;
  const hour = Number(hr);
  return { temp: Math.round(_wx.hourly.temperature_2m[i]), ...wxDescribe(_wx.hourly.weather_code[i], hour >= 6 && hour < 18) };
}

function nwTick() {
  const el = document.getElementById("nw-time");
  if (!el) return;
  const now = new Date();
  const t = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: NW_TZ });
  const [clock, ampm] = t.split(" ");
  const h = Number(now.toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: NW_TZ }));
  const day = now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: NW_TZ });
  const night = h >= 18 || h < 6;
  el.querySelector(".nw-clock").textContent = clock;
  el.querySelector(".nw-ampm").textContent = ampm || "";
  el.querySelector(".nw-day").textContent = day;
  const ic = el.querySelector(".nw-time-icon");
  const want = night ? "moon" : "sun";
  if (ic.dataset.kind !== want) { ic.dataset.kind = want; ic.innerHTML = wxIcon(want); }
  el.classList.toggle("is-night", night);
}

function nwRenderWeather() {
  const card = document.getElementById("nw-weather");
  if (!card) return;
  if (!_wx || !_wx.current) { card.hidden = true; return; }
  const c = _wx.current;
  const d = wxDescribe(c.weather_code, c.is_day === 1);
  const hi = _wx.daily ? Math.round(_wx.daily.temperature_2m_max[0]) : null;
  const lo = _wx.daily ? Math.round(_wx.daily.temperature_2m_min[0]) : null;
  card.hidden = false;
  card.innerHTML = `
    <div class="nw-wx-art">${wxIcon(d.kind)}</div>
    <div class="nw-wx-head"><span class="nw-wx-place">Westwood</span><span class="nw-wx-sub">UCLA · Los Angeles</span></div>
    <div class="nw-wx-temp">${Math.round(c.temperature_2m)}<span>°F</span></div>
    <div class="nw-wx-meta">${hi != null ? `H ${hi}° · L ${lo}°` : ""}</div>
    <div class="nw-wx-pill">${escapeHtml(d.label)}</div>`;
}

async function nwFetchWeather() {
  try {
    const res = await fetch(NW_URL);
    if (!res.ok) throw new Error("HTTP " + res.status);
    _wx = await res.json();
  } catch (e) {
    console.warn("Weather unavailable:", e.message || e);
  }
  nwRenderWeather();
  if (typeof nwOnWeather === "function") { try { nwOnWeather(); } catch (e) {} }
}

function initNowWidgets() {
  const slot = document.getElementById("now-widgets");
  if (!slot) return;
  slot.innerHTML = `
    <div class="nw-row">
      <div class="nw-card nw-time" id="nw-time">
        <div class="nw-time-icon"></div>
        <div class="nw-label">Right now</div>
        <div><span class="nw-clock"></span><span class="nw-ampm"></span></div>
        <div class="nw-day"></div>
      </div>
      <div class="nw-card nw-weather" id="nw-weather" hidden></div>
    </div>`;
  nwTick();
  setInterval(nwTick, 15000);
  nwFetchWeather();
  setInterval(nwFetchWeather, 30 * 60 * 1000);
}

// ===================================================================
// GET STARTED GUIDE: step checklist with progress + troubleshooting
// ===================================================================
const GS_CHECK = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m8.5 12.5 2.3 2.3 4.7-5.1"/></svg>`;
const GS_OPEN  = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/></svg>`;

function pikeRenderGetStarted(el, cfg) {
  if (!el) return;
  const done = cfg.steps.filter(s => s.done).length;
  const total = cfg.steps.length;
  const pct = Math.round((done / total) * 100);
  const html = `
    <details class="gs-card" id="gs-details">
      <summary>
        <div class="gs-head">
          <span class="gs-eyebrow">${done === total ? "All set" : "Get started"}</span>
          <span class="gs-count">${done} of ${total} steps</span>
        </div>
        <div class="gs-title">${escapeHtml(cfg.title)}</div>
        <div class="gs-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></div>
      </summary>
      <ol class="gs-steps">
        ${cfg.steps.map(s => `
          <li class="${s.done ? "is-done" : ""}">
            <span class="gs-icon">${s.done ? GS_CHECK : GS_OPEN}</span>
            <span><span class="gs-label">${escapeHtml(s.label)}</span>
            ${s.detail ? `<span class="gs-detail">${escapeHtml(s.detail)}</span>` : ""}</span>
          </li>`).join("")}
      </ol>
      <div class="gs-help">
        <div class="gs-help-title">Having trouble?</div>
        <div class="gs-tips">
          ${cfg.tips.map(t => `<div class="gs-tip"><div class="gs-tip-q">${escapeHtml(t.q)}</div><div class="gs-tip-a">${escapeHtml(t.a)}</div></div>`).join("")}
        </div>
        <button class="btn btn-ghost btn-small gs-refresh" type="button">Refresh page</button>
      </div>
    </details>`;
  if (el.dataset.html === html) return;
  const prev = el.querySelector("#gs-details");
  const wasOpen = prev ? prev.open : null;
  el.dataset.html = html;
  el.innerHTML = html;
  const det = el.querySelector("#gs-details");
  det.open = wasOpen != null && el.dataset.touched === "1" ? wasOpen : !!cfg.startOpen;
  det.addEventListener("toggle", () => { el.dataset.touched = "1"; });
  el.querySelector(".gs-refresh").addEventListener("click", () => window.location.reload());
}

let _ciDone = false;
function renderGetStartedEvents() {
  const evSel = document.getElementById("ci-event");
  const hasEvent = state.events.length > 0 && !!(evSel && evSel.value);
  pikeRenderGetStarted($("get-started"), {
    title: "Checking in to an event",
    steps: [
      { label: "Choose the event", done: hasEvent,
        detail: hasEvent ? "" : (state.events.length ? "Pick it from the Select Event list below." : "No events yet. Expecting one? Refresh the page.") },
      { label: "Find your name", done: !!selectedBrother || _ciDone,
        detail: (selectedBrother || _ciDone) ? "" : "Type at least 2 letters of your first or last name, then tap it in the list." },
      { label: "Tap Check In", done: _ciDone,
        detail: _ciDone ? "" : "You'll see a confirmation. One check-in per event." },
    ],
    tips: [
      { q: "Don't see the event?", a: "Refresh the page. Events show up as soon as an exec creates them, but a tab left open can fall behind." },
      { q: "Your name isn't in the list?", a: "Try your last name. Still missing? Ask an exec to add you in the Roster tab." },
      { q: "Scanned a QR code?", a: "The event is picked for you. Just find your name and tap Check In." },
    ],
  });
}
function safeGetStarted() { try { renderGetStartedEvents(); } catch (e) { console.warn("Get Started skipped:", e); } }
// ===================================================================
// THEME SWITCHER: System / Light / Dark (saved per browser)
// ===================================================================
const THEME_ICONS = {
  system: `<svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>`,
  light:  `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>`,
  dark:   `<svg viewBox="0 0 24 24"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/><path d="M19 3v4M21 5h-4"/></svg>`,
};
const THEME_ORDER = ["system", "light", "dark"];
function themeGet() { try { return localStorage.getItem("pike-theme") || "system"; } catch (e) { return "system"; } }
function themeApply(pref) {
  const dark = pref === "dark" || (pref === "system" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
}
function initThemeSwitcher() {
  const bar = document.querySelector(".auth-bar");
  if (!bar || document.querySelector(".theme-switch")) return;
  const wrap = document.createElement("div");
  wrap.className = "theme-switch"; wrap.setAttribute("role", "radiogroup"); wrap.setAttribute("aria-label", "Color theme");
  wrap.innerHTML = `<span class="ts-pill" aria-hidden="true"></span>` + THEME_ORDER.map(v =>
    `<button type="button" role="radio" data-theme-value="${v}" aria-label="${v[0].toUpperCase() + v.slice(1)} theme" title="${v[0].toUpperCase() + v.slice(1)}">${THEME_ICONS[v]}</button>`).join("");
  bar.insertBefore(wrap, bar.firstChild);
  const sync = () => {
    const pref = themeGet();
    wrap.querySelectorAll("button").forEach(b => b.setAttribute("aria-checked", String(b.dataset.themeValue === pref)));
    wrap.querySelector(".ts-pill").style.transform = `translateX(${THEME_ORDER.indexOf(pref) * 34}px)`;
  };
  wrap.addEventListener("click", e => {
    const b = e.target.closest("button[data-theme-value]"); if (!b) return;
    try { localStorage.setItem("pike-theme", b.dataset.themeValue); } catch (err) {}
    themeApply(b.dataset.themeValue); sync();
  });
  wrap.addEventListener("keydown", e => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const i = THEME_ORDER.indexOf(themeGet()), n = (i + (e.key === "ArrowRight" ? 1 : 2)) % 3;
    wrap.querySelectorAll("button")[n].click(); wrap.querySelectorAll("button")[n].focus();
  });
  try { window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (themeGet() === "system") themeApply("system"); }); } catch (e) {}
  themeApply(themeGet()); sync();
}

// ===================================================================
// MOBILE DOCK: floating bottom navigation that mirrors the tab bar.
// Each dock button just clicks the matching .tab, so app logic is shared.
// ===================================================================
const DOCK_ICONS = {
  rollcall:   '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  checkin:    '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  meetings:   '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  events:     '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M8 14h.01M12 14h.01M16 14h.01"/>',
  absence:    '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M10 14l4 4M14 14l-4 4"/>',
  reports:    '<path d="M3 3v18h18"/><path d="M7 16v-4M12 16V8M17 16v-7"/>',
  attendance: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  roster:     '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  settings:   '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
};
const DOCK_SHORT = { absence: "Absences", rollcall: "Roll Call", checkin: "Check In" };
function initDock() {
  const tabs = [...document.querySelectorAll(".tabs .tab")];
  if (!tabs.length || document.getElementById("pike-dock")) return;
  const dock = document.createElement("nav");
  dock.id = "pike-dock"; dock.setAttribute("aria-label", "Sections");
  dock.innerHTML = tabs.map(t => {
    const k = t.dataset.tab;
    return `<button type="button" class="dock-item" data-dock="${k}" aria-label="${escapeHtml(t.textContent.trim())}">
      <span class="dock-icon"><svg viewBox="0 0 24 24" aria-hidden="true">${DOCK_ICONS[k] || DOCK_ICONS.meetings}</svg></span>
      <span class="dock-label">${escapeHtml(DOCK_SHORT[k] || t.textContent.trim())}</span></button>`;
  }).join("");
  document.body.appendChild(dock);
  dock.addEventListener("click", e => {
    const b = e.target.closest(".dock-item"); if (!b) return;
    const t = document.querySelector(`.tabs .tab[data-tab="${b.dataset.dock}"]`);
    if (t) { t.click(); window.scrollTo({ top: 0, behavior: "smooth" }); }
  });
  const sync = () => {
    tabs.forEach(t => {
      const b = dock.querySelector(`[data-dock="${t.dataset.tab}"]`); if (!b) return;
      b.classList.toggle("is-active", t.classList.contains("active"));
      b.setAttribute("aria-current", t.classList.contains("active") ? "page" : "false");
      b.hidden = getComputedStyle(t).display === "none";   // mirror role-hidden tabs
    });
  };
  new MutationObserver(sync).observe(document.querySelector(".tabs"), { subtree: true, attributes: true, attributeFilter: ["class", "style"] });
  new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  sync();
}

// ===================================================================
// INIT
// ===================================================================
$("ev-date").valueAsDate = new Date();
const preselect = readHash();
if (preselect) activateTab("checkin");

// Live clock + weather (never allowed to break the page)
try { initNowWidgets(); } catch (e) { console.warn("Now widgets skipped:", e); }

// Get Started guide
try { document.getElementById("ci-event").addEventListener("change", safeGetStarted); safeGetStarted(); } catch (e) {}

// Theme switcher
try { initThemeSwitcher(); } catch (e) { console.warn("Theme switcher skipped:", e); }

// Mobile dock
try { initDock(); } catch (e) { console.warn("Dock skipped:", e); }
