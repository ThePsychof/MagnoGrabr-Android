"use strict";

const shared = globalThis.MagnoGrabrShared;
const ui = {
  list: document.querySelector("#links"),
  search: document.querySelector("#search"),
  filter: document.querySelector("#category-filter"),
  sort: document.querySelector("#sort"),
  summary: document.querySelector("#summary"),
  notice: document.querySelector("#notice"),
  empty: document.querySelector("#empty"),
  dialog: document.querySelector("#details"),
  selectedCount: document.querySelector("#copy-selected")
};
let links = [];
let settings = shared.DEFAULT_SETTINGS;
let selected = new Set();
let detailId = null;

function notify(message) {
  ui.notice.textContent = message;
}

async function reload() {
  const state = await browser.runtime.sendMessage({ type: "collection.get" });
  links = state.links;
  settings = state.settings;
  document.body.dataset.theme = settings.darkMode ? "dark" : "light";
  document.body.dataset.accent = settings.theme;
  render();
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
  const category = ui.filter.value;
  const items = links.filter((link) => {
    const matchesCategory = category === "All categories" || link.category === category;
    const searchable = [link.filename, link.normalizedUrl, link.text, link.sourceTitle, link.sourcePage].join(" ").toLowerCase();
    return matchesCategory && (!query || searchable.includes(query));
  });
  if (ui.sort.value === "oldest") items.sort((a, b) => a.timestamp - b.timestamp);
  else if (ui.sort.value === "name") items.sort((a, b) => (a.filename || a.text || a.normalizedUrl).localeCompare(b.filename || b.text || b.normalizedUrl));
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
  ui.summary.textContent = `${links.length} saved link${links.length === 1 ? "" : "s"} · ${visible.length} shown`;
  ui.list.replaceChildren();
  ui.empty.hidden = links.length !== 0;
  ui.list.hidden = links.length === 0;
  if (links.length && visible.length === 0) {
    ui.list.append(element("p", "empty", "No links match your search or filter."));
  }
  for (const link of visible) ui.list.append(renderCard(link));
  const count = selected.size;
  document.querySelector("#copy-selected").disabled = count === 0;
  document.querySelector("#copy-selected").textContent = count ? `Copy (${count})` : "Copy";
  document.querySelector("#export-selected").disabled = count === 0;
  document.querySelector("#export-selected").textContent = count ? `Export (${count})` : "Export";
  document.querySelector("#delete-selected").disabled = count === 0;
  document.querySelector("#delete-selected").textContent = count ? `Delete (${count})` : "Delete";
  document.querySelector("#select-visible").textContent =
    visible.length && visible.every((link) => selected.has(link.id)) ? "Deselect visible" : "Select visible";
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
  const remove = element("button", "icon-button", "×");
  remove.type = "button";
  remove.setAttribute("aria-label", "Remove link");
  remove.addEventListener("click", () => void removeOne(link.id));
  row.append(checkbox, main, remove);
  card.append(row);
  const metadata = element("div", "link-meta");
  metadata.append(element("span", "tag", link.category));
  metadata.append(element("span", "", link.captureMethod || "Captured"));
  if (link.sizeBytes != null) metadata.append(element("span", "", shared.formatBytes(link.sizeBytes)));
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
    ["Size", link.sizeBytes == null ? null : shared.formatBytes(link.sizeBytes)],
    ["MIME type", link.mime],
    ["Type", link.type],
    ["Source page", link.sourceTitle],
    ["Source URL", link.sourcePage],
    ["Captured via", link.captureMethod],
    ["Captured", new Date(link.timestamp).toLocaleString()]
  ]) {
    if (value) fields.append(detailField(label, value));
  }
  const category = document.querySelector("#detail-category");
  category.value = link.category;
  ui.dialog.showModal();
}

async function removeOne(id) {
  await mutate({ type: "collection.remove", ids: [id] });
  if (detailId === id) ui.dialog.close();
  notify("Link removed.");
}

async function copyLinks(items) {
  try {
    await navigator.clipboard.writeText(items.map((link) => link.normalizedUrl).join("\n"));
    notify(`Copied ${items.length} link${items.length === 1 ? "" : "s"}.`);
  } catch (error) {
    notify(`Copy failed: ${error.message || error}`);
  }
}

