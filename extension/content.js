(function () {
  "use strict";

  if (window.top !== window.self || !document.documentElement) return;

  const smart = globalThis.MagnoGrabrSmart;
  let enabled = false;
  let mode = "off";
  let reviewHost = null;
  let reviewRoot = null;
  let smartCandidates = [];
  let selectionOverlay = null;
  let statusTimer = null;
  let launcherRemovalTimer = null;
  let savedCountTapCount = 0;
  let lastSavedCountTapAt = 0;
  let clearingCollection = false;
  let grabCount = 0;
  let savedLinkCount = 0;
  let themeAccent = "red";
  let darkMode = true;

  function payloadFor(anchor) {
    const rawUrl = anchor.href || anchor.getAttribute("href") || "";
    return {
      url: rawUrl,
      text: (anchor.textContent || "").replace(/\s+/g, " ").trim() || anchor.getAttribute("aria-label") || anchor.title || "",
      title: anchor.title || "",
      type: anchor.getAttribute("type") || "",
      mime: anchor.getAttribute("type") || "",
      filename: anchor.getAttribute("download") || "",
      sourcePage: location.href,
      sourceTitle: document.title
    };
  }

  async function capture(items, method) {
    if (!items.length) {
      if (method === "Draw Mode") showMessage("No links");
      return { added: 0, duplicates: 0 };
    }
    let added = 0;
    let duplicates = 0;
    try {
      for (let index = 0; index < items.length; index += 500) {
        const result = await browser.runtime.sendMessage({
          type: "capture",
          items: items.slice(index, index + 500),
          method
        });
        added += result.added;
        duplicates += result.duplicates;
      }
      if (method === "Grab Mode") {
        grabCount += added;
        if (added > 0) showGrabSuccess();
        else if (duplicates > 0) showStatus("Already saved", "notice", 1200);
      } else if (added > 0 && ["Draw Mode", "Smart Grab"].includes(method)) {
        showMessage(`Saved ${added}`, "success");
      } else if (["Draw Mode", "Smart Grab"].includes(method) && duplicates > 0) {
        showMessage(`${duplicates} duplicate${duplicates === 1 ? "" : "s"}`);
      } else if (["Draw Mode", "Smart Grab"].includes(method)) {
        showMessage("No new links");
      }
      return { added, duplicates };
    } catch (error) {
      showMessage("Save failed");
      throw error;
    }
  }

  function linkElements() {
    return [...document.querySelectorAll("a[href],area[href]")]
      .filter((element) => element.href.startsWith("http"));
  }

  function isChrome(element) {
    for (let node = element; node && node !== document.body; node = node.parentElement) {
      const tag = node.tagName.toLowerCase();
      const role = (node.getAttribute("role") || "").toLowerCase();
      const labels = `${node.id} ${typeof node.className === "string" ? node.className : ""} ${role}`;
      if (["header", "nav", "footer", "aside"].includes(tag) || role === "navigation" ||
          /(?:^|[\s_-])(header|footer|nav|navigation|sidebar|side-bar|breadcrumb|pagination|pager|menu|toolbar|social|advert|ads?)(?:$|[\s_-])/i.test(labels)) {
        return true;
      }
    }
    return false;
  }

  function classSignature(element) {
    const classes = typeof element.className === "string" ? element.className.split(/\s+/) : [];
    return `${element.tagName}:${classes.filter((name) =>
      name && !/(?:active|current|selected|hover|focus|open|closed|expanded|collapsed)/i.test(name)
    ).sort().join(".")}`;
  }

  function repeatedGroup(anchor) {
    let node = anchor.parentElement;
    for (let depth = 0; node && node.parentElement && depth < 9; depth += 1, node = node.parentElement) {
      const signature = classSignature(node);
      const peers = [...node.parentElement.children].filter((sibling) =>
        classSignature(sibling) === signature && sibling.querySelector("a[href],area[href]")
      );
      if (peers.length >= 2) return { signature, peers };
    }
    return null;
  }

  function structuralSimilarity(first, second) {
    const trail = (element) => {
      const result = [];
      for (let node = element; node && node !== document.body && result.length < 7; node = node.parentElement) {
        result.push(classSignature(node));
      }
      return result;
    };
    const a = trail(first);
    const b = trail(second);
    let common = 0;
    for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
      if (a[index] !== b[index]) break;
      common += 1;
    }
    return common / Math.max(a.length, b.length, 1);
  }

  function contextText(anchor, group) {
    if (group) {
      const container = group.peers.find((peer) => peer.contains(anchor));
      if (container) return (container.textContent || "").slice(0, 500);
    }
    let node = anchor.parentElement;
    for (let depth = 0; node && depth < 3; depth += 1, node = node.parentElement) {
      const text = (node.textContent || "").trim();
      if (text.length >= 20) return text.slice(0, 500);
    }
    return "";
  }

  function reviewSimilar(seed) {
    const seedGroup = repeatedGroup(seed);
    const referencePeer = seedGroup?.peers.find((peer) => peer.contains(seed));
    const seedFeature = {
      url: seed.href,
      text: payloadFor(seed).text,
      context: contextText(seed, seedGroup)
    };
    const candidates = linkElements()
      .filter((candidate) => candidate !== seed)
      .map((candidate) => {
        const peer = seedGroup?.peers.find((item) => item !== referencePeer && item.contains(candidate));
        return {
          element: candidate,
          url: candidate.href,
          text: payloadFor(candidate).text,
          context: contextText(candidate, peer ? { peers: [peer] } : null),
          inChrome: isChrome(candidate),
          sameRepeatGroup: Boolean(peer),
          sameStructure: structuralSimilarity(seed, candidate) >= 0.72
        };
      });
    const ranked = smart.rankCandidates(seedFeature, candidates).slice(0, 100);
    smartCandidates = [payloadFor(seed), ...ranked.map((candidate) => payloadFor(candidate.element))];
    ensureReviewUi();
    const summary = reviewRoot.querySelector(".review-summary");
    summary.textContent = smartCandidates.length === 1
      ? "No sufficiently similar links were found. Only the link you selected will be added."
      : `${smartCandidates.length - 1} similar links found. Review before adding.`;
    const list = reviewRoot.querySelector(".review-candidates");
    list.replaceChildren();
    smartCandidates.forEach((item) => {
      const row = document.createElement("div");
      row.className = "candidate";
      row.textContent = item.text ? `${item.text} — ${item.url}` : item.url;
      list.append(row);
    });
    reviewRoot.querySelector(".confirm").classList.add("open");
  }

  function ensureReviewUi() {
    if (reviewHost) return;
    reviewHost = document.createElement("div");
    reviewHost.id = "magnograbr-review-host";
    reviewHost.dataset.theme = darkMode ? "dark" : "light";
    reviewHost.dataset.accent = themeAccent;
    reviewHost.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;";
    reviewRoot = reviewHost.attachShadow({ mode: "closed" });
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = browser.runtime.getURL("content.css");
    reviewRoot.append(stylesheet);
    const panel = document.createElement("div");
    panel.innerHTML = `
      <div class="confirm" role="dialog" aria-modal="true" aria-labelledby="mg-review-title">
        <div class="card">
          <h2 id="mg-review-title">Review Smart Grab</h2>
          <p class="review-summary"></p>
          <div class="review-candidates"></div>
          <div class="confirm-actions">
            <button data-action="cancel">Cancel</button>
            <button class="primary" data-action="accept">Add links</button>
          </div>
        </div>
      </div>
      `;
    reviewRoot.append(panel);
    reviewRoot.addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      if (button.dataset.action === "cancel") {
        setMode("off");
      } else if (button.dataset.action === "accept") {
        const items = smartCandidates;
        setMode("off");
        void capture(items, "Smart Grab").catch(() => {});
      }
    });
    reviewRoot.querySelector(".confirm").addEventListener("click", (event) => {
      if (event.target.classList.contains("confirm")) setMode("off");
    });
    document.documentElement.append(reviewHost);
  }

  function showMessage(message, state = "notice") {
    showStatus(message, state, mode === "off" ? 4000 : 2500);
  }

  function removeReviewUi() {
    reviewHost?.remove();
    reviewHost = null;
    reviewRoot = null;
  }

  function removeSelectionOverlay() {
    selectionOverlay?.remove();
    selectionOverlay = null;
  }

  function endDraw() { setMode("off"); }

  function beginSelection() {
    removeSelectionOverlay();
    const overlay = document.createElement("div");
    overlay.id = "magnograbr-selection-overlay";
    overlay.style.cssText = "all:initial!important;position:fixed!important;z-index:2147483646!important;inset:0!important;display:block!important;background:transparent!important;touch-action:none!important;cursor:crosshair!important;";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${window.innerWidth} ${window.innerHeight}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.style.cssText = "display:block!important;width:100vw!important;height:100vh!important;overflow:visible!important;touch-action:none!important;";
    const box = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    box.style.cssText = "display:none;fill:#f72e2c2a;stroke:#f72e2c;stroke-width:2;vector-effect:non-scaling-stroke;pointer-events:none;";
    svg.append(box);
    overlay.append(svg);
    let start = null;
    let end = null;

    overlay.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      start = { x: event.clientX, y: event.clientY };
      end = start;
      overlay.setPointerCapture(event.pointerId);
      box.style.display = "block";
      drawBox();
    });
    overlay.addEventListener("pointermove", (event) => {
      if (!start) return;
      end = { x: event.clientX, y: event.clientY };
      drawBox();
    });
    overlay.addEventListener("pointerup", (event) => {
      if (!start) return;
      end = { x: event.clientX, y: event.clientY };
      const rect = {
        left: Math.min(start.x, end.x),
        top: Math.min(start.y, end.y),
        right: Math.max(start.x, end.x),
        bottom: Math.max(start.y, end.y)
      };
      start = null;
      endDraw();
      const items = linkElements()
        .filter((element) => intersects(element.getBoundingClientRect(), rect))
        .map(payloadFor);
      void capture(items, "Draw Mode").catch(() => {});
    });
    overlay.addEventListener("pointercancel", endDraw);
    function drawBox() {
      if (!start || !end) return;
      box.setAttribute("x", String(Math.min(start.x, end.x)));
      box.setAttribute("y", String(Math.min(start.y, end.y)));
      box.setAttribute("width", String(Math.abs(end.x - start.x)));
      box.setAttribute("height", String(Math.abs(end.y - start.y)));
    }

    selectionOverlay = overlay;
    document.documentElement.append(overlay);
  }

  function intersects(a, b) {
    return a.right >= b.left && a.left <= b.right && a.bottom >= b.top && a.top <= b.bottom;
  }

  function setMode(next) {
    clearTimeout(statusTimer);
    statusTimer = null;
    if (next === "grab" && mode !== "grab") grabCount = 0;
    mode = next;
    if (mode !== "draw") removeSelectionOverlay();
    if (mode === "draw") beginSelection();
    if (mode !== "smart") {
      reviewRoot?.querySelector(".confirm").classList.remove("open");
      smartCandidates = [];
      removeReviewUi();
    }
    if (mode === "off") {
      const status = launcherRoot?.querySelector(".capture-status");
      if (status) status.hidden = true;
    }
    syncLauncher();
  }

  function updateSavedCount(links) {
    if (Array.isArray(links)) savedLinkCount = links.length;
    const counter = launcherRoot?.querySelector(".saved-count");
    if (!counter) return;
    counter.textContent = String(savedLinkCount);
    counter.setAttribute("aria-label", `${savedLinkCount} links saved. Tap three times quickly to clear collection`);
  }

  function handleSavedCountTap() {
    const now = Date.now();
    savedCountTapCount = now - lastSavedCountTapAt <= 700 ? savedCountTapCount + 1 : 1;
    lastSavedCountTapAt = now;
    if (savedCountTapCount < 3) return;
    savedCountTapCount = 0;
    lastSavedCountTapAt = 0;
    if (clearingCollection) return;
    if (!savedLinkCount) {
      showMessage("Already empty");
      return;
    }
    clearingCollection = true;
    void browser.runtime.sendMessage({ type: "collection.clear" })
      .then(({ removed }) => showMessage(`Cleared ${removed}`, "success"))
      .catch(() => showMessage("Clear failed"))
      .finally(() => { clearingCollection = false; });
  }

  function stopLabel() {
    if (mode === "draw") return "Stop drawing";
    if (mode === "smart") return "Exit Smart Grab";
    return "Stop grabbing";
  }

  function handlePageClick(event) {
    const path = event.composedPath();
    if (launcherRoot?.querySelector(".action-dock.open") && !path.includes(launcherHost)) toggleDock(false);
    if (mode === "off" || event.defaultPrevented) return;
    const anchor = path.find((node) => node instanceof HTMLAnchorElement || node instanceof HTMLAreaElement);
    if (!anchor) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (mode === "smart") {
      reviewSimilar(anchor);
      return;
    }
    if (mode === "grab") {
      showStatus("Saving…", "pending", 0);
      void capture([payloadFor(anchor)], "Grab Mode").catch(() => {});
    }
  }

  let launcherHost = null;
  let launcherRoot = null;

  const MODE_DETAILS = {
    grab: { icon: "🧲", title: "Tap links to save" },
    draw: { icon: "✏️", title: "Draw around links" },
    smart: { icon: "✨", title: "Tap a link to find similar" }
  };

  function showGrabSuccess() {
    showStatus("Saved · tap more", "success", 1200);
  }

  function showStatus(message, state, duration) {
    if (!enabled) return;
    ensureLauncher();
    const status = launcherRoot?.querySelector(".capture-status");
    if (!status) return;
    clearTimeout(statusTimer);
    statusTimer = null;
    const indicator = status.querySelector(".status-indicator");
    indicator.textContent = state === "success" ? "✅" : state === "pending" ? "⏳" : state === "notice" ? "⚠️" : "🧲";
    status.querySelector(".status-message").textContent = message;
    status.dataset.state = state;
    status.querySelector(".status-stop").setAttribute("aria-label", stopLabel());
    const fabCount = launcherRoot.querySelector(".fab-count");
    fabCount.hidden = mode !== "grab";
    fabCount.textContent = String(grabCount);
    status.hidden = false;
    if (!duration) return;
    statusTimer = setTimeout(() => {
      statusTimer = null;
      if (!launcherRoot) return;
      if (mode === "off") {
        status.hidden = true;
        return;
      }
      syncLauncher();
    }, duration);
  }

  function toggleDock(force) {
    const dock = launcherRoot.querySelector(".action-dock");
    const open = typeof force === "boolean" ? force : !dock.classList.contains("open");
    dock.classList.toggle("open", open);
    const fab = launcherRoot.querySelector(".fab");
    fab.setAttribute("aria-expanded", String(open));
    fab.setAttribute("aria-label", open
      ? "Close MagnoGrabr actions"
      : mode === "off" ? "Open MagnoGrabr actions" : `${MODE_DETAILS[mode].title} Open actions`);
  }

  function syncLauncher() {
    if (!enabled) return;
    ensureLauncher();
    if (!launcherRoot) return;
    launcherRoot.querySelector(".page-tools-switch").setAttribute("aria-checked", "true");
    const active = mode !== "off";
    const status = launcherRoot.querySelector(".capture-status");
    const stop = status.querySelector(".status-stop");
    const close = status.querySelector(".status-close");
    const fabCount = launcherRoot.querySelector(".fab-count");
    status.classList.toggle("active", active);
    stop.setAttribute("aria-label", stopLabel());
    stop.hidden = !active;
    close.hidden = active;
    fabCount.hidden = mode !== "grab";
    fabCount.textContent = String(grabCount);
    launcherRoot.querySelector(".fab-icon").textContent = active ? MODE_DETAILS[mode].icon : "🧲";
    launcherRoot.querySelectorAll(".dock-action[data-act='grab'], .dock-action[data-act='draw'], .dock-action[data-act='smart']")
      .forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.act === mode)));
    if (active) {
      const details = MODE_DETAILS[mode];
      status.hidden = false;
      status.dataset.state = "active";
      status.querySelector(".status-indicator").textContent = details.icon;
      status.querySelector(".status-message").textContent = details.title;
    } else if (status.dataset.state === "active") {
      status.hidden = true;
    }
    if (active) toggleDock(false);
  }

  async function runExtract() {
    try {
      const result = await capture(linkElements().map(payloadFor), "Extract Page");
      if (result.added === 0 && result.duplicates === 0) {
        showMessage("No links found");
      } else {
        showMessage(`+${result.added} · ${result.duplicates} dupes`, result.added ? "success" : "notice");
      }
    } catch (error) { /* capture already showed the error */ }
  }

  async function copyAllLinks() {
    try {
      const { links } = await browser.runtime.sendMessage({ type: "collection.get" });
      const urls = links.map((link) => link.normalizedUrl || link.url).filter(Boolean);
      if (!urls.length) {
        showMessage("Nothing to copy");
        return;
      }
      const text = urls.join("\n");
      try {
        await navigator.clipboard.writeText(text);
      } catch (clipboardError) {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0;";
        let copied = false;
        try {
          document.body.append(textarea);
          textarea.select();
          copied = document.execCommand("copy");
        } finally {
          textarea.remove();
        }
        if (!copied) throw clipboardError;
      }
      showMessage(`Copied ${urls.length}`, "success");
    } catch (error) {
      showMessage("Copy failed");
    }
  }

  async function openCollection() {
    try {
      await browser.runtime.sendMessage({ type: "collection.open" });
    } catch (error) {
      showMessage("Open failed");
    }
  }

  async function setPageToolsEnabled(nextEnabled) {
    const toggle = launcherRoot?.querySelector(".page-tools-switch");
    if (toggle) toggle.setAttribute("aria-checked", String(nextEnabled));
    try {
      const result = await browser.runtime.sendMessage({ type: "page-tools.set-enabled", enabled: nextEnabled });
      updateEnabled(result.enabled);
    } catch (error) {
      if (toggle) toggle.setAttribute("aria-checked", String(enabled));
      showMessage("Toggle failed");
    }
  }

  function ensureLauncher() {
    if (launcherHost || !document.body) return;
    launcherHost = document.createElement("div");
    launcherHost.id = "magnograbr-launcher-host";
    launcherHost.dataset.theme = darkMode ? "dark" : "light";
    launcherHost.dataset.accent = themeAccent;
    launcherHost.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;";
    launcherRoot = launcherHost.attachShadow({ mode: "closed" });
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = browser.runtime.getURL("content.css");
    launcherRoot.append(stylesheet);
    const panel = document.createElement("div");
    panel.innerHTML = `
      <div class="action-dock">
        <div class="dock-heading">
          <button class="page-tools-switch" type="button" role="switch" aria-label="Page tools" aria-checked="true" data-act="page-tools-toggle">
            <span class="switch-thumb" aria-hidden="true"></span>
          </button>
          <button class="saved-count" type="button" data-act="clear-collection" title="Tap 3 times quickly to clear collection" aria-label="0 links saved. Tap three times quickly to clear collection">0</button>
        </div>
        <div class="dock-group dock-capture" role="group" aria-label="Link capture actions">
          <button class="dock-action featured" data-act="grab" title="Tap links to save" aria-label="Grab links" aria-pressed="false">🧲</button>
          <button class="dock-action" data-act="draw" title="Draw around links to save" aria-label="Draw selection" aria-pressed="false">✏️</button>
          <button class="dock-action" data-act="smart" title="Find similar links" aria-label="Find similar links" aria-pressed="false">✨</button>
          <button class="dock-action" data-act="extract" title="Save links from this page" aria-label="Get page links">🔗</button>
        </div>
        <div class="dock-divider" aria-hidden="true"></div>
        <div class="dock-group dock-library" role="group" aria-label="Collection actions">
          <button class="dock-action" data-act="copy-all" title="Copy all saved links" aria-label="Copy all saved links">📋</button>
          <button class="dock-action" data-act="collection" title="Open collection" aria-label="Open collection">🗂️</button>
        </div>
      </div>
      <div class="launcher-controls">
        <button class="fab" aria-label="Open MagnoGrabr actions" aria-expanded="false"><span class="fab-icon" aria-hidden="true">🧲</span><span class="fab-count" aria-hidden="true" hidden>0</span></button>
      </div>
      <div class="capture-status" role="status" aria-live="polite" hidden>
        <span class="status-indicator" aria-hidden="true"></span>
        <span class="status-message"></span>
        <button class="status-stop" data-act="cancel" aria-label="Stop grabbing">✖️</button>
        <button class="status-close" data-act="dismiss" aria-label="Dismiss notification" hidden>✖️</button>
      </div>`;
    launcherRoot.append(panel);
    updateSavedCount();

    launcherRoot.addEventListener("click", (event) => {
      const button = event.target.closest("[data-act]");
      if (!button) return;
      const act = button.dataset.act;
      if (act !== "page-tools-toggle" && act !== "clear-collection") toggleDock(false);
      if (act === "cancel") setMode("off");
      else if (act === "dismiss") {
        clearTimeout(statusTimer);
        statusTimer = null;
        launcherRoot.querySelector(".capture-status").hidden = true;
      }
      else if (act === "copy-all") void copyAllLinks();
      else if (act === "collection") void openCollection();
      else if (act === "page-tools-toggle") void setPageToolsEnabled(!enabled);
      else if (act === "clear-collection") handleSavedCountTap();
      else if (act === "extract") void runExtract();
      else setMode(act);
    });

    launcherRoot.querySelector(".fab").addEventListener("click", () => toggleDock());
    document.documentElement.append(launcherHost);
  }

  function handleKeydown(event) {
    if (event.key !== "Escape") return;
    if (mode !== "off") setMode("off");
    else if (launcherRoot?.querySelector(".action-dock.open")) toggleDock(false);
  }

  function updateEnabled(value) {
    if (enabled === value) {
      const toggle = launcherRoot?.querySelector(".page-tools-switch");
      if (toggle) toggle.setAttribute("aria-checked", String(value));
      return;
    }
    enabled = value;
    if (enabled) {
      clearTimeout(launcherRemovalTimer);
      launcherRemovalTimer = null;
      launcherHost?.classList.remove("turning-off");
      syncLauncher();
      document.addEventListener("click", handlePageClick, true);
      document.addEventListener("keydown", handleKeydown, true);
      return;
    }
    mode = "off";
    clearTimeout(statusTimer);
    statusTimer = null;
    document.removeEventListener("click", handlePageClick, true);
    document.removeEventListener("keydown", handleKeydown, true);
    removeSelectionOverlay();
    removeReviewUi();
    const toggle = launcherRoot?.querySelector(".page-tools-switch");
    if (toggle) toggle.setAttribute("aria-checked", "false");
    launcherHost?.classList.add("turning-off");
    clearTimeout(launcherRemovalTimer);
    launcherRemovalTimer = setTimeout(() => {
      if (enabled) return;
      launcherHost?.remove();
      launcherHost = null;
      launcherRoot = null;
      launcherRemovalTimer = null;
    }, 180);
    smartCandidates = [];
  }

  function updateTheme(settings) {
    themeAccent = ["red", "pink", "blue"].includes(settings?.theme) ? settings.theme : "red";
    darkMode = settings?.darkMode !== false;
    if (launcherHost) {
      launcherHost.dataset.theme = darkMode ? "dark" : "light";
      launcherHost.dataset.accent = themeAccent;
    }
    if (reviewHost) {
      reviewHost.dataset.theme = darkMode ? "dark" : "light";
      reviewHost.dataset.accent = themeAccent;
    }
  }

  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes.links) updateSavedCount(changes.links.newValue);
    if (changes.settings) {
      updateTheme(changes.settings.newValue);
      updateEnabled(changes.settings.newValue?.enabled !== false);
    }
  });

  const settingsReady = browser.storage.local.get(["settings", "links"]).then(({ settings, links }) => {
    updateTheme(settings);
    updateEnabled(settings?.enabled !== false);
    updateSavedCount(links);
  }).catch((error) => {
    console.error("MagnoGrabr could not load page tool settings.", error);
  });

  browser.runtime.onMessage.addListener(async (message) => {
    if (!message || !["content.mode", "content.action", "content.state"].includes(message.type)) return undefined;
    await settingsReady;
    if (message.type === "content.state") return { mode, enabled };
    if (!enabled) return { mode, enabled };
    if (message.type === "content.mode") {
      setMode(["grab", "draw", "smart"].includes(message.mode) ? message.mode : "off");
      return { mode, enabled };
    }
    if (message.action === "extract") {
      const result = await capture(linkElements().map(payloadFor), "Extract Page");
      return { ...result, mode, enabled };
    }
    if (["draw", "smart"].includes(message.action)) {
      setMode(message.action);
      return { mode, enabled };
    }
    return undefined;
  });
})();
