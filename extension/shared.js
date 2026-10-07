(function (root) {
  "use strict";

  const CATEGORIES = ["Media", "Files", "Links", "Software", "Suspicious", "Misc"];
  const mediaExtensions = new Set(
    "jpg jpeg png webp gif bmp svg ico tiff heic mp4 webm mkv mov avi flv wmv m4v mp3 wav flac ogg m4a aac opus".split(" ")
  );
  const fileExtensions = new Set(
    "pdf doc docx txt rtf odt xls xlsx csv ods ppt pptx zip rar 7z tar gz bz2 xz js ts py sh java cpp c go rs php html css json xml yaml md ttf otf woff woff2".split(" ")
  );
  const softwareExtensions = new Set("exe msi msix dll dmg rpm deb apk ipa jar iso".split(" "));
  const mediaDomains = ["youtube.com", "youtu.be", "vimeo.com", "dailymotion.com", "twitch.tv", "soundcloud.com", "bandcamp.com", "spotify.com", "instagram.com", "flickr.com", "imgur.com", "pinterest.com"];
  const fileDomains = ["drive.google.com", "dropbox.com", "onedrive.live.com", "mega.nz", "box.com"];
  const softwareDomains = ["github.com", "gitlab.com", "bitbucket.org", "sourceforge.net", "pypi.org", "crates.io", "nuget.org"];

  function normalizeUrl(rawUrl) {
    const trimmed = String(rawUrl || "").trim();
    try {
      const url = new URL(trimmed);
      url.hash = "";
      return url.href;
    } catch {
      return trimmed.split("#", 1)[0];
    }
  }

  function filenameFromUrl(rawUrl) {
    try {
      const segment = new URL(rawUrl).pathname.split("/").filter(Boolean).pop();
      return segment ? decodeURIComponent(segment) : null;
    } catch {
      return null;
    }
  }

  function domainMatches(host, domains) {
    return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
  }

  function categorize(url, filename, mime) {
    const normalizedMime = String(mime || "").split(";", 1)[0].trim().toLowerCase();
    if (/^(image|video|audio)\//.test(normalizedMime)) return "Media";
    if (normalizedMime === "application/pdf" || normalizedMime === "application/zip" || normalizedMime.startsWith("text/")) return "Files";
    if (normalizedMime.includes("android-package") || normalizedMime.includes("executable")) return "Software";

    const name = filename || filenameFromUrl(url);
    const extension = name && name.includes(".") ? name.split(".").pop().toLowerCase() : "";
    if (mediaExtensions.has(extension)) return "Media";
    if (fileExtensions.has(extension)) return "Files";
    if (softwareExtensions.has(extension)) return "Software";

    try {
      const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
      if (domainMatches(host, mediaDomains)) return "Media";
      if (domainMatches(host, fileDomains)) return "Files";
      if (domainMatches(host, softwareDomains)) return "Software";
    } catch {
      return "Misc";
    }
    return extension ? "Misc" : "Links";
  }

  function textOrNull(value) {
    return typeof value === "string" && value.trim() ? value.trim().slice(0, 2_000) : null;
  }

  function makeLink(data, method) {
    if (!data || typeof data.url !== "string") return null;
    const url = data.url.trim();
    if (!/^https?:\/\//i.test(url)) return null;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const normalizedUrl = normalizeUrl(parsed.href);
    const mime = textOrNull(data.mime);
    const type = textOrNull(data.type);
    const filename = textOrNull(data.filename) || filenameFromUrl(normalizedUrl);
    return {
      id: crypto.randomUUID(),
      url: parsed.href,
      normalizedUrl,
      category: CATEGORIES.includes(data.category) ? data.category : categorize(normalizedUrl, filename, mime || type),
      text: String(data.text || "").trim().slice(0, 2_000),
      timestamp: Date.now(),
      type,
      mime,
      sizeBytes: Number.isFinite(data.sizeBytes) && data.sizeBytes >= 0 ? data.sizeBytes : null,
      sizeStatus: data.sizeStatus === "checking" ? "checking" : Number.isFinite(data.sizeBytes) && data.sizeBytes >= 0 ? "available" : "unavailable",
      filename,
      sourcePage: textOrNull(data.sourcePage),
      sourceTitle: textOrNull(data.sourceTitle),
      captureMethod: method
    };
  }

  function deduplicate(links) {
    const seen = new Set();
    return links.filter((link) => {
      const key = normalizeUrl(link.normalizedUrl || link.url);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return "";
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB", "PB"];
    let size = bytes;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024;
      unit += 1;
    }
    return unit === 0 ? `${bytes} B` : `${size.toFixed(2)} ${units[unit]}`;
  }

  function exportLinks(links, format) {
    if (format === "txt") return links.map((link) => link.normalizedUrl).join("\n");
    if (format === "json") {
      return JSON.stringify(links.map((link) => ({
        name: link.filename || "",
        size: formatBytes(link.sizeBytes),
        type: link.type || "",
        tag: link.filename && link.filename.includes(".") ? link.filename.split(".").pop() : "",
        url: link.normalizedUrl
      })), null, 2);
    }
    if (format !== "csv") throw new Error(`Unsupported export format: ${format}`);
    const field = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    return [
      "name,size,type,tag,url",
      ...links.map((link) => [
        link.filename || "",
        formatBytes(link.sizeBytes),
        link.type || "",
        link.filename && link.filename.includes(".") ? link.filename.split(".").pop() : "",
        link.normalizedUrl
      ].map(field).join(","))
    ].join("\n");
  }

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    dedupe: true,
    grabDelayMs: 0,
    theme: "red",
    darkMode: true,
    defaultExport: "txt"
  });

  function sanitizeSettings(settings) {
    return {
      enabled: settings?.enabled !== false,
      dedupe: settings?.dedupe !== false,
      grabDelayMs: Math.max(0, Math.min(1_000, Number(settings?.grabDelayMs) || 0)),
      theme: ["red", "pink", "blue"].includes(settings?.theme) ? settings.theme : "red",
      darkMode: settings?.darkMode !== false,
      defaultExport: ["txt", "csv", "json"].includes(settings?.defaultExport) ? settings.defaultExport : "txt"
    };
  }

  root.MagnoGrabrShared = {
    CATEGORIES,
    DEFAULT_SETTINGS,
    categorize,
    deduplicate,
    exportLinks,
    filenameFromUrl,
    formatBytes,
    makeLink,
    normalizeUrl,
    sanitizeSettings
  };
})(globalThis);
