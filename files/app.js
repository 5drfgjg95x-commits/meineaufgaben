"use strict";

/* ============================== State ============================== */

const STORAGE_KEY = "trelloTodoConfig";
const OFFLINE_QUEUE_KEY = "offlineTaskQueue";

let config = loadConfig();
let tasks = [];

let editingCard = null;
let editingChecklistItems = [];
let detailCard = null;

let boardListsCache = null;
let modalOpen = false;

let syncTimer = null;
let loadInFlight = false;

/* ============================== Offline Storage ============================== */

let offlineQueue = JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY) || "[]");

function saveOfflineQueue() {
  localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(offlineQueue));
}

/* ============================== Config ============================== */

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
    if (v !== undefined) {
      url.searchParams.set(k, v);
    }
  });

  const res = await fetch(url.toString(), { method });

  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = await res.text();
    } catch (e) {}

    throw new Error(`Trello-Fehler (${res.status}): ${msg}`);
  }

  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function fetchCardsRaw() {
  const fields = "name,desc,due,idList,closed";

  if (config.listId) {
    return trello("GET", `/lists/${config.listId}/cards`, {
      checklists: "all",
      fields
    });
  }

  return trello("GET", `/boards/${config.boardId}/cards`, {
    checklists: "all",
    fields
  });
}

async function fetchBoardLists() {
  return trello("GET", `/boards/${config.boardId}/lists`, {
    fields: "name"
  });
}

/* ============================== Load ============================== */

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

    cards = cards.filter(c => !c.closed);

    if (config.archiveListId) {
      cards = cards.filter(c => c.idList !== config.archiveListId);
    }

    tasks = cards;

    showEmptyState(false);

    if (!modalOpen) {
      renderTaskSections();
    }
  } catch (err) {
    if (!silent) {
      toast(err.message || "Synchronisierung fehlgeschlagen");
    }
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

/* ============================== Sortierung ============================== */

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function categorize(card) {
  if (!card.due) return "none";

  const due0 = startOfDay(new Date(card.due));
  const today0 = startOfDay(new Date());

  const tomorrow0 = new Date(today0);
  tomorrow0.setDate(tomorrow0.getDate() + 1);

  if (due0 <= today0) return "today";
  if (due0.getTime() === tomorrow0.getTime()) return "tomorrow";

  return "future";
}

function isOverdue(card) {
  if (!card.due) return false;
  return startOfDay(new Date(card.due)) < startOfDay(new Date());
}

const SECTION_DEFS = [
  { key: "today", label: "Heute" },
  { key: "tomorrow", label: "Morgen" },
  { key: "future", label: "Demnächst" },
  { key: "none", label: "Ohne Datum" }
];

function renderTaskSections() {
  const buckets = {
    today: [],
    tomorrow: [],
    future: [],
    none: []
  };

  tasks.forEach(c => {
    buckets[categorize(c)].push(c);
  });

  Object.values(buckets).forEach(arr => {
    arr.sort((a, b) => {
      if (!a.due && !b.due) return a.name.localeCompare(b.name);
      if (!a.due) return 1;
      if (!b.due) return -1;
      return new Date(a.due) - new Date(b.due);
    });
  });

  const container = document.getElementById("taskSections");
  container.innerHTML = "";

  if (tasks.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="margin-top:8vh;">
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

    items.forEach(task => {
      card.appendChild(renderTaskRow(task));
    });

    section.appendChild(card);
    container.appendChild(section);
  });
}

function renderTaskRow(task) {
  const row = document.createElement("div");
  row.className = "task-row";

  const main = document.createElement("div");
  main.className = "task-row-main";

  const title = document.createElement("div");
  title.className = "task-row-title";
  title.textContent = task.name;
  main.appendChild(title);

  if (task.due) {
    const due = document.createElement("div");
    due.className = "task-row-due";
    due.textContent = formatDue(task.due);
    main.appendChild(due);
  }

  row.appendChild(main);

  row.addEventListener("click", () => {
    openDetail(task);
  });

  return row;
}

function formatDue(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  });
}

/* ============================== Create/Edit ============================== */

const formSheetOverlay = document.getElementById("formSheetOverlay");

function openSheet(overlay) {
  modalOpen = true;
  overlay.classList.remove("hidden");
}

function closeSheet(overlay) {
  overlay.classList.add("hidden");
}

