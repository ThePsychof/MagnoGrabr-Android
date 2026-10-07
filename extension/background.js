"use strict";

const shared = globalThis.MagnoGrabrShared;
let writes = Promise.resolve();

function serialize(task) {
  const result = writes.then(task);
  writes = result.catch(() => {});
  return result;
}

async function readState() {
  const stored = await browser.storage.local.get(["links", "settings"]);
  return {
    links: Array.isArray(stored.links) ? stored.links : [],
    settings: shared.sanitizeSettings(stored.settings)
  };
}

async function capture(payloads, method) {
  return serialize(async () => {
    const { links, settings } = await readState();
    const candidates = payloads.map((item) => shared.makeLink(item, method)).filter(Boolean);
    if (candidates.length && settings.grabDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, settings.grabDelayMs));
    }
    const known = new Set(links.map((link) => shared.normalizeUrl(link.normalizedUrl || link.url)));
    const additions = settings.dedupe
      ? candidates.filter((link) => {
          const key = shared.normalizeUrl(link.normalizedUrl);
          if (known.has(key)) return false;
          known.add(key);
          return true;
        })
      : candidates;
    if (additions.length) await browser.storage.local.set({ links: [...links, ...additions] });
    return { added: additions.length, duplicates: candidates.length - additions.length };
  });
}

async function mutateCollection(message) {
  return serialize(async () => {
    const { links } = await readState();
    let updated = links;
    switch (message.type) {
      case "collection.remove":
        updated = links.filter((link) => !message.ids.includes(link.id));
        break;
      case "collection.clear":
        updated = [];
        break;
      case "collection.dedupe":
        updated = shared.deduplicate(links);
        break;
      case "collection.category":
        if (!shared.CATEGORIES.includes(message.category)) throw new Error("Unknown link category.");
        updated = links.map((link) => message.ids.includes(link.id) ? { ...link, category: message.category } : link);
        break;
      default:
        throw new Error("Unsupported collection action.");
    }
    await browser.storage.local.set({ links: updated });
    return { links: updated, removed: links.length - updated.length };
  });
}

async function handleMessage(message) {
  if (!message || typeof message.type !== "string") return undefined;
  if (message.type === "collection.get") return readState();
  if (message.type === "capture") {
    if (!Array.isArray(message.items)) throw new Error("Capture data must be a list.");
    if (message.items.length > 500) throw new Error("A single capture is limited to 500 links.");
    const method = ["Grab Mode", "Draw Mode", "Smart Grab", "Extract Page"].includes(message.method)
      ? message.method
      : "Grab Mode";
    return capture(message.items, method);
  }
  if (message.type === "settings.save") {
    return serialize(async () => {
      const settings = shared.sanitizeSettings(message.settings);
      await browser.storage.local.set({ settings });
      return settings;
    });
  }
  if (message.type === "settings.open") {
    await browser.tabs.create({ url: browser.runtime.getURL("options.html") });
    return { opened: true };
  }
  if (["collection.remove", "collection.clear", "collection.dedupe", "collection.category"].includes(message.type)) {
    return mutateCollection(message);
  }
  throw new Error("Unknown MagnoGrabr action.");
}

browser.runtime.onMessage.addListener((message) => handleMessage(message));

browser.runtime.onInstalled.addListener(async () => {
  const stored = await browser.storage.local.get(["links", "settings"]);
  const defaults = {};
  if (!Array.isArray(stored.links)) defaults.links = [];
  if (!stored.settings) defaults.settings = shared.DEFAULT_SETTINGS;
  if (Object.keys(defaults).length) await browser.storage.local.set(defaults);
});
