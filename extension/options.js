"use strict";

const notice = document.querySelector("#notice");
const delay = document.querySelector("#delay");
const themePicker = MagnoGrabrPicker.createPicker(document.querySelector("#theme"), {
  label: "Accent color",
  options: [["red", "Magno red"], ["pink", "Pink"], ["blue", "Blue"]],
  value: "red",
  onChange: (theme) => { document.body.dataset.accent = theme; }
});
const exportPicker = MagnoGrabrPicker.createPicker(document.querySelector("#export-format"), {
  label: "Default export format",
  options: [["txt", "Plain text (.txt)"], ["csv", "CSV (.csv)"], ["json", "JSON (.json)"]],
  value: "txt"
});
delay.addEventListener("input", () => { document.querySelector("#delay-value").value = `${delay.value} ms`; });

browser.runtime.sendMessage({ type: "collection.get" }).then(({ settings }) => {
  document.body.dataset.theme = settings.darkMode ? "dark" : "light";
  document.body.dataset.accent = settings.theme;
  document.querySelector("#dedupe").checked = settings.dedupe;
  document.querySelector("#dark-mode").checked = settings.darkMode;
  themePicker.setValue(settings.theme);
  delay.value = settings.grabDelayMs;
  document.querySelector("#delay-value").value = `${settings.grabDelayMs} ms`;
  exportPicker.setValue(settings.defaultExport);
}).catch(() => { notice.textContent = "Load failed"; });

document.querySelector("#save").addEventListener("click", async () => {
  const settings = {
    dedupe: document.querySelector("#dedupe").checked,
    darkMode: document.querySelector("#dark-mode").checked,
    theme: themePicker.value,
    grabDelayMs: Number(delay.value),
    defaultExport: exportPicker.value
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
