"use strict";

const notice = document.querySelector("#notice");
const delay = document.querySelector("#delay");
delay.addEventListener("input", () => { document.querySelector("#delay-value").value = `${delay.value} ms`; });

browser.runtime.sendMessage({ type: "collection.get" }).then(({ settings }) => {
  document.body.dataset.theme = settings.darkMode ? "dark" : "light";
  document.body.dataset.accent = settings.theme;
  document.querySelector("#dedupe").checked = settings.dedupe;
  document.querySelector("#dark-mode").checked = settings.darkMode;
  document.querySelector("#theme").value = settings.theme;
  delay.value = settings.grabDelayMs;
  document.querySelector("#delay-value").value = `${settings.grabDelayMs} ms`;
  document.querySelector("#export-format").value = settings.defaultExport;
}).catch(() => { notice.textContent = "Load failed"; });

document.querySelector("#save").addEventListener("click", async () => {
  const settings = {
    dedupe: document.querySelector("#dedupe").checked,
    darkMode: document.querySelector("#dark-mode").checked,
    theme: document.querySelector("#theme").value,
    grabDelayMs: Number(delay.value),
    defaultExport: document.querySelector("#export-format").value
  };
  try {
    const saved = await browser.runtime.sendMessage({ type: "settings.save", settings });
    document.body.dataset.theme = saved.darkMode ? "dark" : "light";
    document.body.dataset.accent = saved.theme;
    notice.textContent = "Saved";
  } catch {
    notice.textContent = "Save failed";
  }
});

document.querySelector("#collection").addEventListener("click", () => {
  if (window.history.length > 1) {
    window.history.back();
    return;
  }
  location.assign(browser.runtime.getURL("collection.html"));
});
