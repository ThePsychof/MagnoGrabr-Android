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

function filenameFromDisposition(value) {
  if (!value) return null;
  const encoded = value.match(/filename\*\s*=\s*(?:UTF-8'')?("?)([^;"']+)\1/i);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[2].trim());
    } catch {
      return encoded[2].trim();
    }
  }
  const plain = value.match(/filename\s*=\s*(?:"([^"]*)"|([^;]*))/i);
  return plain ? (plain[1] || plain[2]).trim() : null;
}

async function probeLinkMetadata(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(url, {
      method: "HEAD",
      credentials: "omit",
      redirect: "follow",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: controller.signal
    });
    const contentLength = response.headers.get("content-length");
    const parsedLength = contentLength === null ? null : Number(contentLength);
    return {
      sizeBytes: response.ok && Number.isSafeInteger(parsedLength) && parsedLength >= 0 ? parsedLength : null,
      filename: response.ok ? filenameFromDisposition(response.headers.get("content-disposition")) : null,
      mime: response.ok ? response.headers.get("content-type") : null
    };
  } finally {
    clearTimeout(timer);
  }
}

async function enrichLinkMetadata(items) {
  const queue = [...items];
  const worker = async () => {
    while (queue.length) {
      const item = queue.shift();
      let metadata = { sizeBytes: null, filename: null, mime: null };
      try {
        metadata = await probeLinkMetadata(item.url);
      } catch {
        // Size previews are optional; keep the saved link if its server cannot be probed.
      }
      await serialize(async () => {
        const { links } = await readState();
        let changed = false;
        const updated = links.map((link) => {
          if (link.id !== item.id) return link;
          changed = true;
          return {
            ...link,
            sizeBytes: metadata.sizeBytes ?? link.sizeBytes,
            sizeStatus: metadata.sizeBytes == null ? "unavailable" : "available",
            filename: metadata.filename || link.filename,
            mime: metadata.mime || link.mime,
            type: metadata.mime || link.type
          };
        });
        if (changed) await browser.storage.local.set({ links: updated });
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
}

async function capture(payloads, method) {
  return serialize(async () => {
    const { links, settings } = await readState();
    const candidates = payloads.map((item) => shared.makeLink({ ...item, sizeStatus: "checking" }, method)).filter(Boolean);
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
    if (additions.length) {
      await browser.storage.local.set({ links: [...links, ...additions] });
      void enrichLinkMetadata(additions.map(({ id, url }) => ({ id, url })))
        .catch((error) => console.error("Could not update link size previews.", error));
    }
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

async function handleMessage(message, sender) {
  if (!message || typeof message.type !== "string") return undefined;
  if (message.type === "collection.get") return readState();
  if (message.type === "metadata.refresh") {
    return serialize(async () => {
      const { links } = await readState();
      const ids = new Set(Array.isArray(message.ids) ? message.ids : []);
      const candidates = links.filter((link) =>
        ids.has(link.id) && link.sizeBytes == null && link.sizeStatus !== "checking"
      );
      if (!candidates.length) return { queued: 0 };
      const candidateIds = new Set(candidates.map((link) => link.id));
      await browser.storage.local.set({
        links: links.map((link) => candidateIds.has(link.id) ? { ...link, sizeStatus: "checking" } : link)
      });
      void enrichLinkMetadata(candidates.map(({ id, url }) => ({ id, url })))
        .catch((error) => console.error("Could not update link size previews.", error));
      return { queued: candidates.length };
    });
  }
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
      const { settings: current } = await readState();
      const settings = shared.sanitizeSettings({ ...current, ...message.settings });
      await browser.storage.local.set({ settings });
      return settings;
    });
  }
  if (message.type === "settings.open") {
    await browser.tabs.create({ url: browser.runtime.getURL("options.html") });
    return { opened: true };
  }
  if (message.type === "page-tools.set-enabled") {
    return serialize(async () => {
      const { settings } = await readState();
      const updated = shared.sanitizeSettings({ ...settings, enabled: message.enabled === true });
      await browser.storage.local.set({ settings: updated });
      return updated;
    });
  }
  if (message.type === "collection.open") {
    const baseUrl = browser.runtime.getURL("collection.html");
    if (Number.isInteger(sender?.tab?.id)) {
      await browser.tabs.update(sender.tab.id, { url: baseUrl });
    } else {
      await browser.tabs.create({ url: baseUrl });
    }
    return { opened: true };
  }
  if (["collection.remove", "collection.clear", "collection.dedupe", "collection.category"].includes(message.type)) {
    return mutateCollection(message);
  }
  throw new Error("Unknown MagnoGrabr action.");
}

browser.runtime.onMessage.addListener((message, sender) => handleMessage(message, sender));

browser.runtime.onInstalled.addListener(async () => {
  const stored = await browser.storage.local.get(["links", "settings"]);
  const defaults = {};
  if (!Array.isArray(stored.links)) defaults.links = [];
  if (!stored.settings) defaults.settings = shared.DEFAULT_SETTINGS;
  if (Object.keys(defaults).length) await browser.storage.local.set(defaults);
});