async function ensureCreateListId() {
  if (config.listId) return config.listId;
  if (boardListsCache) return boardListsCache;

  const lists = await fetchBoardLists();
  const usable = lists.filter(l => l.id !== config.archiveListId);

  if (!usable.length) throw new Error("Keine Liste gefunden");

  boardListsCache = usable[0].id;
  return boardListsCache;
}

/* ============================== Offline Create ============================== */

async function createCard(data) {
  if (!navigator.onLine) {
    offlineQueue.push({
      id: crypto.randomUUID(),
      created: Date.now(),
      data
    });

    saveOfflineQueue();
    toast("Offline gespeichert ✓");
    return;
  }

  await sendCardToTrello(data);
}

async function sendCardToTrello({ title, desc, due, items, checklistOn }) {
  const idList = await ensureCreateListId();

  const card = await trello("POST", "/cards", {
    idList,
    name: title,
    desc: desc || "",
    due: due || ""
  });

  if (checklistOn && items.length) {
    const checklist = await trello("POST", "/checklists", {
      idCard: card.id,
      name: "Checkliste"
    });

    for (const item of items) {
      await trello("POST", `/checklists/${checklist.id}/checkItems`, {
        name: item.name
      });
    }
  }
}

document.getElementById("formSave").addEventListener("click", saveForm);

async function saveForm() {
  const title = document.getElementById("fieldTitle").value.trim();

  if (!title) {
    toast("Bitte einen Titel eingeben");
    return;
  }

  const desc = document.getElementById("fieldDesc").value;
  const dueValue = document.getElementById("fieldDue").value;

  const due = dueValue
    ? new Date(dueValue + "T00:00:00").toISOString()
    : null;

  const checklistOn = document.getElementById("fieldChecklistToggle").checked;

  const items = checklistOn
    ? editingChecklistItems.filter(i => i.name.trim())
    : [];

  try {
    await createCard({ title, desc, due, items, checklistOn });

    closeSheet(formSheetOverlay);
    await loadTasks();
  } catch (err) {
    toast(err.message || "Speichern fehlgeschlagen");
  }
}

/* ============================== Offline Sync ============================== */

async function syncOfflineTasks() {
  if (!navigator.onLine) return;
  if (offlineQueue.length === 0) return;

  toast("Synchronisiere Offline-Aufgaben...");

  const remaining = [];

  for (const item of offlineQueue) {
    try {
      await sendCardToTrello(item.data);
    } catch (err) {
      console.error("Offline Sync Fehler:", err);
      remaining.push(item);
    }
  }

  offlineQueue = remaining;
  saveOfflineQueue();

  if (remaining.length === 0) {
    toast("Synchronisation fertig ✓");
  } else {
    toast(`${remaining.length} Aufgabe(n) warten`);
  }

  loadTasks({ silent: true });
}

/* ============================== Settings ============================== */

function openSettings() {
  document.getElementById("settingApiKey").value = config.apiKey || "";
  document.getElementById("settingToken").value = config.token || "";
  document.getElementById("settingBoardId").value = config.boardId || "";
  document.getElementById("settingListId").value = config.listId || "";
  document.getElementById("settingArchiveListId").value = config.archiveListId || "";

  openSheet(document.getElementById("settingsOverlay"));
}

document.getElementById("settingsBtn").addEventListener("click", openSettings);
document.getElementById("emptyStateSettingsBtn").addEventListener("click", openSettings);

document.getElementById("settingsSaveBtn").addEventListener("click", async () => {
  config = {
    apiKey: document.getElementById("settingApiKey").value.trim(),
    token: document.getElementById("settingToken").value.trim(),
    boardId: document.getElementById("settingBoardId").value.trim(),
    listId: document.getElementById("settingListId").value.trim(),
    archiveListId: document.getElementById("settingArchiveListId").value.trim()
  };

  saveConfig();
  await loadTasks();
  toast("Gespeichert ✓");
});

/* ============================== Misc ============================== */

let toastTimer = null;

function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.remove("hidden");

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.add("hidden");
  }, 2600);
}

document.getElementById("fab").addEventListener("click", () => {
  openSheet(formSheetOverlay);
});

function startSyncLoop() {
  if (syncTimer) clearInterval(syncTimer);

  syncTimer = setInterval(() => {
    loadTasks({ silent: true });
  }, 60000);
}

/* ============================== PWA ============================== */

window.addEventListener("load", () => {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(console.error);
  }

  if (navigator.onLine) {
    syncOfflineTasks();
  }
});

window.addEventListener("online", () => {
  syncOfflineTasks();
});

loadTasks();
startSyncLoop();
