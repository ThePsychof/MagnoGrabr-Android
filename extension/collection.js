"use strict";

const shared = globalThis.MagnoGrabrShared;
const ui = {
  list: document.querySelector("#links"),
  search: document.querySelector("#search"),
  summary: document.querySelector("#summary"),
  notice: document.querySelector("#notice"),
  empty: document.querySelector("#empty"),
  dialog: document.querySelector("#details"),
  selectionBar: document.querySelector("#selection-bar"),
  selectionCount: document.querySelector("#selection-count"),
  pageToolsEnabled: document.querySelector("#page-tools-enabled"),
  pageToolsStatus: document.querySelector("#page-tools-status")
};
let links = [];
let settings = shared.DEFAULT_SETTINGS;
let selected = new Set();
let detailId = null;
const filterPicker = MagnoGrabrPicker.createPicker(
  document.querySelector("#category-filter"),
  {
    label: "Filter by category",
    options: [["All categories", "All categories"], ...shared.CATEGORIES.map((category) => [category, category])],
    value: "All categories",
    onChange: render
  }
);
const sortPicker = MagnoGrabrPicker.createPicker(
  document.querySelector("#sort"),
  {
    label: "Sort collection",
    options: [["newest", "Newest first"], ["oldest", "Oldest first"], ["name", "Name A–Z"]],
    value: "newest",
    onChange: render
  }
);
const detailCategoryPicker = MagnoGrabrPicker.createPicker(
  document.querySelector("#detail-category"),
  {
    label: "Category",
    options: shared.CATEGORIES.map((category) => [category, category]),
    value: shared.CATEGORIES[0],
    onChange: updateDetailCategory
  }
);

function notify(message) {
  ui.notice.textContent = message;
  ui.notice.hidden = false;
}

async function reload() {
  const state = await browser.runtime.sendMessage({ type: "collection.get" });
  links = state.links;
  const existingIds = new Set(links.map((link) => link.id));
  for (const id of [...selected]) if (!existingIds.has(id)) selected.delete(id);
  settings = state.settings;
  document.body.dataset.theme = settings.darkMode ? "dark" : "light";
  document.body.dataset.accent = settings.theme;
  ui.pageToolsEnabled.checked = settings.enabled;
  ui.pageToolsStatus.textContent = settings.enabled ? "Enabled on webpages" : "Off — enable here to show page controls";
  render();
  const legacyLinks = links.filter((link) => link.sizeBytes == null && !link.sizeStatus);
  if (legacyLinks.length) {
    void browser.runtime.sendMessage({
      type: "metadata.refresh",
      ids: legacyLinks.map((link) => link.id)
    }).catch(() => notify("Size check failed"));
  }
}

async function mutate(message) {
  const result = await browser.runtime.sendMessage(message);
  links = result.links;
  for (const id of [...selected]) if (!links.some((link) => link.id === id)) selected.delete(id);
  render();
  return result;
}

