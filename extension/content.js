(() => {
  const FORM_HEADING = "Resident Conversation";
  const FORM_HASH = "/form/7jr4al";
  const RESIDENT_LABEL = "Resident Name";
  const BUILDING_LABEL = "Tag the Building";
  const POPULATION_LABEL = "Student Population";
  const DATE_LABEL = "Date of your conversation";
  const SUMMARY_LABEL = "Summary Notes";
  const THEME_LABEL = "What theme(s) arose in your conversation";
  const RESIDENT_TAG_ARIA = "Tag Residents";
  const BUILDING_TAG_ARIA = "Tag Buildings";
  const POPULATION_TAG_ARIA = "Tag Student Populations";
  const THEME_TAG_ARIA = "Tag Not Applicable or Wellness Dimensions";
  const SKIP_TAG_ARIA = /GT Office Referrals|Tag Staff/i;
  const SKIP_SUGGESTION = /^(searching\.?|no results found|choose one)$/i;
  const FORM_URL = "https://roompact.com/forms/#/form/7jr4al";
  const FORM_SETTLE_MS = 1500;
  const SUBMISSION_HASH = /^#\/submission\/[A-Za-z0-9_-]+/;
  const BANNER_ID = "rcf-autorun-banner";
  const BANNER_STYLE_ID = "rcf-autorun-styles";

  const memoryStore = {};
  let loopActive = false;
  let stopRequested = false;
  let lastStopPoll = 0;
  let bannerHideTimer = 0;

  function hasChromeStorage() {
    return typeof chrome !== "undefined" && Boolean(chrome.storage?.local);
  }

  async function storageGet(keys) {
    if (hasChromeStorage()) {
      return chrome.storage.local.get(keys);
    }
    const result = {};
    keys.forEach((key) => {
      result[key] = memoryStore[key];
    });
    return result;
  }

  async function storageSet(values) {
    Object.assign(memoryStore, values);
    if (hasChromeStorage()) {
      await chrome.storage.local.set(values);
    }
  }

  class StoppedError extends Error {
    constructor(message) {
      super(message || "Stopped.");
      this.name = "StoppedError";
      this.stopped = true;
    }
  }

  function isStoppedError(err) {
    return Boolean(err && (err.stopped || err.name === "StoppedError"));
  }

  async function assertNotStopped() {
    if (!loopActive) {
      return;
    }
    if (stopRequested) {
      throw new StoppedError();
    }
    const now = Date.now();
    if (now - lastStopPoll < 250) {
      return;
    }
    lastStopPoll = now;
    const stored = await storageGet(["autoRun"]);
    if (stored.autoRun === false) {
      stopRequested = true;
      throw new StoppedError();
    }
  }

  function rawSleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function sleep(ms, options) {
    const ignoreStop = Boolean(options?.ignoreStop);
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (!ignoreStop) {
        await assertNotStopped();
      }
      const left = ms - (Date.now() - start);
      if (left <= 0) {
        break;
      }
      await rawSleep(Math.min(50, left));
    }
  }

  async function waitFor(predicate, timeoutMs, intervalMs, options) {
    const timeout = timeoutMs ?? 4000;
    const interval = intervalMs ?? 50;
    const ignoreStop = Boolean(options?.ignoreStop);
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (!ignoreStop) {
        await assertNotStopped();
      }
      const value = await predicate();
      if (value) {
        return value;
      }
      await sleep(interval, options);
    }
    return null;
  }

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function conversationDateFromSheet(value) {
    const text = String(value || "").trim();
    const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
    if (!match) {
      return null;
    }
    const month = Number(match[1]);
    const day = Number(match[2]);
    const year = Number(match[3]);
    const utc = new Date(Date.UTC(year, month - 1, day));
    if (
      utc.getUTCFullYear() !== year ||
      utc.getUTCMonth() !== month - 1 ||
      utc.getUTCDate() !== day
    ) {
      return null;
    }
    return `${pad2(month)}/${pad2(day)}/${year}`;
  }

  function normalizeText(value) {
    return (value || "").replace(/\s+/g, " ").trim();
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function findFieldGroup(labelSnippet) {
    const labels = [...document.querySelectorAll(".forms-field-label-display")];
    const label = labels.find((el) => normalizeText(el.textContent).includes(labelSnippet));
    if (!label) {
      return null;
    }
    return (
      label.closest(".form-submission-field-group-body") ||
      label.closest(".forms-submission-field-group-body-margin-top")
    );
  }

  function nativeValueSetter(el) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    return Object.getOwnPropertyDescriptor(proto, "value")?.set;
  }

  function setNativeValue(el, value) {
    const setter = nativeValueSetter(el);
    if (setter) {
      setter.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    if (typeof InputEvent === "function") {
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          cancelable: true,
          data: value,
          inputType: "insertFromPaste",
        })
      );
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function elmClick(el) {
    const opts = { bubbles: true, cancelable: true, view: window, composed: true };
    el.dispatchEvent(new PointerEvent("pointerdown", opts));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new PointerEvent("pointerup", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
  }

  function keyCodeFor(key, keyCode) {
    if (typeof keyCode === "number") {
      return keyCode;
    }
    if (key === "Enter") {
      return 13;
    }
    if (key === "Escape") {
      return 27;
    }
    if (key === " ") {
      return 32;
    }
    return key.length === 1 ? key.charCodeAt(0) : 0;
  }

  function fireKey(el, type, key, keyCode) {
    const code =
      key === "Enter"
        ? "Enter"
        : key === "Escape"
          ? "Escape"
          : key === " "
            ? "Space"
            : key.length === 1
              ? "Key" + key.toUpperCase()
              : key;
    const which = keyCodeFor(key, keyCode);
    const event = new KeyboardEvent(type, {
      key,
      code,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    Object.defineProperty(event, "keyCode", { get: () => which });
    Object.defineProperty(event, "which", { get: () => which });
    el.dispatchEvent(event);
  }

  function setTagInputValue(el, value) {
    const setter = nativeValueSetter(el);
    if (setter) {
      setter.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function isDisplayed(el) {
    if (!el) {
      return false;
    }
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function tagTextMatches(raw, query) {
    const text = normalizeText(raw).toUpperCase();
    const q = normalizeText(query).toUpperCase();
    if (!text || !q || SKIP_SUGGESTION.test(text)) {
      return false;
    }
    if (text === q) {
      return true;
    }
    if (text.startsWith(q + " ") || text.startsWith(q + "-") || text.startsWith(q + "/") || text.startsWith(q + "(")) {
      return true;
    }
    if (text.includes("(" + q + ")") || text.includes(" - " + q) || text.endsWith(" " + q) || text.endsWith("-" + q)) {
      return true;
    }
    if (text.includes(q)) {
      return true;
    }
    return new RegExp("(^|[^A-Z0-9])" + escapeRegExp(q) + "([^A-Z0-9]|$)", "i").test(text);
  }

  function suggestionMatches(el, query) {
    return tagTextMatches(el.textContent, query);
  }

  function nameAppears(raw, name) {
    return tagTextMatches(raw, name);
  }

  function residentSuggestionMatches(el, first, last) {
    const text = el.textContent;
    return nameAppears(text, first) && nameAppears(text, last);
  }

  function findTagInput(group, expectedAria) {
    const inputs = [...group.querySelectorAll("input.forms-tag-search-input, input[aria-label^='Tag ']")];
    if (expectedAria) {
      const exact = inputs.find((el) => (el.getAttribute("aria-label") || "") === expectedAria);
      if (exact) {
        return exact;
      }
    }
    return (
      inputs.find((el) => {
        const label = el.getAttribute("aria-label") || el.getAttribute("placeholder") || "";
        return label && !SKIP_TAG_ARIA.test(label);
      }) ||
      inputs[0] ||
      null
    );
  }

  function activateTagInput(input) {
    elmClick(input);
    input.focus();
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
  }

  function searchIsBusy(group) {
    const spinner = group.querySelector(".forms-subscriptions-search-spinner");
    if (spinner && isDisplayed(spinner)) {
      return true;
    }
    return [...group.querySelectorAll(".forms-subscriptions-search-result-row")].some((el) =>
      /^searching\.?$/i.test(normalizeText(el.textContent))
    );
  }

  async function typeTagQuery(group, text, expectedAria) {
    const wanted = String(text);
    const missing = "Could not find the " + (expectedAria || "tag") + " input.";
    let input = findTagInput(group, expectedAria);
    if (!input) {
      throw new Error(missing);
    }
    activateTagInput(input);
    await sleep(80);
    input = findTagInput(group, expectedAria);
    setTagInputValue(input, "");
    await sleep(50);

    let current = "";
    for (const ch of wanted) {
      current += ch;
      input = findTagInput(group, expectedAria);
      if (!input) {
        throw new Error(missing);
      }
      if (document.activeElement !== input) {
        activateTagInput(input);
      }
      setTagInputValue(input, current);
      await sleep(13);
    }

    input = findTagInput(group, expectedAria);
    if (input && normalizeText(input.value).toUpperCase() !== wanted.toUpperCase()) {
      activateTagInput(input);
      setTagInputValue(input, wanted);
      await sleep(80);
    }
    return findTagInput(group, expectedAria);
  }

  function isSuggestionOpen(el) {
    if (!el || el.closest("[hidden]")) {
      return false;
    }
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }
    const parent = el.closest(".forms-subscriptions-search-result-container");
    if (parent) {
      const parentStyle = window.getComputedStyle(parent);
      if (parentStyle.display === "none" || parentStyle.visibility === "hidden") {
        return false;
      }
    }
    return true;
  }

  function findTagSuggestion(scope, query, matchEl) {
    const rows = [...scope.querySelectorAll(".forms-subscriptions-search-result-row")];
    const fallback = [...scope.querySelectorAll(".dropdown-item, [role='option']")];
    const items = (rows.length ? rows : fallback).filter((el) => {
      if (!isSuggestionOpen(el)) {
        return false;
      }
      const text = normalizeText(el.textContent);
      return text && !SKIP_SUGGESTION.test(text);
    });
    const matches = items.filter((el) => (matchEl ? matchEl(el) : suggestionMatches(el, query)));
    if (matchEl) {
      return matches[0] || null;
    }
    const q = query.toUpperCase();
    return (
      matches.find((el) => normalizeText(el.textContent).toUpperCase() === q) ||
      matches.find((el) => {
        const text = normalizeText(el.textContent).toUpperCase();
        return text.endsWith("(" + q + ")") || text.endsWith(" - " + q) || text.startsWith(q + " ");
      }) ||
      matches[0] ||
      null
    );
  }

  function selectedTagChips(container) {
    return [...container.querySelectorAll(".forms-submission-tag-item, .forms-tag-chip")].filter(
      (el) => !el.closest(".forms-subscriptions-search-result-row, .forms-subscriptions-search-result-container")
    );
  }

  function containerHasTag(container, name) {
    return selectedTagChips(container).some((el) => tagTextMatches(el.textContent, name));
  }

  function containerHasResident(container, first, last) {
    return selectedTagChips(container).some((el) => nameAppears(el.textContent, first) && nameAppears(el.textContent, last));
  }

  async function fillDate(dateValue) {
    const group = findFieldGroup(DATE_LABEL);
    const input =
      group?.querySelector("input.elm-datepicker--input") ||
      group?.querySelector('input[placeholder="mm/dd/yyyy"]');
    if (!input) {
      throw new Error("Could not find the conversation date field.");
    }
    const value = conversationDateFromSheet(dateValue);
    if (!value) {
      throw new Error("Conversation date must be mm/dd/yyyy.");
    }
    input.focus();
    setNativeValue(input, value);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
    input.blur();
    input.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    return value;
  }

  async function clickTagSuggestion(group, query, alreadySelected, matchEl) {
    const suggestion = findTagSuggestion(group, query, matchEl);
    if (!suggestion) {
      return false;
    }
    suggestion.scrollIntoView({ block: "nearest", inline: "nearest" });
    suggestion.focus();
    await sleep(40);
    fireKey(suggestion, "keydown", "Enter", 13);
    fireKey(suggestion, "keyup", "Enter", 13);
    if (await waitFor(alreadySelected, 700, 50)) {
      return true;
    }
    fireKey(suggestion, "keydown", " ", 32);
    fireKey(suggestion, "keyup", " ", 32);
    if (await waitFor(alreadySelected, 700, 50)) {
      return true;
    }
    if (typeof suggestion.click === "function") {
      suggestion.click();
    }
    elmClick(suggestion);
    return Boolean(await waitFor(alreadySelected, 1500, 50));
  }

  async function waitForTagSuggestion(group, query, matchEl) {
    return waitFor(() => {
      if (searchIsBusy(group)) {
        return null;
      }
      return findTagSuggestion(group, query, matchEl);
    }, 8000, 100);
  }

  async function fillOneTag(group, { query, expectedAria, alreadySelected, matchEl }) {
    if (alreadySelected()) {
      return true;
    }

    await typeTagQuery(group, query, expectedAria);
    let found = await waitForTagSuggestion(group, query, matchEl);
    if (!found) {
      await typeTagQuery(group, query, expectedAria);
      found = await waitForTagSuggestion(group, query, matchEl);
    }
    if (!found || !(await clickTagSuggestion(group, query, alreadySelected, matchEl))) {
      const input = findTagInput(group, expectedAria);
      if (input) {
        activateTagInput(input);
        setTagInputValue(input, "");
      }
      return false;
    }

    await waitFor(() => {
      const input = findTagInput(group, expectedAria);
      return Boolean(input && !normalizeText(input.value));
    }, 1500, 50);
    await sleep(220);
    return alreadySelected();
  }

  async function fillNamedTag(labelSnippet, tag, expectedAria) {
    const group = findFieldGroup(labelSnippet);
    if (!group) {
      throw new Error("Could not find the " + labelSnippet + " field.");
    }
    const input = findTagInput(group, expectedAria);
    if (!input) {
      throw new Error("Could not find the " + expectedAria + " input.");
    }
    if (SKIP_TAG_ARIA.test(input.getAttribute("aria-label") || "")) {
      throw new Error("Refusing to fill a follow-up/referral tag field.");
    }
    group.scrollIntoView({ block: "center", inline: "nearest" });
    const ok = await fillOneTag(group, {
      query: tag,
      expectedAria,
      alreadySelected: () => containerHasTag(group, tag),
    });
    return { added: ok ? [tag] : [], missing: ok ? [] : [tag] };
  }

  async function fillResidentTag(first, last) {
    const input = await waitFor(() => visibleResidentTagInput(), 8000, 100);
    if (!input) {
      if (!findFieldGroup(RESIDENT_LABEL)) {
        throw new Error("Could not find the resident name field.");
      }
      throw new Error("Could not find the Tag Residents input.");
    }
    const group = findFieldGroup(RESIDENT_LABEL);
    group.scrollIntoView({ block: "center", inline: "nearest" });
    const display = `${first} ${last}`;
    const ok = await fillOneTag(group, {
      query: last,
      expectedAria: RESIDENT_TAG_ARIA,
      alreadySelected: () => containerHasResident(group, first, last),
      matchEl: (el) => residentSuggestionMatches(el, first, last),
    });
    return { added: ok ? [display] : [], missing: ok ? [] : [display] };
  }

  async function fillSummary(summary) {
    const group = findFieldGroup(SUMMARY_LABEL);
    const textarea = [...(group?.querySelectorAll("textarea") || [])].find(
      (el) => !el.classList.contains("forms-ghost-textarea") && el.getAttribute("aria-label") !== "ghost textarea"
    );
    if (!textarea) {
      throw new Error("Could not find the summary notes field.");
    }
    textarea.focus();
    setNativeValue(textarea, summary);
    fireKey(textarea, "keyup", "Unidentified", 0);
    textarea.blur();
    textarea.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    return summary;
  }

  function isOnVisiblePage(el) {
    return Boolean(el && !el.closest("[hidden]") && isDisplayed(el));
  }

  function conversationFormVisible() {
    const residentGroup = findFieldGroup(RESIDENT_LABEL);
    const dateGroup = findFieldGroup(DATE_LABEL);
    return isOnVisiblePage(residentGroup) && isOnVisiblePage(dateGroup);
  }

  function visibleResidentTagInput() {
    const group = findFieldGroup(RESIDENT_LABEL);
    if (!group || !isOnVisiblePage(group)) {
      return null;
    }
    const input = findTagInput(group, RESIDENT_TAG_ARIA);
    if (!input || !isOnVisiblePage(input)) {
      return null;
    }
    return input;
  }

  function pageLooksLikeConversationForm() {
    if (conversationFormVisible()) {
      return true;
    }
    const heading = [...document.querySelectorAll("h1, h2")].some(
      (el) => isOnVisiblePage(el) && normalizeText(el.textContent).includes(FORM_HEADING)
    );
    const residentGroup = findFieldGroup(RESIDENT_LABEL);
    return heading && isOnVisiblePage(residentGroup);
  }

  async function fillResidentConversation(options) {
    const first = String(options?.resident?.first || "").trim();
    const last = String(options?.resident?.last || "").trim();
    const dateValue = String(options?.resident?.date || "").trim();
    const summary = String(options?.resident?.summary || "").trim();
    const buildingTag = String(options?.resident?.building || "").trim();
    const populationTag = String(options?.resident?.population || "").trim();
    const themeTag = String(options?.resident?.theme || "").trim();
    const warnings = [];

    if (!first || !last) {
      return { ok: false, error: "Resident first and last name are required." };
    }
    if (!dateValue) {
      return { ok: false, error: `${first} ${last} has an empty Date of Conversation column.` };
    }
    if (!conversationDateFromSheet(dateValue)) {
      return {
        ok: false,
        error: `${first} ${last} has a Date of Conversation that is not mm/dd/yyyy (${dateValue}).`,
      };
    }
    if (!summary) {
      return { ok: false, error: `${first} ${last} has an empty Conversation column.` };
    }
    if (!buildingTag) {
      return { ok: false, error: `${first} ${last} has an empty Building column.` };
    }
    if (!populationTag) {
      return { ok: false, error: `${first} ${last} has an empty Student Population column.` };
    }
    if (!themeTag) {
      return { ok: false, error: `${first} ${last} has an empty Theme column.` };
    }

    if (location.hostname === "roompact.com") {
      const hashOk = location.hash.includes(FORM_HASH);
      const formReady = await waitFor(() => pageLooksLikeConversationForm(), 5000);
      if (!hashOk && !formReady) {
        return { ok: false, error: "Open the Resident Conversation form first (#/form/7jr4al)." };
      }
      if (!formReady) {
        return { ok: false, error: "The Resident Conversation form has not finished loading." };
      }
    } else if (!pageLooksLikeConversationForm()) {
      return { ok: false, error: "This page does not look like the Resident Conversation form." };
    }

    const resident = await fillResidentTag(first, last);
    if (resident.missing.length) {
      warnings.push(
        "Could not select resident tag: " +
          resident.missing.join(", ") +
          ". Type the name in the Tag Residents field if it is missing."
      );
    }

    const building = await fillNamedTag(BUILDING_LABEL, buildingTag, BUILDING_TAG_ARIA);
    if (building.missing.length) {
      warnings.push("Could not select building tag: " + building.missing.join(", ") + ".");
    }

    const population = await fillNamedTag(POPULATION_LABEL, populationTag, POPULATION_TAG_ARIA);
    if (population.missing.length) {
      warnings.push("Could not select student population tag: " + population.missing.join(", ") + ".");
    }

    const date = await fillDate(dateValue);
    await fillSummary(summary);

    const theme = await fillNamedTag(THEME_LABEL, themeTag, THEME_TAG_ARIA);
    if (theme.missing.length) {
      warnings.push("Could not select theme tag: " + theme.missing.join(", ") + ".");
    }

    const residentPart = resident.added[0] || "no resident tag";
    return {
      ok: true,
      message: `Filled ${residentPart}, building, population, ${date}, summary, and theme. Referrals, follow-up, and supervisor were left blank.`,
      warnings,
    };
  }

  function ensureBannerStyles() {
    if (document.getElementById(BANNER_STYLE_ID)) {
      return;
    }
    const style = document.createElement("style");
    style.id = BANNER_STYLE_ID;
    style.textContent =
      "#" +
      BANNER_ID +
      "{position:fixed;top:12px;right:12px;z-index:2147483646;display:flex;gap:10px;align-items:center;max-width:min(420px,calc(100vw - 24px));padding:10px 12px;background:#003057;color:#fff;font:13px/1.35 system-ui,Segoe UI,sans-serif;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.25);}" +
      "#" +
      BANNER_ID +
      " .rcf-autorun-text{flex:1;}" +
      "#" +
      BANNER_ID +
      " button{border:0;border-radius:4px;padding:6px 10px;background:#a32020;color:#fff;font:inherit;font-weight:700;cursor:pointer;}";
    document.documentElement.appendChild(style);
  }

  function hideBanner() {
    window.clearTimeout(bannerHideTimer);
    document.getElementById(BANNER_ID)?.remove();
  }

  function showBanner(step, person) {
    ensureBannerStyles();
    window.clearTimeout(bannerHideTimer);
    let el = document.getElementById(BANNER_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = BANNER_ID;
      el.innerHTML =
        '<span class="rcf-autorun-text"></span><button type="button" class="rcf-autorun-stop">Stop</button>';
      document.documentElement.appendChild(el);
      el.querySelector(".rcf-autorun-stop").addEventListener("click", () => {
        if (loopActive) {
          stopResidentLoop();
          return;
        }
        hideBanner();
      });
    }
    const stopBtn = el.querySelector(".rcf-autorun-stop");
    if (stopBtn) {
      stopBtn.textContent = loopActive ? "Stop" : "Dismiss";
    }
    const label = person ? `${person.first} ${person.last}`.trim() : "";
    el.querySelector(".rcf-autorun-text").textContent = label ? `${step} — ${label}` : step;
  }

  async function setRunStatus(message, kind) {
    await storageSet({ autoRunStatus: message, autoRunStatusKind: kind || "" });
  }

  function personLabel(person) {
    if (!person) {
      return "resident";
    }
    return person.label || `${person.first} ${person.last}`.trim();
  }

  function findSubmitButton(includeDisabled) {
    const buttons = [...document.querySelectorAll("button.forms-submit-btn, button[title='Click to submit form']")].filter(
      (el) => isOnVisiblePage(el)
    );
    if (includeDisabled) {
      return buttons[0] || null;
    }
    return (
      buttons.find((el) => !el.disabled && !el.classList.contains("forms-submit-btn-disabled")) || null
    );
  }

  function isConversationFormUrl() {
    const hashOk = location.hash.includes(FORM_HASH);
    if (location.hostname === "roompact.com") {
      return location.pathname.startsWith("/forms") && hashOk && !isSubmissionUrl();
    }
    return hashOk && !isSubmissionUrl();
  }

  function isSubmissionUrl() {
    return SUBMISSION_HASH.test(location.hash || "");
  }

  function conversationFormReady() {
    return isConversationFormUrl() && conversationFormVisible() && Boolean(visibleResidentTagInput());
  }

  function reopenConversationFormUrl() {
    if (isConversationFormUrl()) {
      location.reload();
      return "unload";
    }
    if (location.hostname === "roompact.com") {
      location.assign(FORM_URL);
      return "hash";
    }
    location.hash = "#" + FORM_HASH;
    return "hash";
  }

  async function submitConversationForm() {
    await assertNotStopped();
    const enabled = await waitFor(() => findSubmitButton(false), 8000, 100);
    if (!enabled) {
      const raw = findSubmitButton(true);
      if (raw && (raw.disabled || raw.classList.contains("forms-submit-btn-disabled"))) {
        throw new Error("Submit stayed disabled. The form is not valid yet. Nothing was submitted.");
      }
      throw new Error("Could not find the Submit button.");
    }
    await assertNotStopped();
    enabled.scrollIntoView({ block: "center", inline: "nearest" });
    elmClick(enabled);
  }

  async function waitUntilSubmitted() {
    const submitted = await waitFor(() => isSubmissionUrl(), 20000, 100, { ignoreStop: true });
    if (!submitted) {
      throw new Error(
        "Submit did not open a #/submission URL. The counter was not incremented."
      );
    }
  }

  async function waitForNewForm() {
    const timeout = 20000;
    const start = Date.now();
    let stableSince = 0;
    while (Date.now() - start < timeout) {
      await assertNotStopped();
      if (conversationFormReady()) {
        if (!stableSince) {
          stableSince = Date.now();
        }
        if (Date.now() - stableSince >= FORM_SETTLE_MS) {
          return;
        }
      } else {
        stableSince = 0;
      }
      await sleep(100);
    }
    throw new Error("The new Resident Conversation form did not load.");
  }

  async function ensureConversationForm(options) {
    if (conversationFormReady() && !options?.settle) {
      return;
    }
    await assertNotStopped();
    if (!isConversationFormUrl()) {
      const nav = reopenConversationFormUrl();
      if (nav === "unload") {
        return;
      }
    }
    await waitForNewForm();
  }

  function personAtIndex(queue, index) {
    return queue.find((person) => person.index === index) || null;
  }

  async function stopResidentLoop() {
    stopRequested = true;
    await storageSet({
      autoRun: false,
      autoRunStatus: "Stop requested. Halting at the next checkpoint.",
      autoRunStatusKind: "warn",
    });
  }

  async function finishLoop(message, kind) {
    await storageSet({
      autoRun: false,
      autoRunStatus: message,
      autoRunStatusKind: kind || "",
    });
    loopActive = false;
    showBanner(message, null);
    bannerHideTimer = window.setTimeout(hideBanner, kind === "error" ? 20000 : 8000);
  }

  async function resumeOntoForm(queue) {
    const stored = await storageGet(["nextResidentIndex"]);
    const person = personAtIndex(queue, Number(stored.nextResidentIndex));
    showBanner("Resuming", person);
    await setRunStatus(person ? `Resuming ${personLabel(person)}.` : "Resuming…", "");
    await ensureConversationForm({ settle: true });
  }

  async function runLoop(queue, options) {
    if (loopActive) {
      return;
    }
    loopActive = true;
    stopRequested = false;
    lastStopPoll = 0;
    const resume = Boolean(options?.resume);
    try {
      if (!Array.isArray(queue) || !queue.length) {
        throw new Error("No residents left to file.");
      }
      await storageSet({ autoRun: true, autoRunQueue: queue });
      if (resume) {
        const storedIndex = Number((await storageGet(["nextResidentIndex"])).nextResidentIndex);
        if (!Number.isInteger(storedIndex) || storedIndex < 0 || !personAtIndex(queue, storedIndex)) {
          await storageSet({ nextResidentIndex: queue[0].index });
        }
        await resumeOntoForm(queue);
      } else {
        const requested = Number(options?.startIndex);
        const startIndex =
          Number.isInteger(requested) && personAtIndex(queue, requested)
            ? requested
            : queue[0].index;
        await storageSet({ nextResidentIndex: startIndex });
      }

      while (true) {
        await assertNotStopped();
        const stored = await storageGet(["nextResidentIndex"]);
        const currentIndex = Number(stored.nextResidentIndex);
        const person = personAtIndex(queue, Number.isInteger(currentIndex) ? currentIndex : queue[0].index);
        if (!person) {
          await finishLoop("Resident list finished. Start stopped.", "ok");
          return;
        }

        showBanner("Opening form", person);
        await setRunStatus(`Opening form for ${personLabel(person)}.`, "");
        await ensureConversationForm();

        showBanner("Filling", person);
        await setRunStatus(`Filling ${personLabel(person)}.`, "");
        const result = await fillResidentConversation({ resident: person });
        if (!result.ok) {
          throw new Error(result.error || "Fill failed.");
        }
        if (result.warnings?.length) {
          throw new Error(
            "Required fields were missing, so Submit was not clicked. " + result.warnings.join(" ")
          );
        }

        await assertNotStopped();
        showBanner("Submitting", person);
        await setRunStatus(`Submitting ${personLabel(person)}.`, "");
        await submitConversationForm();
        await waitUntilSubmitted();

        const nextIndex = person.index + 1;
        await storageSet({ nextResidentIndex: nextIndex });

        const nextPerson = personAtIndex(queue, nextIndex);
        if (!nextPerson) {
          await finishLoop(
            `Submitted ${personLabel(person)}. Resident list finished.`,
            "ok"
          );
          return;
        }

        await assertNotStopped();
        showBanner("Opening next form", nextPerson);
        await setRunStatus(`Submitted ${personLabel(person)}. Opening the next form.`, "");
        const nav = reopenConversationFormUrl();
        if (nav === "unload") {
          loopActive = false;
          return;
        }
        await waitForNewForm();
      }
    } catch (err) {
      if (isStoppedError(err)) {
        await finishLoop("Stopped. The current form was not submitted unless Submit had already been clicked.", "warn");
        return;
      }
      await finishLoop(err.message || String(err), "error");
    } finally {
      loopActive = false;
    }
  }

  async function startResidentLoop(queue, options) {
    if (loopActive) {
      return { ok: false, error: "A run is already in progress." };
    }
    runLoop(queue, options).catch(() => {});
    return { ok: true, started: true };
  }

  async function maybeResumeLoop() {
    if (loopActive || !hasChromeStorage()) {
      return;
    }
    const stored = await storageGet(["autoRun", "autoRunQueue"]);
    if (!stored.autoRun || !Array.isArray(stored.autoRunQueue) || !stored.autoRunQueue.length) {
      return;
    }
    startResidentLoop(stored.autoRunQueue, { resume: true });
  }

  const root = typeof window !== "undefined" ? window : self;
  root.fillResidentConversation = fillResidentConversation;
  root.startResidentLoop = startResidentLoop;
  root.stopResidentLoop = stopResidentLoop;
  root.getResidentLoopState = () => ({
    ...memoryStore,
    loopActive,
    stopRequested,
  });

  if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.autoRun && changes.autoRun.newValue === false) {
        stopRequested = true;
      }
    });
  }

  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === "PING") {
        sendResponse({ ok: true, loopActive });
        return;
      }
      if (message?.type === "STOP") {
        stopResidentLoop()
          .then(() => {
            try {
              sendResponse({ ok: true, stopped: true });
            } catch {
              /* popup may have closed */
            }
          })
          .catch((err) => {
            try {
              sendResponse({ ok: false, error: err.message || String(err) });
            } catch {
              /* popup may have closed */
            }
          });
        return true;
      }
      if (message?.type === "START_LOOP") {
        if (loopActive) {
          sendResponse({ ok: false, error: "A run is already in progress." });
          return;
        }
        const queue = Array.isArray(message.queue) ? message.queue : [];
        startResidentLoop(queue, { resume: false, startIndex: message.startIndex })
          .then((result) => {
            try {
              sendResponse(result);
            } catch {
              /* popup may have closed */
            }
          })
          .catch((err) => {
            try {
              sendResponse({ ok: false, error: err.message || String(err) });
            } catch {
              /* popup may have closed */
            }
          });
        return true;
      }
      if (message?.type === "FILL") {
        if (loopActive) {
          sendResponse({ ok: false, error: "Stop the current run before using Fill form." });
          return;
        }
        fillResidentConversation(message)
          .then((result) => {
            try {
              sendResponse(result);
            } catch {
              /* popup may have closed after a page click */
            }
          })
          .catch((err) => {
            try {
              sendResponse({ ok: false, error: err.message || String(err) });
            } catch {
              /* popup may have closed after a page click */
            }
          });
        return true;
      }
    });
  }

  maybeResumeLoop();
})();
