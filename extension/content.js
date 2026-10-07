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
    if (!items.length) return { added: 0, duplicates: 0 };
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
      return { added, duplicates };
    } catch (error) {
      showMessage(`Capture failed after adding ${added}: ${error.message || error}`);
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
    smartCandidates.slice(0, 6).forEach((item) => {
      const row = document.createElement("div");
      row.className = "candidate";
      row.textContent = item.text ? `${item.text} — ${item.url}` : item.url;
      list.append(row);
    });
    if (smartCandidates.length > 6) {
      const more = document.createElement("div");
      more.className = "candidate";
      more.textContent = `and ${smartCandidates.length - 6} more`;
      list.append(more);
    }
    reviewRoot.querySelector(".confirm").classList.add("open");
  }

  function ensureReviewUi() {
    if (reviewHost) return;
    reviewHost = document.createElement("div");
    reviewHost.id = "magnograbr-review-host";
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
      <div class="toast" role="status" aria-live="polite"></div>`;
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

  function showMessage(message) {
    ensureReviewUi();
    const toast = reviewRoot.querySelector(".toast");
    toast.textContent = message;
    toast.classList.add("open");
    setTimeout(() => {
      if (!reviewRoot) return;
      toast.classList.remove("open");
      if (!reviewRoot.querySelector(".confirm.open")) removeReviewUi();
    }, 4000);
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

  function endDraw() { queueMicrotask(syncLauncher);
    mode = "off";
    removeSelectionOverlay();
  }

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

  function setMode(next) { queueMicrotask(syncLauncher);
    mode = next;
    if (mode !== "draw") removeSelectionOverlay();
    if (mode === "draw") beginSelection();
    if (mode !== "smart") {
      reviewRoot?.querySelector(".confirm").classList.remove("open");
      smartCandidates = [];
      if (reviewRoot?.querySelector(".toast.open")) return;
      removeReviewUi();
    }
  }

  function handlePageClick(event) {
    if (mode === "off" || event.defaultPrevented) return;
    const anchor = event.composedPath().find((node) => node instanceof HTMLAnchorElement || node instanceof HTMLAreaElement);
    if (!anchor) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (mode === "smart") {
      reviewSimilar(anchor);
      return;
    }
    if (mode === "grab") {
      mode = "off";
      queueMicrotask(syncLauncher); void capture([payloadFor(anchor)], "Grab Mode").catch(() => {});
    }
  }

  let launcherHost = null;
  let launcherRoot = null;

  const HINTS = {
    grab: "Tap a link to grab it",
    draw: "Drag a box around links",
    smart: "Tap one link to find similar"
  };

  function toggleSheet(force) {
    const open = typeof force === "boolean" ? force : !launcherRoot.querySelector(".sheet").classList.contains("open");
    launcherRoot.querySelector(".sheet").classList.toggle("open", open);
    launcherRoot.querySelector(".scrim").classList.toggle("open", open);
  }

  function syncLauncher() {
    if (!enabled) return;
    ensureLauncher();
    if (!launcherRoot) return;
    const active = mode !== "off";
    launcherRoot.querySelector(".fab").hidden = active;
    launcherRoot.querySelector(".pill").hidden = !active;
    launcherRoot.querySelector(".pill span").textContent = HINTS[mode] || "";
    if (active) toggleSheet(false);
  }

  async function runExtract() {
    try {
      const result = await capture(linkElements().map(payloadFor), "Extract Page");
      showMessage(`Added ${result.added}, skipped ${result.duplicates} duplicates`);
    } catch (error) { /* capture already showed the error */ }
  }

  function ensureLauncher() {
    if (launcherHost || !document.body) return;
    launcherHost = document.createElement("div");
    launcherHost.id = "magnograbr-launcher-host";
    launcherHost.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;";
    launcherRoot = launcherHost.attachShadow({ mode: "closed" });
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = browser.runtime.getURL("content.css");
    launcherRoot.append(stylesheet);
    const panel = document.createElement("div");
    panel.innerHTML = `
      <div class="scrim"></div>
      <div class="sheet" role="dialog" aria-label="MagnoGrabr actions">
        <div class="sheet-handle"></div>
        <h2>MagnoGrabr</h2>
        <div class="sheet-grid">
          <button class="primary" data-act="grab">🧲 Grab</button>
          <button data-act="draw">✏️ Draw</button>
          <button data-act="smart">✨ Smart Grab</button>
          <button data-act="extract">🔗 Extract page</button>
        </div>
      </div>
      <button class="fab" aria-label="Open MagnoGrabr">🧲</button>
      <div class="pill" hidden><span></span><button data-act="cancel">✕ Cancel</button></div>`;
    launcherRoot.append(panel);

    launcherRoot.addEventListener("click", (event) => {
      if (event.target.classList.contains("scrim")) return toggleSheet(false);
      const button = event.target.closest("[data-act]");
      if (!button) return;
      const act = button.dataset.act;
      toggleSheet(false);
      if (act === "cancel") setMode("off");
      else if (act === "extract") void runExtract();
      else setMode(act);
    });

    const fab = launcherRoot.querySelector(".fab");
    let drag = null;
    fab.addEventListener("pointerdown", (event) => {
      drag = { y: event.clientY, top: fab.getBoundingClientRect().top, moved: false };
      fab.setPointerCapture(event.pointerId);
    });
    fab.addEventListener("pointermove", (event) => {
      if (!drag) return;
      const dy = event.clientY - drag.y;
      if (Math.abs(dy) > 6) drag.moved = true;
      if (!drag.moved) return;
      fab.style.bottom = "auto";
      fab.style.top = `${Math.min(Math.max(8, drag.top + dy), window.innerHeight - 70)}px`;
    });
    fab.addEventListener("pointerup", () => {
      if (drag && !drag.moved) toggleSheet();
      drag = null;
    });
    fab.addEventListener("pointercancel", () => { drag = null; });

    document.documentElement.append(launcherHost);
  }

  function handleKeydown(event) {
    if (event.key === "Escape" && mode !== "off") setMode("off");
  }

  function updateEnabled(value) {
    if (enabled === value) return;
    enabled = value;
    if (enabled) {
      syncLauncher();
      document.addEventListener("click", handlePageClick, true);
      document.addEventListener("keydown", handleKeydown, true);
      return;
    }
    mode = "off";
    document.removeEventListener("click", handlePageClick, true);
    document.removeEventListener("keydown", handleKeydown, true);
    removeSelectionOverlay();
    removeReviewUi();
    launcherHost?.remove();
    launcherHost = null;
    launcherRoot = null;
    smartCandidates = [];
  }

  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes.settings) return;
    updateEnabled(changes.settings.newValue?.enabled !== false);
  });

  const settingsReady = browser.storage.local.get("settings").then(({ settings }) => {
    updateEnabled(settings?.enabled !== false);
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
