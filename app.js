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
authApi.onChange((user) => {
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
  renderEventsList();
  renderEventsListInChecklist();
  renderAttendance();
  renderRoster();
});

roster.subscribe((list) => {
  state.roster = list;
  $("roster-loading").style.display = "none";
  renderRoster();
  renderAttendance();
});

checkins.subscribe((list) => {
  state.checkins = list;
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
      '<div class="suggestion" style="font-style:italic; color:var(--true-gold); cursor:default;">No matches in roster</div>';
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
}

function deselectBrother() {
  selectedBrother = null;
  ciNameInput.value = "";
  ciNameInput.style.display = "block";
  ciSelected.classList.remove("visible");
  ciSubmit.disabled = true;
  ciNameInput.focus();
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
  const rows = state.checkins.filter(c => !filterId || c.eventId === filterId);

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
  </table>`;

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
    <div style="font-family: Georgia, serif; font-size: 14px; margin-bottom: 8px;">
      <strong style="color: var(--garnet);">${parsed.length}</strong> brothers found in file
    </div>
    <div style="font-family: Arial, sans-serif; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; line-height: 1.7;">
      <span style="color: var(--garnet);">+ ${newCount} new</span> &nbsp;·&nbsp;
      <span style="color: var(--true-gold);">~ ${updateCount} updates</span> &nbsp;·&nbsp;
      <span style="color: var(--burgundy);">${removedIfRep} would be removed if Replace All</span>
    </div>`;

  previewEl.innerHTML = parsed.slice(0, 50).map(b => {
    const isNew = !currentKeys.has(brotherKeyOf(b));
    return `<div style="padding:8px 12px; border-bottom:1px solid var(--light-gold); display:flex; justify-content:space-between; align-items:center; font-family:Georgia,serif; font-size:13px;">
      <span>${escapeHtml(b.firstName + " " + b.lastName)} &nbsp;<span style="font-family:Arial; font-size:9px; letter-spacing:1px; text-transform:uppercase; color:var(--true-gold);">${escapeHtml(b.status)}</span></span>
      <span style="font-family:Arial; font-size:9px; letter-spacing:1px; text-transform:uppercase; color:${isNew ? "var(--garnet)" : "var(--slate)"};">${isNew ? "NEW" : "EXISTING"}</span>
    </div>`;
  }).join("") + (parsed.length > 50
    ? `<div style="padding:8px 12px; font-family:Georgia,serif; font-style:italic; color:var(--true-gold); font-size:12px;">+ ${parsed.length - 50} more...</div>`
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
// QR CODE MODAL
// ===================================================================
const qrModal = $("qr-modal");

function renderQr(eventId) {
  $("qr-holder").innerHTML = "";
  const url = window.location.origin + window.location.pathname + "#event=" + eventId;
  new QRCode($("qr-holder"), {
    text: url, width: 240, height: 240,
    colorDark: "#79242F", colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel.M,
  });
  currentQrCanvas = $("qr-holder").querySelector("canvas") || $("qr-holder").querySelector("img");
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
// INIT
// ===================================================================
$("ev-date").valueAsDate = new Date();
const preselect = readHash();
if (preselect) activateTab("checkin");
