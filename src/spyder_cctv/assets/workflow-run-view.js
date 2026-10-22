"use strict";
(() => {
  const esc = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const count = (value) => Math.max(0, Math.min(1e9, Number(value) || 0));
  function renderGraph(run) {
    const nodes = (run.graph?.nodes || []).slice(0, 256);
    const ids = new Set(nodes.map((n) => n.id));
    const edges = (run.graph?.edges || [])
      .slice(0, 512)
      .filter((e) => ids.has(e.from) && ids.has(e.to));
    const records = new Map((run.nodes || []).map((n) => [n.id, n]));
    const incoming = new Map(nodes.map((n) => [n.id, 0]));
    const children = new Map(nodes.map((n) => [n.id, []]));
    for (const e of edges) {
      incoming.set(e.to, incoming.get(e.to) + 1);
      children.get(e.from).push(e.to);
    }
    const depth = new Map(),
      queue = nodes.filter((n) => !incoming.get(n.id)).map((n) => n.id);
    for (const id of queue) depth.set(id, 0);
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      for (const to of children.get(id)) {
        depth.set(to, Math.max(depth.get(to) || 0, depth.get(id) + 1));
        incoming.set(to, incoming.get(to) - 1);
        if (!incoming.get(to)) queue.push(to);
      }
    }
    const rows = new Map(),
      positions = new Map();
    for (const node of nodes) {
      const column = depth.get(node.id) || 0,
        row = rows.get(column) || 0;
      rows.set(column, row + 1);
      positions.set(node.id, { x: 16 + column * 210, y: 16 + row * 100 });
    }
    const width = Math.max(
      210,
      ...[...positions.values()].map((p) => p.x + 200),
    );
    const height = Math.max(
      100,
      ...[...positions.values()].map((p) => p.y + 90),
    );
    const tone = (state) =>
      state === "error"
        ? "bad"
        : ["completed", "saved", "requested"].includes(state)
          ? "good"
          : "quiet";
    const paths = edges
      .map((e) => {
        const a = positions.get(e.from),
          b = positions.get(e.to),
          state = records.get(e.to)?.state;
        return `<path class="wt-trace-edge wt-trace-${tone(state)}" d="M ${a.x + 170} ${a.y + 32} C ${a.x + 195} ${a.y + 32}, ${b.x - 25} ${b.y + 32}, ${b.x} ${b.y + 32}"/>`;
      })
      .join("");
    const cards = nodes
      .map((node) => {
        const p = positions.get(node.id),
          record = records.get(node.id),
          state = record?.state || "not retained / not reached";
        return `<g class="wt-trace-node wt-trace-${tone(state)}" transform="translate(${p.x} ${p.y})"><title>${esc(node.type)} · ${esc(node.id)} · ${esc(state)} · ${count(record?.input_count)} IN / ${count(record?.output_count)} OUT</title><rect width="170" height="64" rx="8"/><text x="10" y="22">${esc(node.type)}</text><text class="wt-trace-caption" x="10" y="44">${esc(state)} · ${count(record?.input_count)} / ${count(record?.output_count)}</text></g>`;
      })
      .join("");
    return nodes.length
      ? `<details class="wt-trace"><summary>Execution graph · ${nodes.length} nodes</summary><p>Scroll to follow the path. Node details and recorded inputs appear below.</p><div class="wt-trace-graph"><svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Archived workflow execution graph">${paths}${cards}</svg></div></details>`
      : "";
  }
  function renderMedia(media) {
    if (!media || !/^[a-f0-9]{32}$/.test(media.id || "")) return "";
    const url = `/api/media/${media.id}`;
    if (media.kind === "recording")
      return `<details class="wt-media"><summary>Play recording · ${esc(media.filename || media.id)}</summary><video controls preload="none" src="${url}"></video><a href="${url}" download>Download recording</a></details>`;
    if (media.kind === "capture")
      return `<details class="wt-media"><summary>View capture · ${esc(media.filename || media.id)}</summary><img loading="lazy" src="${url}" alt="Recorded workflow capture"><a href="${url}" download>Download capture</a></details>`;
    return `<a href="${url}" download>Download attachment</a>`;
  }
  const api = { renderGraph, renderMedia };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.spyderWorkflowRunView = api;
})();