function filteredLinks() {
  const query = ui.search.value.trim().toLowerCase();
  const category = filterPicker.value;
  const items = links.filter((link) => {
    const matchesCategory = category === "All categories" || link.category === category;
    const searchable = [link.filename, link.normalizedUrl, link.text, link.sourceTitle, link.sourcePage].join(" ").toLowerCase();
    return matchesCategory && (!query || searchable.includes(query));
  });
  if (sortPicker.value === "oldest") items.sort((a, b) => a.timestamp - b.timestamp);
  else if (sortPicker.value === "name") items.sort((a, b) => (a.filename || a.text || a.normalizedUrl).localeCompare(b.filename || b.text || b.normalizedUrl));
  else items.sort((a, b) => b.timestamp - a.timestamp);
  return items;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function render() {
  const visible = filteredLinks();
  ui.summary.textContent = `${links.length} saved link${links.length === 1 ? "" : "s"}`;
  ui.list.replaceChildren();
  ui.empty.hidden = links.length !== 0;
  ui.list.hidden = links.length === 0;
  if (links.length && visible.length === 0) {
    ui.list.append(element("p", "empty", "No links match your search or filter."));
  }
  for (const link of visible) ui.list.append(renderCard(link));
  const count = selected.size;
  ui.selectionBar.hidden = count === 0;
  ui.selectionCount.textContent = `${count} selected`;
  document.querySelector("#select-visible").disabled = visible.length === 0;
  document.querySelector("#copy-selected").disabled = count === 0;
  document.querySelector("#copy-selected").textContent = count ? `Copy (${count})` : "Copy";
  document.querySelector("#export-selected").disabled = count === 0;
  document.querySelector("#export-selected").textContent = count ? `Export (${count})` : "Export";
  document.querySelector("#delete-selected").disabled = count === 0;
  document.querySelector("#delete-selected").textContent = count ? `Delete (${count})` : "Delete";
  document.querySelector("#select-visible").textContent =
    visible.length && visible.every((link) => selected.has(link.id)) ? "Deselect shown" : "Select shown";
  document.querySelector("#dedupe").disabled = links.length < 2;
  document.querySelector("#copy-all").disabled = links.length === 0;
  document.querySelector("#export-all").disabled = links.length === 0;
  document.querySelector("#clear").disabled = links.length === 0;
}

function renderCard(link) {
  const card = element("article", "link-card");
  const row = element("div", "link-card-top");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = selected.has(link.id);
  checkbox.setAttribute("aria-label", `Select ${link.filename || link.normalizedUrl}`);
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) selected.add(link.id);
    else selected.delete(link.id);
    render();
  });
  const main = element("div", "link-main");
  main.tabIndex = 0;
  main.setAttribute("role", "button");
  main.setAttribute("aria-label", `View details for ${link.filename || link.normalizedUrl}`);
  main.append(element("span", "link-title", link.filename || link.text || link.normalizedUrl));
  main.append(element("span", "link-url", link.normalizedUrl));
  main.addEventListener("click", () => openDetails(link));
  main.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openDetails(link);
    }
  });
  const actions = element("div", "link-card-actions");
  const copy = element("button", "link-action-button", "Copy");
  copy.type = "button";
  copy.setAttribute("aria-label", `Copy ${link.filename || link.normalizedUrl}`);
  copy.addEventListener("click", () => void copyLinks([link]));
  const remove = element("button", "icon-button", "×");
  remove.type = "button";
  remove.setAttribute("aria-label", "Remove link");
  remove.addEventListener("click", () => void removeOne(link.id));
  actions.append(copy, remove);
  row.append(checkbox, main, actions);
  card.append(row);
  const metadata = element("div", "link-meta");
  metadata.append(element("span", "tag", link.category));
  metadata.append(element("span", "", link.captureMethod || "Captured"));
  if (link.sizeBytes != null) metadata.append(element("span", "", shared.formatBytes(link.sizeBytes)));
  else metadata.append(element("span", "size-preview", link.sizeStatus === "checking" ? "Checking size…" : "Size unavailable"));
  card.append(metadata);
  return card;
}

function detailField(label, value) {
  const row = element("div", "detail-row");
  row.append(element("strong", "", label), element("span", "", value));
  return row;
}

function openDetails(link) {
  detailId = link.id;
  document.querySelector("#detail-title").textContent = link.filename || link.text || "Link details";
  const fields = document.querySelector("#detail-fields");
  fields.replaceChildren();
  for (const [label, value] of [
    ["URL", link.normalizedUrl],
    ["Link text", link.text],
    ["Category", link.category],
    ["Filename", link.filename],
    ["Size", link.sizeBytes == null ? (link.sizeStatus === "checking" ? "Checking…" : "Unavailable") : shared.formatBytes(link.sizeBytes)],
    ["MIME type", link.mime],
    ["Type", link.type],
    ["Source page", link.sourceTitle],
    ["Source URL", link.sourcePage],
    ["Captured via", link.captureMethod],
    ["Captured", new Date(link.timestamp).toLocaleString()]
  ]) {
    if (value) fields.append(detailField(label, value));
  }
  detailCategoryPicker.setValue(link.category);
  ui.dialog.showModal();
}

async function removeOne(id) {
  await mutate({ type: "collection.remove", ids: [id] });
  if (detailId === id) ui.dialog.close();
  notify("Removed");
}

async function copyLinks(items) {
  if (!items.length) {
    notify("Nothing to copy");
    return;
  }
  try {
    await navigator.clipboard.writeText(items.map((link) => link.normalizedUrl).join("\n"));
    notify(items.length === 1 ? "Copied" : `Copied ${items.length}`);
  } catch {
    notify("Copy failed");
  }
}

function confirmAction(message, title, confirmLabel) {
  const dialog = document.querySelector("#confirmation");
  document.querySelector("#confirmation-title").textContent = title;
  document.querySelector("#confirmation-message").textContent = message;
  const accept = document.querySelector("#confirmation-accept");
  const cancel = document.querySelector("#confirmation-cancel");
  accept.textContent = confirmLabel;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (confirmed) => {
      if (settled) return;
      settled = true;
      cancel.removeEventListener("click", cancelAction);
      accept.removeEventListener("click", acceptAction);
      dialog.removeEventListener("cancel", cancelAction);
      dialog.close();
      resolve(confirmed);
    };
    const cancelAction = () => finish(false);
    const acceptAction = () => finish(true);
    cancel.addEventListener("click", cancelAction);
    accept.addEventListener("click", acceptAction);
    dialog.addEventListener("cancel", cancelAction);
    dialog.showModal();
  });
}

