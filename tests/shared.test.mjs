import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import "../extension/shared.js";

const shared = globalThis.MagnoGrabrShared;
const backgroundSource = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const smartSource = readFileSync(new URL("../extension/smart-grab.js", import.meta.url), "utf8");
const smartContext = {};
runInNewContext(smartSource, smartContext);

function createBackgroundHarness(fetchImpl = async () => ({
  ok: false,
  headers: { get() { return null; } }
})) {
  const storage = { links: [], settings: { ...shared.DEFAULT_SETTINGS } };
  const openedTabs = [];
  const updatedTabs = [];
  let onMessage;
  const browser = {
    storage: {
      local: {
        async get(keys) { return Object.fromEntries(keys.map((key) => [key, storage[key]])); },
        async set(values) { Object.assign(storage, values); }
      }
    },
    runtime: {
      onMessage: { addListener(listener) { onMessage = listener; } },
      onInstalled: { addListener() {} },
      getURL(path) { return `moz-extension://unit-test/${path}`; }
    },
    tabs: {
      async create(options) { openedTabs.push(options.url); },
      async update(tabId, options) { updatedTabs.push({ tabId, ...options }); }
    }
  };
  runInNewContext(backgroundSource, {
    browser,
    globalThis: { MagnoGrabrShared: shared },
    crypto: globalThis.crypto,
    fetch: fetchImpl,
    AbortController,
    setTimeout,
    clearTimeout,
    Promise
  });
  return { storage, openedTabs, updatedTabs, send: (message, sender) => onMessage(message, sender) };
}

test("normalization removes URL fragments but retains query parameters", () => {
  assert.equal(shared.normalizeUrl("https://example.org/watch?id=4#comments"), "https://example.org/watch?id=4");
});

test("categories reflect media, files, software domains, and MIME types", () => {
  assert.equal(shared.categorize("https://cdn.example.org/clip.mp4", null, null), "Media");
  assert.equal(shared.categorize("https://example.org/download", "report.pdf", null), "Files");
  assert.equal(shared.categorize("https://github.com/project/repo", null, null), "Software");
  assert.equal(shared.categorize("https://example.org/download", null, "application/pdf"), "Files");
});

test("deduplication keeps the first link sharing a normalized URL", () => {
  const links = [
    { id: "first", url: "https://example.org/a#one" },
    { id: "second", url: "https://example.org/a#two" }
  ];
  assert.deepEqual(shared.deduplicate(links), [links[0]]);
});

test("capture metadata is normalized and unsafe protocols are rejected", () => {
  const link = shared.makeLink({
    url: "https://example.org/file.pdf#download",
    text: "Download report",
    sourcePage: "https://example.org/",
    sourceTitle: "Example"
  }, "Grab Mode");
  assert.equal(link.normalizedUrl, "https://example.org/file.pdf");
  assert.equal(link.filename, "file.pdf");
  assert.equal(link.category, "Files");
  assert.equal(link.captureMethod, "Grab Mode");
  assert.equal(shared.makeLink({ url: "javascript:alert(1)" }, "Grab Mode"), null);
});

test("CSV export quotes fields and doubles embedded quotes", () => {
  const csv = shared.exportLinks([{
    normalizedUrl: "https://example.org/file.csv",
    filename: 'A "quoted" label.csv',
    sizeBytes: 2048,
    type: null
  }], "csv");
  assert.match(csv, /^name,size,type,tag,url\n/);
  assert.match(csv, /"A ""quoted"" label\.csv","2\.00 KB"/);
});

test("JSON export retains the prototype's portable field shape", () => {
  const data = JSON.parse(shared.exportLinks([{
    normalizedUrl: "https://example.org/a",
    filename: null,
    sizeBytes: null,
    type: null
  }], "json"));
  assert.deepEqual(data[0], { name: "", size: "", type: "", tag: "", url: "https://example.org/a" });
});

test("settings are bounded and invalid values fall back safely", () => {
  assert.deepEqual(shared.sanitizeSettings({ grabDelayMs: 9000, theme: "bad", defaultExport: "bad" }), {
    enabled: true,
    dedupe: true,
    grabDelayMs: 1000,
    theme: "red",
    darkMode: true,
    defaultExport: "txt"
  });
  assert.equal(shared.sanitizeSettings({ enabled: false }).enabled, false);
});

test("Smart Grab prefers repeated content peers and excludes unrelated chrome", () => {
  const seed = {
    url: "https://example.org/articles/blue-bird",
    text: "Blue bird conservation",
    context: "Blue bird conservation details"
  };
  const candidates = [
    {
      url: "https://example.org/articles/green-bird",
      text: "Green bird conservation",
      context: "Green bird conservation details",
      sameRepeatGroup: true,
      sameStructure: true
    },
    {
      url: "https://example.org/navigation/contact",
      text: "Contact",
      inChrome: true,
      sameRepeatGroup: false,
      sameStructure: false
    },
    {
      url: "https://example.org/shop/cart",
      text: "Shopping cart and checkout",
      context: "Your shopping cart",
      sameRepeatGroup: false,
      sameStructure: true
    }
  ];
  assert.deepEqual(Array.from(smartContext.MagnoGrabrSmart.rankCandidates(seed, candidates)), [candidates[0]]);
});

