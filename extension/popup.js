const residentSelect = document.getElementById("resident");
const fillButton = document.getElementById("fill");
const startButton = document.getElementById("start");
const stopButton = document.getElementById("stop");
const statusEl = document.getElementById("status");

let residents = [];
let nextResidentIndex = 0;
let autoRun = false;

function setStatus(message, kind) {
  statusEl.textContent = message;
  statusEl.className = kind || "";
}

function parseCsv(text) {
  const source = text.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && source[i + 1] === "\n") {
        i += 1;
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += ch;
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function columnIndex(headers, name, fallback) {
  const wanted = name.toLowerCase();
  const index = headers.findIndex((cell) => String(cell || "").trim().toLowerCase() === wanted);
  return index >= 0 ? index : fallback;
}

function cellAt(cells, index) {
  return String(index >= 0 ? cells[index] || "" : "").trim();
}

function parseResidents(text) {
  const table = parseCsv(text);
  const headers = table[0] || [];
  const lastIndex = columnIndex(headers, "Last Name", 0);
  const firstIndex = columnIndex(headers, "First Name", 1);
  const dateIndex = columnIndex(headers, "Date of Conversation", 2);
  const summaryIndex = columnIndex(headers, "Conversation", 3);
  const buildingIndex = columnIndex(headers, "Building", 4);
  const populationIndex = columnIndex(headers, "Student Population", 5);
  const themeIndex = columnIndex(headers, "Theme", 6);
  const rows = [];
  for (let i = 1; i < table.length; i += 1) {
    const cells = table[i];
    const last = cellAt(cells, lastIndex);
    const first = cellAt(cells, firstIndex);
    const date = cellAt(cells, dateIndex);
    const summary = cellAt(cells, summaryIndex);
    const building = cellAt(cells, buildingIndex);
    const population = cellAt(cells, populationIndex);
    const theme = cellAt(cells, themeIndex);
    if (!first || !last) {
      continue;
    }
    rows.push({
      index: rows.length,
      first,
      last,
      label: `${first} ${last}`,
      date,
      summary,
      building,
      population,
      theme,
    });
  }
  return rows;
}

function listFinished() {
  return residents.length === 0 || nextResidentIndex >= residents.length;
}

function nextStatusMessage() {
  if (!residents.length) {
    return "Resident list is empty.";
  }
  if (listFinished()) {
    return "Resident list finished. Pick someone to fill again.";
  }
  const person = residents[nextResidentIndex];
  return `Next: ${person.label} (${nextResidentIndex + 1} of ${residents.length})`;
}

function populateSelect() {
  const previous = residentSelect.value;
  residentSelect.innerHTML = "";
  residents.forEach((person) => {
    const option = document.createElement("option");
    option.value = String(person.index);
    option.textContent = person.label;
    residentSelect.appendChild(option);
  });
  if (!residents.length) {
    return;
  }
  if (previous && [...residentSelect.options].some((option) => option.value === previous) && autoRun) {
    residentSelect.value = previous;
    return;
  }
  if (listFinished()) {
    residentSelect.value = String(residents.length - 1);
  } else {
    residentSelect.value = String(nextResidentIndex);
  }
}

function selectedResident() {
  const index = Number(residentSelect.value);
  return residents[index] || null;
}

function updateRunButtons() {
  const empty = !residents.length;
  fillButton.disabled = empty || autoRun;
  startButton.disabled = empty || autoRun;
  stopButton.disabled = !autoRun;
  residentSelect.disabled = empty || autoRun;
}

function isFillableUrl(url) {
  if (!url) {
    return false;
  }
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "roompact.com" && parsed.pathname.startsWith("/forms")) {
      return true;
    }
    if (parsed.pathname.endsWith("form-fixture.html")) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
  }
}

async function activeFillableTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("No active tab.");
  }
  if (!isFillableUrl(tab.url)) {
    throw new Error("Open the Resident Conversation form on Roompact first.");
  }
  return tab;
}

async function advanceFromSelected(filledIndex) {
  nextResidentIndex = filledIndex + 1;
  await chrome.storage.local.set({ nextResidentIndex });
  populateSelect();
}

function applyStoredStatus(stored) {
  if (autoRun && stored.autoRunStatus) {
    setStatus(stored.autoRunStatus, stored.autoRunStatusKind || "");
    return;
  }
  if (!autoRun && stored.autoRunStatus && stored.autoRunStatusKind === "error") {
    setStatus(stored.autoRunStatus, "error");
    return;
  }
  setStatus(nextStatusMessage() + " Fill does not submit. Start will submit.", listFinished() ? "warn" : "");
}

async function refreshFromStorage() {
  const stored = await chrome.storage.local.get([
    "nextResidentIndex",
    "autoRun",
    "autoRunStatus",
    "autoRunStatusKind",
  ]);
  const storedIndex = Number(stored.nextResidentIndex);
  nextResidentIndex = Number.isInteger(storedIndex) && storedIndex >= 0 ? storedIndex : 0;
  autoRun = Boolean(stored.autoRun);
  populateSelect();
  updateRunButtons();
  applyStoredStatus(stored);
}

