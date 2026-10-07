(function (root) {
  "use strict";

  const genericLabels = new Set([
    "about", "back", "blog", "contact", "continue", "home", "login", "menu", "next",
    "page", "previous", "read", "read more", "search", "sign in", "skip", "subscribe"
  ]);

  function tokens(value) {
    return String(value || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim()
      .split(/\s+/)
      .filter((token) => token.length > 1);
  }

  function textSimilarity(first, second) {
    const a = new Set(tokens(first));
    const b = new Set(tokens(second));
    if (!a.size || !b.size) return 0;
    let common = 0;
    for (const token of a) if (b.has(token)) common += 1;
    return common / (a.size + b.size - common);
  }

  function urlFeatures(value) {
    try {
      const url = new URL(value);
      const segments = url.pathname.split("/").filter(Boolean).map((part) =>
        /^\d+$/.test(part) || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(part) ? ":id" : part.toLowerCase()
      );
      return { host: url.hostname.toLowerCase(), segments };
    } catch {
      return null;
    }
  }

  function urlSimilarity(first, second) {
    const a = urlFeatures(first);
    const b = urlFeatures(second);
    if (!a || !b) return 0;
    const sharedHost = a.host === b.host;
    const depth = a.segments.length === b.segments.length;
    let common = 0;
    const max = Math.max(a.segments.length, b.segments.length, 1);
    for (let index = 0; index < Math.min(a.segments.length, b.segments.length); index += 1) {
      if (a.segments[index] === b.segments[index]) common += 1;
    }
    return (sharedHost ? 0.2 : 0) + (depth ? 0.1 : 0) + 0.7 * common / max;
  }

  function meaningfulLabel(value) {
    const normalized = tokens(value).join(" ");
    return normalized.length > 0 && !genericLabels.has(normalized);
  }

  function rankCandidates(seed, candidates) {
    const ranked = [];
    for (const candidate of candidates) {
      if (candidate === seed || candidate.inChrome || !candidate.url) continue;
      const urlScore = urlSimilarity(seed.url, candidate.url);
      const seedText = meaningfulLabel(seed.text) ? seed.text : "";
      const candidateText = meaningfulLabel(candidate.text) ? candidate.text : "";
      const textScore = textSimilarity(seedText, candidateText);
      const contextScore = textSimilarity(seed.context, candidate.context);
      const repeatedPeer = candidate.sameRepeatGroup === true;
      const structurallySimilar = candidate.sameStructure === true;

      const qualifies = repeatedPeer
        ? urlScore >= 0.34 || textScore >= 0.35 || contextScore >= 0.45
        : structurallySimilar && urlScore >= 0.65 && textScore >= 0.45;
      if (!qualifies) continue;

      const score = (repeatedPeer ? 5 : 0) + (structurallySimilar ? 1 : 0) +
        urlScore * 3 + textScore * 3 + contextScore;
      ranked.push({ candidate, score });
    }
    return ranked.sort((a, b) => b.score - a.score).map(({ candidate }) => candidate);
  }

  root.MagnoGrabrSmart = { rankCandidates };
})(globalThis);