test("Smart Grab rejects weak matches outside a repeated content group", () => {
  const seed = { url: "https://example.org/articles/blue-bird", text: "Blue bird conservation" };
  const candidate = {
    url: "https://example.org/stories/green-bird",
    text: "City council budget update",
    sameRepeatGroup: false,
    sameStructure: true
  };
  const unrelated = {
    url: "https://example.org/contact",
    text: "Contact",
    sameRepeatGroup: false,
    sameStructure: true
  };
  assert.deepEqual(Array.from(smartContext.MagnoGrabrSmart.rankCandidates(seed, [candidate, unrelated])), []);
});

test("concurrent capture methods share serialized storage and deduplicate fragments", async () => {
  const harness = createBackgroundHarness();
  const [first, second] = await Promise.all([
    harness.send({ type: "capture", method: "Grab Mode", items: [{ url: "https://example.org/item#one" }] }),
    harness.send({ type: "capture", method: "Extract Page", items: [{ url: "https://example.org/item#two" }] })
  ]);
  assert.equal(first.added + second.added, 1);
  assert.equal(first.duplicates + second.duplicates, 1);
  assert.equal(harness.storage.links.length, 1);
  assert.ok(["Grab Mode", "Extract Page"].includes(harness.storage.links[0].captureMethod));
});

test("captured links receive asynchronous size and filename previews", async () => {
  const requests = [];
  const harness = createBackgroundHarness(async (url, options) => {
    requests.push({ url, method: options.method });
    return {
      ok: true,
      headers: {
        get(name) {
          if (name === "content-length") return "4096";
          if (name === "content-disposition") return 'attachment; filename="guide.pdf"';
          if (name === "content-type") return "application/pdf";
          return null;
        }
      }
    };
  });
  await harness.send({ type: "capture", method: "Grab Mode", items: [{ url: "https://example.org/download" }] });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(requests, [{ url: "https://example.org/download", method: "HEAD" }]);
  assert.equal(harness.storage.links[0].sizeBytes, 4096);
  assert.equal(harness.storage.links[0].sizeStatus, "available");
  assert.equal(harness.storage.links[0].filename, "guide.pdf");
  assert.equal(harness.storage.links[0].mime, "application/pdf");
});

test("collection management mutations update the same persistent links", async () => {
  const harness = createBackgroundHarness();
  await harness.send({ type: "capture", method: "Draw Mode", items: [{ url: "https://example.org/item" }] });
  const id = harness.storage.links[0].id;
  const categorized = await harness.send({ type: "collection.category", ids: [id], category: "Files" });
  assert.equal(categorized.links[0].category, "Files");
  const removed = await harness.send({ type: "collection.remove", ids: [id] });
  assert.equal(removed.links.length, 0);
  assert.equal(harness.storage.links.length, 0);
});

test("collection.clear removes every saved link", async () => {
  const harness = createBackgroundHarness();
  await harness.send({
    type: "capture",
    method: "Grab Mode",
    items: [{ url: "https://example.org/one" }, { url: "https://example.org/two" }]
  });
  const result = await harness.send({ type: "collection.clear" });
  assert.equal(result.removed, 2);
  assert.equal(result.links.length, 0);
  assert.equal(harness.storage.links.length, 0);
});

test("collection.open navigates the current page tab to the extension collection", async () => {
  const harness = createBackgroundHarness();
  const result = await harness.send({ type: "collection.open" }, { tab: { id: 42 } });
  assert.equal(result.opened, true);
  assert.deepEqual(harness.updatedTabs, [{ tabId: 42, url: "moz-extension://unit-test/collection.html" }]);
  assert.deepEqual(harness.openedTabs, []);
});

test("collection.open creates a tab when there is no originating page tab", async () => {
  const harness = createBackgroundHarness();
  const result = await harness.send({ type: "collection.open" });
  assert.equal(result.opened, true);
  assert.deepEqual(harness.openedTabs, ["moz-extension://unit-test/collection.html"]);
});

test("page-tools toggle persists while other settings saves preserve it", async () => {
  const harness = createBackgroundHarness();
  const disabled = await harness.send({ type: "page-tools.set-enabled", enabled: false });
  assert.equal(disabled.enabled, false);
  const updated = await harness.send({ type: "settings.save", settings: { theme: "blue" } });
  assert.equal(updated.enabled, false);
  assert.equal(updated.theme, "blue");
  const enabled = await harness.send({ type: "page-tools.set-enabled", enabled: true });
  assert.equal(enabled.enabled, true);
});