async function init() {
  try {
    const response = await fetch(chrome.runtime.getURL("resident-list.csv"));
    if (!response.ok) {
      throw new Error("Could not load resident-list.csv.");
    }
    residents = parseResidents(await response.text());
    await refreshFromStorage();
    if (!residents.length) {
      setStatus("Resident list is empty.", "error");
      updateRunButtons();
    }
  } catch (err) {
    setStatus(err.message || String(err), "error");
    fillButton.disabled = true;
    startButton.disabled = true;
  }
}

fillButton.addEventListener("click", async () => {
  const person = selectedResident();
  if (!person) {
    setStatus("Select a resident first.", "error");
    return;
  }

  setStatus("Filling…");
  fillButton.disabled = true;
  startButton.disabled = true;

  try {
    const tab = await activeFillableTab();
    await ensureContentScript(tab.id);

    const result = await chrome.tabs.sendMessage(tab.id, {
      type: "FILL",
      resident: {
        first: person.first,
        last: person.last,
        date: person.date,
        summary: person.summary,
        building: person.building,
        population: person.population,
        theme: person.theme,
      },
    });

    if (!result) {
      setStatus("No response from the page. Reload the form and try again.", "error");
      return;
    }
    if (result.ok) {
      await advanceFromSelected(person.index);
      const suffix = listFinished() ? " Resident list finished. Pick someone to fill again." : ` ${nextStatusMessage()}`;
      const body =
        result.message +
        (result.warnings?.length ? " " + result.warnings.join(" ") : "") +
        suffix +
        " Fill does not submit.";
      setStatus(body, result.warnings?.length ? "warn" : "ok");
      return;
    }
    setStatus(result.error || "Fill failed.", "error");
  } catch (err) {
    setStatus(err.message || String(err), "error");
  } finally {
    updateRunButtons();
  }
});

startButton.addEventListener("click", async () => {
  const person = selectedResident();
  if (!person) {
    setStatus("Select a resident first.", "error");
    return;
  }
  const queue = residents.filter((row) => row.index >= person.index);
  if (!queue.length) {
    setStatus("No residents left to file.", "error");
    return;
  }

  setStatus(`Starting… Filing ${queue.length} resident(s) beginning with ${person.label}.`, "");
  fillButton.disabled = true;
  startButton.disabled = true;

  try {
    const tab = await activeFillableTab();
    await chrome.storage.local.set({
      autoRun: true,
      autoRunQueue: queue,
      nextResidentIndex: person.index,
      autoRunStatus: `Starting ${person.label}.`,
      autoRunStatusKind: "",
    });
    autoRun = true;
    nextResidentIndex = person.index;
    populateSelect();
    updateRunButtons();
    await ensureContentScript(tab.id);

    const result = await chrome.tabs.sendMessage(tab.id, {
      type: "START_LOOP",
      queue,
      startIndex: person.index,
    });

    if (!result?.ok) {
      autoRun = false;
      await chrome.storage.local.set({ autoRun: false });
      updateRunButtons();
      setStatus(result?.error || "Could not start.", "error");
      return;
    }
    setStatus(
      `Started. Filing ${queue.length} resident(s) beginning with ${person.label}. Stay on the tab. Use Stop to abort.`,
      "ok"
    );
  } catch (err) {
    autoRun = false;
    await chrome.storage.local.set({ autoRun: false });
    updateRunButtons();
    setStatus(err.message || String(err), "error");
  }
});

stopButton.addEventListener("click", async () => {
  setStatus("Stop requested. The run will halt at the next checkpoint.", "warn");
  await chrome.storage.local.set({
    autoRun: false,
    autoRunStatus: "Stop requested. Halting at the next checkpoint.",
    autoRunStatusKind: "warn",
  });
  autoRun = false;
  updateRunButtons();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await chrome.tabs.sendMessage(tab.id, { type: "STOP" });
    }
  } catch {
    /* the storage flag is enough if the tab is mid-navigation */
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") {
    return;
  }
  if (changes.nextResidentIndex) {
    const storedIndex = Number(changes.nextResidentIndex.newValue);
    nextResidentIndex = Number.isInteger(storedIndex) && storedIndex >= 0 ? storedIndex : 0;
    populateSelect();
    updateRunButtons();
  }
  if (changes.autoRun) {
    autoRun = Boolean(changes.autoRun.newValue);
    updateRunButtons();
  }
  if (changes.autoRunStatus) {
    setStatus(changes.autoRunStatus.newValue || nextStatusMessage(), changes.autoRunStatusKind?.newValue || "");
  } else if (changes.autoRunStatusKind && statusEl.textContent) {
    statusEl.className = changes.autoRunStatusKind.newValue || "";
  }
});

residentSelect.addEventListener("change", () => {
  if (autoRun) {
    return;
  }
  const person = selectedResident();
  if (!person) {
    return;
  }
  const remaining = residents.length - person.index;
  setStatus(
    `Selected ${person.label} (${person.index + 1} of ${residents.length}). Fill does not submit. Start will file ${remaining} resident(s) from here.`,
    ""
  );
});

init();