function downloadExport(items) {
  if (!items.length) {
    notify("Nothing to export");
    return;
  }
  const format = settings.defaultExport;
  const mime = format === "json" ? "application/json" : format === "csv" ? "text/csv" : "text/plain";
  const file = new Blob([shared.exportLinks(items, format)], { type: `${mime};charset=utf-8` });
  const objectUrl = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = `MagnoGrabr_Links.${format}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
  notify(`Exported ${items.length} · ${format.toUpperCase()}`);
}

async function deleteSelected() {
  const ids = [...selected];
  if (!ids.length || !await confirmAction(
    `Remove ${ids.length} selected link${ids.length === 1 ? "" : "s"}?`,
    "Remove selected links",
    "Remove"
  )) return;
  await mutate({ type: "collection.remove", ids });
  notify(`Removed ${ids.length}`);
}

async function updateDetailCategory(category) {
  if (!detailId) return;
  try {
    await mutate({ type: "collection.category", ids: [detailId], category });
    notify("Updated");
    const link = links.find((item) => item.id === detailId);
    if (link) openDetails(link);
  } catch {
    const link = links.find((item) => item.id === detailId);
    if (link) detailCategoryPicker.setValue(link.category);
    notify("Update failed");
  }
}

ui.pageToolsEnabled.addEventListener("change", async () => {
  const enabled = ui.pageToolsEnabled.checked;
  ui.pageToolsEnabled.disabled = true;
  try {
    const saved = await browser.runtime.sendMessage({ type: "page-tools.set-enabled", enabled });
    ui.pageToolsEnabled.checked = saved.enabled;
    ui.pageToolsStatus.textContent = saved.enabled ? "Enabled on webpages" : "Off — enable here to show page controls";
    notify(saved.enabled ? "Tools on" : "Tools off");
  } catch (error) {
    ui.pageToolsEnabled.checked = !enabled;
    notify("Toggle failed");
  } finally {
    ui.pageToolsEnabled.disabled = false;
  }
});

ui.search.addEventListener("input", render);
document.querySelector("#refresh").addEventListener("click", () => reload().catch(() => notify("Refresh failed")));
document.querySelector("#settings").addEventListener("click", () => {
  location.assign(browser.runtime.getURL("options.html"));
});
document.querySelector("#select-visible").addEventListener("click", () => {
  const visible = filteredLinks();
  if (visible.length && visible.every((link) => selected.has(link.id))) visible.forEach((link) => selected.delete(link.id));
  else visible.forEach((link) => selected.add(link.id));
  render();
});
document.querySelector("#copy-selected").addEventListener("click", () => copyLinks(links.filter((link) => selected.has(link.id))));
document.querySelector("#export-selected").addEventListener("click", () => downloadExport(links.filter((link) => selected.has(link.id))));
document.querySelector("#delete-selected").addEventListener("click", () => deleteSelected().catch(() => notify("Delete failed")));
document.querySelector("#copy-all").addEventListener("click", () => copyLinks(links));
document.querySelector("#dedupe").addEventListener("click", async () => {
  try {
    const before = links.length;
    await mutate({ type: "collection.dedupe" });
    notify(`Removed ${before - links.length} dupes`);
  } catch {
    notify("Dedupe failed");
  }
});
document.querySelector("#export-all").addEventListener("click", () => downloadExport(links));
document.querySelector("#clear").addEventListener("click", async () => {
  if (!links.length || !await confirmAction(
    `Clear all ${links.length} saved links? This cannot be undone.`,
    "Clear collection",
    "Clear"
  )) return;
  try {
    await mutate({ type: "collection.clear" });
    selected.clear();
    notify("Cleared");
  } catch {
    notify("Clear failed");
  }
});
document.querySelector("#detail-copy").addEventListener("click", () => {
  const link = links.find((item) => item.id === detailId);
  if (link) void copyLinks([link]);
});
document.querySelector("#detail-open").addEventListener("click", () => {
  const link = links.find((item) => item.id === detailId);
  if (link) void browser.tabs.create({ url: link.url }).catch(() => notify("Open failed"));
});
document.querySelector("#detail-remove").addEventListener("click", () => {
  if (detailId) void removeOne(detailId).catch(() => notify("Remove failed"));
});
document.querySelector("#detail-done").addEventListener("click", () => ui.dialog.close());

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes.links || changes.settings) {
    reload().catch(() => notify("Refresh failed"));
  }
});

reload().catch(() => notify("Load failed"));
