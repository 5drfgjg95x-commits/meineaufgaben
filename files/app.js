"use strict";

/* ============================== State ============================== */

const STORAGE_KEY = "trelloTodoConfig";

let config = loadConfig();
let tasks = [];
let editingCard = null;       // card object currently being edited, or null = new
let editingChecklistItems = []; // [{id?, name, complete}] working copy in form
let detailCard = null;        // card currently shown in detail sheet
let boardListsCache = null;   // cached non-archive lists, for picking a default create-target
let modalOpen = false;
let syncTimer = null;
let loadInFlight = false;

function loadConfig() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch (e) {
    return {};
  }
}
function saveConfig() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}
function configComplete() {
  return !!(config.apiKey && config.token && config.boardId);
}

/* ============================== Trello API ============================== */

const TRELLO_BASE = "https://api.trello.com/1";

async function trello(method, path, params = {}) {
  const url = new URL(TRELLO_BASE + path);
  url.searchParams.set("key", config.apiKey);
  url.searchParams.set("token", config.token);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined) url.searchParams.set(k, v);
  });
  const res = await fetch(url.toString(), { method });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = await res.text(); } catch (e) {}
    throw new Error(`Trello-Fehler (${res.status}): ${msg}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function fetchCardsRaw() {
  const fields = "name,desc,due,idList,closed";
  if (config.listId) {
    return trello("GET", `/lists/${config.listId}/cards`, { checklists: "all", fields });
  }
  return trello("GET", `/boards/${config.boardId}/cards`, { checklists: "all", fields });
}

async function fetchBoardLists() {
  return trello("GET", `/boards/${config.boardId}/lists`, { fields: "name" });
}

/* ============================== Load & render ============================== */

async function loadTasks({ silent = false } = {}) {
  if (!configComplete()) {
    showEmptyState(true);
    return;
  }
  if (loadInFlight) return;
  loadInFlight = true;
  setSyncDot(true);
  try {
    let cards = await fetchCardsRaw();
    cards = cards.filter((c) => !c.closed);
    if (config.archiveListId) {
      cards = cards.filter((c) => c.idList !== config.archiveListId);
    }
    tasks = cards;
    showEmptyState(false);
    if (!modalOpen) renderTaskSections();
    if (detailCard) {
      const fresh = tasks.find((c) => c.id === detailCard.id);
      if (fresh) {
        detailCard = fresh;
        if (!document.getElementById("detailSheetOverlay").classList.contains("hidden")) {
          renderDetail(fresh);
        }
      }
    }
  } catch (err) {
    if (!silent) toast(err.message || "Synchronisierung fehlgeschlagen");
  } finally {
    loadInFlight = false;
    setSyncDot(false);
  }
}

function showEmptyState(show) {
  document.getElementById("emptyState").classList.toggle("hidden", !show);
  document.getElementById("taskSections").classList.toggle("hidden", show);
  document.getElementById("fab").classList.toggle("hidden", show);
}

function setSyncDot(active) {
  document.getElementById("syncDot").classList.toggle("active", active);
}

/* ---- categorize & sort ---- */

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function categorize(card) {
  if (!card.due) return "none";
  const due0 = startOfDay(new Date(card.due));
  const today0 = startOfDay(new Date());
  const tomorrow0 = new Date(today0); tomorrow0.setDate(tomorrow0.getDate() + 1);
  if (due0.getTime() <= today0.getTime()) return "today"; // includes overdue tasks
  if (due0.getTime() === tomorrow0.getTime()) return "tomorrow";
  return "future";
}

function isOverdue(card) {
  if (!card.due) return false;
  return startOfDay(new Date(card.due)).getTime() < startOfDay(new Date()).getTime();
}

const SECTION_DEFS = [
  { key: "today", label: "Heute" },
  { key: "tomorrow", label: "Morgen" },
  { key: "future", label: "Demnächst" },
  { key: "none", label: "Ohne Datum" },
];

function renderTaskSections() {
  const buckets = { today: [], tomorrow: [], future: [], none: [] };
  tasks.forEach((c) => buckets[categorize(c)].push(c));
  Object.values(buckets).forEach((arr) =>
    arr.sort((a, b) => {
      if (!a.due && !b.due) return a.name.localeCompare(b.name);
      if (!a.due) return 1;
      if (!b.due) return -1;
      return new Date(a.due) - new Date(b.due);
    })
  );

  const container = document.getElementById("taskSections");
  container.innerHTML = "";

  if (tasks.length === 0) {
    container.innerHTML = `<div class="empty-state" style="margin-top:8vh;">
      <div class="empty-icon">✅</div>
      <p class="empty-title">Alles erledigt</p>
      <p class="empty-text">Du hast aktuell keine offenen Aufgaben.</p>
    </div>`;
    return;
  }

  SECTION_DEFS.forEach(({ key, label }) => {
    const items = buckets[key];
    if (!items.length) return;
    const section = document.createElement("section");
    const title = document.createElement("h2");
    title.className = `section-title ${key}`;
    title.textContent = `${label} (${items.length})`;
    section.appendChild(title);

    const card = document.createElement("div");
    card.className = "section-card";
    items.forEach((task, i) => card.appendChild(renderTaskRow(task, key, i)));
    section.appendChild(card);
    container.appendChild(section);
  });
}

function renderTaskRow(task, sectionKey, index) {
  const row = document.createElement("div");
  row.className = "task-row";
  row.style.animationDelay = `${index * 30}ms`;

  const main = document.createElement("div");
  main.className = "task-row-main";

  const title = document.createElement("div");
  title.className = "task-row-title";
  title.textContent = task.name;
  main.appendChild(title);

  if (task.due) {
    const due = document.createElement("div");
    const overdue = isOverdue(task);
    due.className = `task-row-due ${overdue ? "overdue" : ""} ${!overdue && sectionKey === "today" ? "today" : ""}`;
    due.textContent = formatDue(task.due);
    main.appendChild(due);
  }

  const checklists = task.checklists || [];
  const totalItems = checklists.reduce((s, cl) => s + cl.checkItems.length, 0);
  if (totalItems > 0) {
    const done = checklists.reduce((s, cl) => s + cl.checkItems.filter((i) => i.state === "complete").length, 0);
    const badge = document.createElement("div");
    badge.className = "task-row-checklist-badge";
    badge.textContent = `☑︎ ${done}/${totalItems}`;
    main.appendChild(badge);
  }

  row.appendChild(main);

  const pencil = document.createElement("button");
  pencil.className = "edit-pencil";
  pencil.setAttribute("aria-label", "Bearbeiten");
  pencil.innerHTML = `<svg viewBox="0 0 24 24" width="17" height="17"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>`;
  pencil.addEventListener("click", (e) => {
    e.stopPropagation();
    openEditForm(task);
  });
  row.appendChild(pencil);

  row.addEventListener("click", () => openDetail(task));
  return row;
}

function formatDue(iso) {
  const d = new Date(iso);
  const today0 = startOfDay(new Date());
  const tomorrow0 = new Date(today0); tomorrow0.setDate(tomorrow0.getDate() + 1);
  const dDay0 = startOfDay(d);

  if (dDay0.getTime() === today0.getTime()) return "Heute";
  if (dDay0.getTime() === tomorrow0.getTime()) return "Morgen";
  return d.toLocaleDateString("de-DE", { day: "2-digit", month: "short", year: dDay0.getFullYear() !== today0.getFullYear() ? "numeric" : undefined });
}

/* ============================== New / Edit Sheet ============================== */

const formSheetOverlay = document.getElementById("formSheetOverlay");
const detailSheetOverlay = document.getElementById("detailSheetOverlay");
const settingsOverlay = document.getElementById("settingsOverlay");

function openSheet(overlay) {
  modalOpen = true;
  overlay.classList.remove("hidden");
}
function closeSheet(overlay) {
  overlay.classList.add("hidden");
  const anyOpen = [formSheetOverlay, detailSheetOverlay, settingsOverlay].some(
    (o) => !o.classList.contains("hidden")
  );
  if (!anyOpen) modalOpen = false;
}

function toLocalDateInputValue(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function openNewForm() {
  editingCard = null;
  editingChecklistItems = [];
  document.getElementById("formTitle").textContent = "Neue Aufgabe";
  document.getElementById("fieldTitle").value = "";
  document.getElementById("fieldDesc").value = "";
  document.getElementById("fieldDue").value = "";
  document.getElementById("fieldChecklistToggle").checked = false;
  document.getElementById("checklistEditor").classList.add("hidden");
  renderChecklistEditor();
  openSheet(formSheetOverlay);
  setTimeout(() => document.getElementById("fieldTitle").focus(), 280);
}

function openEditForm(card) {
  editingCard = card;
  const checklist = (card.checklists || [])[0];
  editingChecklistItems = checklist
    ? checklist.checkItems
        .slice()
        .sort((a, b) => a.pos - b.pos)
        .map((i) => ({ id: i.id, name: i.name, complete: i.state === "complete" }))
    : [];

  document.getElementById("formTitle").textContent = "Aufgabe bearbeiten";
  document.getElementById("fieldTitle").value = card.name || "";
  document.getElementById("fieldDesc").value = card.desc || "";
  document.getElementById("fieldDue").value = card.due ? toLocalDateInputValue(card.due) : "";
  document.getElementById("fieldChecklistToggle").checked = editingChecklistItems.length > 0;
  document.getElementById("checklistEditor").classList.toggle("hidden", editingChecklistItems.length === 0);
  renderChecklistEditor();
  closeSheet(detailSheetOverlay);
  openSheet(formSheetOverlay);
}

document.getElementById("fieldChecklistToggle").addEventListener("change", (e) => {
  document.getElementById("checklistEditor").classList.toggle("hidden", !e.target.checked);
  if (e.target.checked && editingChecklistItems.length === 0) {
    editingChecklistItems.push({ name: "", complete: false });
    renderChecklistEditor();
  }
});

document.getElementById("clearDueBtn").addEventListener("click", () => {
  document.getElementById("fieldDue").value = "";
});

document.getElementById("addChecklistItemBtn").addEventListener("click", () => {
  editingChecklistItems.push({ name: "", complete: false });
  renderChecklistEditor();
  const inputs = document.querySelectorAll("#checklistItemsEdit input");
  if (inputs.length) inputs[inputs.length - 1].focus();
});

function renderChecklistEditor() {
  const wrap = document.getElementById("checklistItemsEdit");
  wrap.innerHTML = "";
  editingChecklistItems.forEach((item, idx) => {
    const row = document.createElement("div");
    row.className = "checklist-item-edit-row";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Punkt";
    input.value = item.name;
    input.addEventListener("input", (e) => { editingChecklistItems[idx].name = e.target.value; });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "remove-item-btn";
    del.innerHTML = "&minus;";
    del.addEventListener("click", () => {
      editingChecklistItems.splice(idx, 1);
      renderChecklistEditor();
    });
    row.appendChild(input);
    row.appendChild(del);
    wrap.appendChild(row);
  });
}

document.getElementById("formCancel").addEventListener("click", () => closeSheet(formSheetOverlay));

document.getElementById("formSave").addEventListener("click", saveForm);

async function ensureCreateListId() {
  if (config.listId) return config.listId;
  if (boardListsCache) return boardListsCache;
  const lists = await fetchBoardLists();
  const usable = lists.filter((l) => l.id !== config.archiveListId);
  if (!usable.length) throw new Error("Keine passende Liste auf dem Board gefunden.");
  boardListsCache = usable[0].id;
  return boardListsCache;
}

async function saveForm() {
  const title = document.getElementById("fieldTitle").value.trim();
  if (!title) {
    toast("Bitte einen Titel eingeben");
    document.getElementById("fieldTitle").focus();
    return;
  }
  const desc = document.getElementById("fieldDesc").value;
  const dueVal = document.getElementById("fieldDue").value;
  const due = dueVal ? new Date(dueVal + "T00:00:00").toISOString() : null;
  const checklistOn = document.getElementById("fieldChecklistToggle").checked;
  const items = checklistOn ? editingChecklistItems.filter((i) => i.name.trim() !== "") : [];

  const saveBtn = document.getElementById("formSave");
  const original = saveBtn.textContent;
  saveBtn.innerHTML = '<span class="spinner"></span>';
  saveBtn.disabled = true;

  try {
    if (editingCard) {
      await updateCard(editingCard, { title, desc, due, items, checklistOn });
      toast("Aufgabe aktualisiert");
    } else {
      await createCard({ title, desc, due, items, checklistOn });
      toast("Aufgabe erstellt");
    }
    closeSheet(formSheetOverlay);
    await loadTasks();
  } catch (err) {
    toast(err.message || "Speichern fehlgeschlagen");
  } finally {
    saveBtn.textContent = original;
    saveBtn.disabled = false;
  }
}

async function createCard({ title, desc, due, items, checklistOn }) {
  const idList = await ensureCreateListId();
  const card = await trello("POST", "/cards", {
    idList,
    name: title,
    desc: desc || "",
    due: due || "",
  });
  if (checklistOn && items.length) {
    const checklist = await trello("POST", "/checklists", { idCard: card.id, name: "Checkliste" });
    for (const item of items) {
      await trello("POST", `/checklists/${checklist.id}/checkItems`, { name: item.name });
    }
  }
}

async function updateCard(card, { title, desc, due, items, checklistOn }) {
  const params = { name: title, desc: desc || "" };
  params.due = due || "null";
  await trello("PUT", `/cards/${card.id}`, params);

  const existingChecklist = (card.checklists || [])[0];

  if (!checklistOn) {
    if (existingChecklist) {
      await trello("DELETE", `/checklists/${existingChecklist.id}`);
    }
    return;
  }

  if (!existingChecklist) {
    if (items.length) {
      const checklist = await trello("POST", "/checklists", { idCard: card.id, name: "Checkliste" });
      for (const item of items) {
        await trello("POST", `/checklists/${checklist.id}/checkItems`, { name: item.name });
      }
    }
    return;
  }

  const existingById = new Map(existingChecklist.checkItems.map((i) => [i.id, i]));
  const keptIds = new Set(items.filter((i) => i.id).map((i) => i.id));

  // Deletions
  for (const old of existingChecklist.checkItems) {
    if (!keptIds.has(old.id)) {
      await trello("DELETE", `/checklists/${existingChecklist.id}/checkItems/${old.id}`);
    }
  }
  // Updates (renames) for existing items
  for (const item of items) {
    if (item.id && existingById.has(item.id) && existingById.get(item.id).name !== item.name) {
      await trello("PUT", `/cards/${card.id}/checkItem/${item.id}`, { name: item.name });
    }
  }
  // Additions
  for (const item of items) {
    if (!item.id) {
      await trello("POST", `/checklists/${existingChecklist.id}/checkItems`, { name: item.name });
    }
  }
}

/* ============================== Detail Sheet ============================== */

function openDetail(card) {
  detailCard = card;
  renderDetail(card);
  openSheet(detailSheetOverlay);
}

function renderDetail(card) {
  document.getElementById("detailTitle").textContent = card.name;
  document.getElementById("detailDesc").textContent = card.desc || "";

  const dueEl = document.getElementById("detailDue");
  dueEl.classList.remove("overdue", "today");
  if (card.due) {
    const overdue = isOverdue(card);
    if (overdue) dueEl.classList.add("overdue");
    else if (categorize(card) === "today") dueEl.classList.add("today");
    dueEl.textContent = "📅 " + formatDue(card.due);
    dueEl.classList.remove("hidden");
  } else {
    dueEl.textContent = "";
    dueEl.classList.add("hidden");
  }

  const checklist = (card.checklists || [])[0];
  const wrap = document.getElementById("detailChecklistWrap");
  if (checklist && checklist.checkItems.length) {
    wrap.classList.remove("hidden");
    const itemsSorted = checklist.checkItems.slice().sort((a, b) => a.pos - b.pos);
    const total = itemsSorted.length;
    const done = itemsSorted.filter((i) => i.state === "complete").length;
    document.getElementById("checklistProgressBar").style.width = `${total ? (done / total) * 100 : 0}%`;
    document.getElementById("checklistProgressLabel").textContent = `${done}/${total}`;

    const itemsContainer = document.getElementById("detailChecklistItems");
    itemsContainer.innerHTML = "";
    itemsSorted.forEach((item) => {
      const row = document.createElement("div");
      row.className = `check-item-row ${item.state === "complete" ? "checked" : ""}`;
      row.innerHTML = `
        <span class="check-circle"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z"/></svg></span>
        <span class="check-item-text"></span>`;
      row.querySelector(".check-item-text").textContent = item.name;
      row.addEventListener("click", () => toggleCheckItem(card, checklist.id, item, row));
      itemsContainer.appendChild(row);
    });
  } else {
    wrap.classList.add("hidden");
  }
}

async function toggleCheckItem(card, checklistId, item, row) {
  const newState = item.state === "complete" ? "incomplete" : "complete";
  row.classList.toggle("checked");
  item.state = newState; // optimistic
  try {
    await trello("PUT", `/cards/${card.id}/checkItem/${item.id}`, { state: newState });
    const total = card.checklists[0].checkItems.length;
    const done = card.checklists[0].checkItems.filter((i) => i.state === "complete").length;
    document.getElementById("checklistProgressBar").style.width = `${total ? (done / total) * 100 : 0}%`;
    document.getElementById("checklistProgressLabel").textContent = `${done}/${total}`;
    renderTaskSections();
  } catch (err) {
    row.classList.toggle("checked"); // revert
    item.state = newState === "complete" ? "incomplete" : "complete";
    toast(err.message || "Konnte nicht aktualisiert werden");
  }
}

document.getElementById("detailClose").addEventListener("click", () => closeSheet(detailSheetOverlay));
document.getElementById("detailEditBtn").addEventListener("click", () => {
  if (detailCard) openEditForm(detailCard);
});

document.getElementById("completeTaskBtn").addEventListener("click", async () => {
  if (!detailCard) return;
  if (!config.archiveListId) {
    toast("Bitte zuerst eine Archiv-Listen-ID in den Einstellungen hinterlegen");
    return;
  }
  const btn = document.getElementById("completeTaskBtn");
  btn.disabled = true;
  try {
    await trello("PUT", `/cards/${detailCard.id}`, { idList: config.archiveListId });
    toast("Aufgabe erledigt");
    closeSheet(detailSheetOverlay);
    await loadTasks();
  } catch (err) {
    toast(err.message || "Konnte nicht verschoben werden");
  } finally {
    btn.disabled = false;
  }
});

/* ============================== Settings ============================== */

function openSettings() {
  document.getElementById("settingApiKey").value = config.apiKey || "";
  document.getElementById("settingToken").value = config.token || "";
  document.getElementById("settingBoardId").value = config.boardId || "";
  document.getElementById("settingListId").value = config.listId || "";
  document.getElementById("settingArchiveListId").value = config.archiveListId || "";
  document.getElementById("settingsStatus").textContent = "";
  openSheet(settingsOverlay);
}

document.getElementById("settingsBtn").addEventListener("click", openSettings);
document.getElementById("emptyStateSettingsBtn").addEventListener("click", openSettings);
document.getElementById("settingsClose").addEventListener("click", () => closeSheet(settingsOverlay));

document.getElementById("settingsSaveBtn").addEventListener("click", async () => {
  config = {
    apiKey: document.getElementById("settingApiKey").value.trim(),
    token: document.getElementById("settingToken").value.trim(),
    boardId: document.getElementById("settingBoardId").value.trim(),
    listId: document.getElementById("settingListId").value.trim(),
    archiveListId: document.getElementById("settingArchiveListId").value.trim(),
  };
  saveConfig();
  boardListsCache = null;
  document.getElementById("settingsStatus").textContent = "Gespeichert ✓";
  await loadTasks();
  setTimeout(() => closeSheet(settingsOverlay), 500);
});

/* ============================== Misc ============================== */

document.getElementById("fab").addEventListener("click", openNewForm);

[formSheetOverlay, detailSheetOverlay, settingsOverlay].forEach((overlay) => {
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeSheet(overlay);
  });
});

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 2600);
}

/* ============================== Init ============================== */

function startSyncLoop() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = setInterval(() => loadTasks({ silent: true }), 60000);
}

window.addEventListener("load", () => {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
});

loadTasks();
startSyncLoop();