function downloadExport(items) {
  if (!items.length) {
    notify("There are no links to export.");
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
  notify(`Exported ${items.length} link${items.length === 1 ? "" : "s"} as ${format.toUpperCase()}.`);
}

async function deleteSelected() {
  const ids = [...selected];
  if (!ids.length || !window.confirm(`Remove ${ids.length} selected link${ids.length === 1 ? "" : "s"}?`)) return;
  await mutate({ type: "collection.remove", ids });
  notify(`Removed ${ids.length} selected link${ids.length === 1 ? "" : "s"}.`);
}

for (const category of ["All categories", ...shared.CATEGORIES]) {
  ui.filter.append(new Option(category, category));
  if (category !== "All categories") document.querySelector("#detail-category").append(new Option(category, category));
}

ui.search.addEventListener("input", render);
ui.filter.addEventListener("change", render);
ui.sort.addEventListener("change", render);
document.querySelector("#refresh").addEventListener("click", () => reload().catch((error) => notify(`Could not load collection: ${error.message || error}`)));
document.querySelector("#settings").addEventListener("click", () => {
  browser.tabs.create({ url: browser.runtime.getURL("options.html") })
    .catch((error) => notify(`Could not open settings: ${error.message || error}`));
});
document.querySelector("#select-visible").addEventListener("click", () => {
  const visible = filteredLinks();
  if (visible.length && visible.every((link) => selected.has(link.id))) visible.forEach((link) => selected.delete(link.id));
  else visible.forEach((link) => selected.add(link.id));
  render();
});
document.querySelector("#copy-selected").addEventListener("click", () => copyLinks(links.filter((link) => selected.has(link.id))));
document.querySelector("#export-selected").addEventListener("click", () => downloadExport(links.filter((link) => selected.has(link.id))));
document.querySelector("#delete-selected").addEventListener("click", () => deleteSelected().catch((error) => notify(`Delete failed: ${error.message || error}`)));
document.querySelector("#dedupe").addEventListener("click", async () => {
  try {
    const before = links.length;
    await mutate({ type: "collection.dedupe" });
    notify(`Removed ${before - links.length} duplicate link${before - links.length === 1 ? "" : "s"}.`);
  } catch (error) {
    notify(`Deduplication failed: ${error.message || error}`);
  }
});
document.querySelector("#export-all").addEventListener("click", () => downloadExport(links));
document.querySelector("#clear").addEventListener("click", async () => {
  if (!links.length || !window.confirm(`Clear all ${links.length} saved links? This cannot be undone.`)) return;
  try {
    await mutate({ type: "collection.clear" });
    selected.clear();
    notify("Collection cleared.");
  } catch (error) {
    notify(`Could not clear collection: ${error.message || error}`);
  }
});
document.querySelector("#detail-copy").addEventListener("click", () => {
  const link = links.find((item) => item.id === detailId);
  if (link) void copyLinks([link]);
});
document.querySelector("#detail-open").addEventListener("click", () => {
  const link = links.find((item) => item.id === detailId);
  if (link) void browser.tabs.create({ url: link.url }).catch((error) => notify(`Could not open link: ${error.message || error}`));
});
document.querySelector("#detail-remove").addEventListener("click", () => {
  if (detailId) void removeOne(detailId).catch((error) => notify(`Remove failed: ${error.message || error}`));
});
document.querySelector("#detail-done").addEventListener("click", () => ui.dialog.close());
document.querySelector("#detail-category").addEventListener("change", async (event) => {
  if (!detailId) return;
  try {
    await mutate({ type: "collection.category", ids: [detailId], category: event.target.value });
    notify("Category updated.");
    const link = links.find((item) => item.id === detailId);
    if (link) openDetails(link);
  } catch (error) {
    notify(`Could not update category: ${error.message || error}`);
  }
});

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes.links || changes.settings) {
    reload().catch((error) => notify(`Could not refresh collection: ${error.message || error}`));
  }
});

reload().catch((error) => notify(`Could not load collection: ${error.message || error}`));
