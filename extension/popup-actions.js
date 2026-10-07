"use strict";

async function currentTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active browser tab is available.");
  return tab;
}

async function sendToCurrentPage(message) {
  const tab = await currentTab();
  try {
    return await browser.tabs.sendMessage(tab.id, message);
  } catch {
    throw new Error("This Firefox page does not allow extensions. Try a regular webpage.");
  }
}

async function enabledPageState() {
  const state = await sendToCurrentPage({ type: "content.state" });
  if (!state.enabled) throw new Error("Page tools are disabled. Enable them in Settings.");
  return state;
}

async function startPageMode(mode) {
  await enabledPageState();
  await sendToCurrentPage({ type: "content.mode", mode });
  window.close();
}

document.querySelector("#grab-action").addEventListener("click", async () => {
  try {
    const { mode } = await enabledPageState();
    await startPageMode(mode === "grab" ? "off" : "grab");
  } catch (error) {
    document.querySelector("#action-notice").textContent = error.message || String(error);
  }
});

for (const [id, mode] of [["draw-action", "draw"], ["smart-action", "smart"]]) {
  document.querySelector(`#${id}`).addEventListener("click", async () => {
    try {
      await startPageMode(mode);
    } catch (error) {
      document.querySelector("#action-notice").textContent = error.message || String(error);
    }
  });
}

document.querySelector("#extract-action").addEventListener("click", async () => {
  const notice = document.querySelector("#action-notice");
  try {
    await enabledPageState();
    const result = await sendToCurrentPage({ type: "content.action", action: "extract" });
    notice.textContent = `Added ${result.added}; skipped ${result.duplicates} duplicates.`;
  } catch (error) {
    notice.textContent = error.message || String(error);
  }
});
