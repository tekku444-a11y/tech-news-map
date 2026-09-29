/* テックニュース相関図 — view-only PWA */
(function () {
  "use strict";

  var WEAK_THRESHOLD = 0.4;
  var NODE_FONT = 20;
  var EDGE_FONT = 14;
  var LABEL_UNITS = 34; // ~17 全角 chars per node label
  var MIN_INITIAL_SCALE = 0.62; // keeps node labels >= ~12-13px on first paint

  var TYPE_COLORS = { causes: "#ef4444", leads_to: "#f59e0b", same_arc: "#3b82f6", related: "#94a3b8", confusable: "#c084fc" };
  var TYPE_LABELS = { causes: "因果", leads_to: "波及", same_arc: "同弧", related: "関連", confusable: "似て聞こえる" };

  // Theme groups -> node color (first matching group wins, by item theme order)
  var GROUPS = [
    { key: "safety", name: "安全・セキュリティ", short: "安全", color: "#f87171",
      themes: ["agent-safety", "sandbox", "zero-day", "security", "alignment", "phishing", "AI-abuse", "malware"] },
    { key: "semi", name: "半導体・チップ", short: "半導体", color: "#fbbf24",
      themes: ["semiconductor", "foundry", "chip-design", "EDA", "RTL", "GPU", "ASIC", "AI-chip", "pricing"] },
    { key: "infra", name: "AI基盤・モデル", short: "AI基盤", color: "#60a5fa",
      themes: ["AI-infra", "inference", "cloud", "LLM", "frontier-model", "agent"] },
    { key: "edge", name: "エッジ・フィジカル", short: "エッジ", color: "#4ade80",
      themes: ["physical-AI", "edge-AI", "on-device", "mobile", "manufacturing", "robotics"] },
  ];
  var OTHER = { key: "other", name: "その他", short: "他", color: "#c4b5fd" };
  var KT_COLOR = "#f472b6"; // これだけテック投稿回 (kind: koredake_post)
  function isKt(it) { return !!it && it.kind === "koredake_post"; }

  var $ = function (s) { return document.querySelector(s); };
  var state = { items: [], links: [], byId: {}, network: null, nodes: null, edges: null, showWeak: false, latest: "" };

  function groupOf(it) {
    var th = it.themes || [];
    for (var i = 0; i < th.length; i++) {
      for (var g = 0; g < GROUPS.length; g++) {
        if (GROUPS[g].themes.indexOf(th[i]) >= 0) return GROUPS[g];
      }
    }
    return OTHER;
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function shortDate(d) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || "");
    return m ? (+m[2]) + "/" + (+m[3]) : d;
  }
  function truncate(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
  // Truncate by visual width: CJK/full-width = 2, others = 1
  function vtrunc(s, units) {
    s = String(s || ""); var w = 0, out = "";
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i), cw = /[\u0000-\u00ff\uff61-\uff9f]/.test(ch) ? 1 : 2;
      if (w + cw > units) return out.replace(/[\s：:・、,]+$/, "") + "…";
      w += cw; out += ch;
    }
    return out;
  }
  function hexA(hex, a) {
    var h = hex.replace("#", "");
    var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return "rgba(" + r + "," + g + "," + b + "," + a + ")";
  }
  function isWeak(L) { return L.auto && L.confidence < WEAK_THRESHOLD; }

  // Recency: 0 (oldest) .. 1 (latest)
  function recency(date) {
    if (!state.minT || state.maxT === state.minT) return 1;
    var t = Date.parse(date);
    return Math.max(0, Math.min(1, (t - state.minT) / (state.maxT - state.minT)));
  }

  function buildNodes() {
    return state.items.map(function (it) {
      var g = groupOf(it);
      var rec = recency(it.date);
      var latest = it.date === state.latest;
      var bgAlpha = 0.18 + 0.22 * rec;
      if (isKt(it)) {
        return {
          id: it.id,
          label: "▶ " + shortDate(it.date) + " これだけ\n" + vtrunc(it.cover_title || it.title, LABEL_UNITS),
          shape: "box",
          margin: { top: 10, right: 12, bottom: 10, left: 12 },
          widthConstraint: { maximum: 170 },
          borderWidth: 2,
          shapeProperties: { borderRadius: 16, borderDashes: [6, 3] },
          color: {
            background: "rgba(80,7,36,0.96)",
            border: KT_COLOR,
            highlight: { background: hexA(KT_COLOR, 0.4), border: "#ffffff" },
            hover: { background: hexA(KT_COLOR, 0.3), border: KT_COLOR },
          },
          font: { size: NODE_FONT, color: "#fce7f3",
            face: "-apple-system, Hiragino Sans, Noto Sans JP, Noto Sans CJK JP, sans-serif", multi: false },
          shadow: false,
        };
      }
      return {
        id: it.id,
        label: shortDate(it.date) + (it.posts && it.posts.length ? " ▶" : "") + "\n" + vtrunc(it.title, LABEL_UNITS),
        shape: "box",
        margin: { top: 10, right: 12, bottom: 10, left: 12 },
        widthConstraint: { maximum: 170 },
        borderWidth: latest ? 3 : 2,
        shapeProperties: { borderRadius: 10 },
        color: {
          background: "rgba(22,29,38,0.96)",
          border: g.color,
          highlight: { background: hexA(g.color, 0.35), border: "#ffffff" },
          hover: { background: hexA(g.color, bgAlpha + 0.1), border: g.color },
        },
        font: {
          size: NODE_FONT,
          color: latest ? "#ffffff" : rec > 0.5 ? "#e2e8f0" : "#cbd5e1",
          face: "-apple-system, Hiragino Sans, Noto Sans JP, Noto Sans CJK JP, sans-serif",
          multi: false,
        },
        shadow: latest ? { enabled: true, color: hexA(g.color, 0.55), size: 14, x: 0, y: 0 } : false,
      };
    });
  }

  function buildEdges() {
    return state.links.filter(function (L) { return state.showWeak || !isWeak(L); }).map(function (L) {
      var c = TYPE_COLORS[L.type] || TYPE_COLORS.related;
      var conf = Math.max(0, Math.min(1, L.confidence));
      var op = 0.25 + 0.75 * conf;
      var strong = conf >= 0.6;
      if (L.type === "confusable") {
        return {
          id: L.id, from: L.from, to: L.to,
          label: L.label ? truncate(L.label, 16) : undefined,
          width: 2.5,
          color: { color: hexA(c, 0.9), highlight: c, hover: c },
          dashes: [5, 7],
          font: { size: EDGE_FONT, color: "#e9d5ff", strokeWidth: 4, strokeColor: "#0f1419", align: "horizontal",
            face: "-apple-system, Hiragino Sans, Noto Sans JP, Noto Sans CJK JP, sans-serif" },
          smooth: { enabled: true, type: "curvedCW", roundness: 0.3 },
          selectionWidth: 2,
        };
      }
      return {
        id: L.id,
        from: L.from,
        to: L.to,
        label: strong && L.label ? truncate(L.label, 16) : undefined,
        arrows: L.type === "causes" || L.type === "leads_to" ? { to: { enabled: true, scaleFactor: 0.7 } } : undefined,
        width: 1 + conf * 5,
        color: { color: hexA(c, op), highlight: c, hover: c },
        dashes: L.auto && conf < 0.5 ? [6, 6] : false,
        font: { size: EDGE_FONT, color: "#e2e8f0", strokeWidth: 4, strokeColor: "#0f1419", align: "horizontal",
          face: "-apple-system, Hiragino Sans, Noto Sans JP, Noto Sans CJK JP, sans-serif" },
        smooth: { enabled: true, type: "continuous", roundness: 0.35 },
        selectionWidth: 2,
      };
    });
  }

  // Physics layouts are roughly round; phones are tall. Stretch the layout
  // vertically to match the viewport aspect (only increases distances, so no new overlaps).
  function stretchToViewport() {
    var net = state.network, pos = net.getPositions(), ids = Object.keys(pos);
    if (ids.length < 3) return;
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    ids.forEach(function (id) {
      var b = net.getBoundingBox(id);
      minX = Math.min(minX, b.left); maxX = Math.max(maxX, b.right);
      minY = Math.min(minY, b.top); maxY = Math.max(maxY, b.bottom);
    });
    var el = $("#graph"), vw = el.clientWidth || 1, vh = el.clientHeight || 1;
    var want = (vh / vw) * 0.95, have = (maxY - minY) / Math.max(1, maxX - minX);
    if (have >= want) return;
    var k = Math.min(2.6, want / have), cy = (minY + maxY) / 2;
    ids.forEach(function (id) { net.moveNode(id, pos[id].x, cy + (pos[id].y - cy) * k); });
  }

  // Push apart any overlapping node boxes (physics only approximates boxes as circles).
  function resolveOverlaps() {
    var net = state.network, ids = state.items.map(function (it) { return it.id; }), PAD = 14;
    var boxes = ids.map(function (id) {
      var b = net.getBoundingBox(id), p = net.getPosition(id);
      return { id: id, x: p.x, y: p.y, hw: (b.right - b.left) / 2 + PAD / 2, hh: (b.bottom - b.top) / 2 + PAD / 2 };
    });
    for (var iter = 0; iter < 80; iter++) {
      var moved = false;
      for (var i = 0; i < boxes.length; i++) {
        for (var j = i + 1; j < boxes.length; j++) {
          var a = boxes[i], b = boxes[j];
          var ox = a.hw + b.hw - Math.abs(a.x - b.x), oy = a.hh + b.hh - Math.abs(a.y - b.y);
          if (ox <= 0 || oy <= 0) continue;
          moved = true;
          if (oy <= ox) { var dy = (oy / 2 + 0.5) * (a.y <= b.y ? 1 : -1); a.y -= dy; b.y += dy; }
          else { var dx = (ox / 2 + 0.5) * (a.x <= b.x ? 1 : -1); a.x -= dx; b.x += dx; }
        }
      }
      if (!moved) break;
    }
    boxes.forEach(function (b) { net.moveNode(b.id, b.x, b.y); });
  }

  // Fit everything; if labels would be too small, zoom to a readable scale
  // centred on the latest day's items (pinch out or tap 「全体」 for the overview).
  function initialView() {
    var net = state.network;
    fitAll(false);
    if (net.getScale() >= MIN_INITIAL_SCALE) return;
    var pts = state.items.filter(function (it) { return it.date === state.latest; }).map(function (it) { return net.getPosition(it.id); });
    if (!pts.length) pts = [net.getViewPosition()];
    var cx = 0, cy = 0;
    pts.forEach(function (p) { cx += p.x; cy += p.y; });
    net.moveTo({ position: { x: cx / pts.length, y: cy / pts.length }, scale: MIN_INITIAL_SCALE, animation: false });
  }

  // Keep the tapped node visible above the bottom sheet.
  function ensureVisible(id) {
    var net = state.network, el = $("#graph");
    var p = net.canvasToDOM(net.getPosition(id));
    var r = el.getBoundingClientRect();
    var sheetTop = window.innerHeight - ($("#sheet").getBoundingClientRect().height || window.innerHeight * 0.6);
    var visBottom = sheetTop - r.top - 24, visTop = 24;
    if (p.y > visTop && p.y < visBottom && p.x > 20 && p.x < r.width - 20) return;
    var target = { x: r.width / 2, y: Math.max(visTop + 40, (visTop + visBottom) / 2) };
    var s = net.getScale(), c = net.getPosition(id);
    net.moveTo({
      position: { x: c.x - (target.x - r.width / 2) / s, y: c.y - (target.y - r.height / 2) / s },
      scale: s, animation: { duration: 300, easingFunction: "easeInOutQuad" },
    });
  }

  function fitAll(animate) {
    if (!state.network) return;
    state.network.fit({ animation: animate ? { duration: 350, easingFunction: "easeInOutQuad" } : false });
  }

  function render() {
    var container = $("#graph");
    state.nodes = new vis.DataSet(buildNodes());
    state.edges = new vis.DataSet(buildEdges());
    var options = {
      autoResize: true,
      layout: { randomSeed: 7, improvedLayout: true },
      physics: {
        enabled: true,
        solver: "forceAtlas2Based",
        forceAtlas2Based: { gravitationalConstant: -90, centralGravity: 0.03, springLength: 130, springConstant: 0.08, avoidOverlap: 1 },
        stabilization: { enabled: true, iterations: 500, updateInterval: 50, fit: true },
      },
      interaction: {
        dragNodes: false, dragView: true, zoomView: true, hover: false,
        selectConnectedEdges: true, tooltipDelay: 999999, navigationButtons: false, keyboard: false,
        zoomSpeed: 0.8,
      },
      nodes: { chosen: true },
      edges: { chosen: true },
    };
    state.network = new vis.Network(container, { nodes: state.nodes, edges: state.edges }, options);
    state.network.once("stabilizationIterationsDone", function () {
      state.network.setOptions({ physics: { enabled: false } });
      stretchToViewport();
      resolveOverlaps();
      initialView();
      $("#status").textContent = "";
      document.body.setAttribute("data-ready", "1");
    });
    state.network.on("click", function (p) {
      if (p.nodes && p.nodes.length) openSheet(p.nodes[0]);
      else if (!p.edges || !p.edges.length) closeSheet();
    });
    // read-only debug hook (used by scripts/shot_pwa.py)
    window.__tnm = { network: state.network, open: openSheet };
  }

  function refreshEdges() {
    if (!state.edges) return;
    state.edges.clear();
    state.edges.add(buildEdges());
  }

  function connectionsOf(id) {
    var out = [];
    state.links.forEach(function (L) {
      if (L.from !== id && L.to !== id) return;
      var other = L.from === id ? L.to : L.from;
      var it = state.byId[other];
      if (!it) return;
      var dir = L.type === "causes" || L.type === "leads_to" ? (L.from === id ? "→" : "←") : "↔"; // confusable: ↔
      out.push({ L: L, it: it, dir: dir });
    });
    out.sort(function (a, b) {
      if (a.L.auto !== b.L.auto) return a.L.auto ? 1 : -1;
      return b.L.confidence - a.L.confidence;
    });
    return out;
  }

  function openSheet(id, opts) {
    var it = state.byId[id];
    if (!it) return;
    var g = groupOf(it);
    var conns = connectionsOf(id);
    var html = "";
    html += '<div class="date"><span>' + esc(it.date) + "</span>" +
      (isKt(it) ? '<span class="chip kt">▶ これだけテック投稿</span>' : '<span class="chip" style="background:' + g.color + '">' + esc(g.name) + "</span>") +
      (it.ai === true ? '<span class="chip ai">AI</span>' : it.ai === false ? '<span class="chip nonai">AI以外</span>' : "") +
      (!isKt(it) && it.posts && it.posts.length ? '<span class="chip posted">▶ 投稿済</span>' : "") + "</div>";
    html += "<h2>" + esc(it.title) + "</h2>";
    if (it.summary) html += '<p class="summary">' + esc(it.summary) + "</p>";
    if (isKt(it)) {
      var kt = [];
      if (it.cover_title) kt.push("カバー: 「" + esc(it.cover_title) + "」");
      if (it.video) kt.push("動画: " + esc(it.video));
      if (it.credit) kt.push("クレジット: " + esc(it.credit));
      if (kt.length) html += '<div class="ktbox">' + kt.join("<br>") + "</div>";
    }
    var hn = it.hook_names || [];
    if (hn.length || it.hook_contrast) {
      html += '<div class="hook"><div class="hh">カバー用</div>';
      if (hn.length) html += '<div>具体名: ' + hn.slice(0, 2).map(function (n) { return '<b class="hn">' + esc(n) + "</b>"; }).join(" ") + "</div>";
      if (it.hook_contrast) html += "<div>対比: " + esc(it.hook_contrast) + "</div>";
      html += "</div>";
    }
    if (!isKt(it) && it.posts && it.posts.length) {
      html += '<div class="posted-list">' + it.posts.map(function (p) {
        return "▶ " + esc(p.post_date ? shortDate(p.post_date) : "日付不明") + "「" + esc(p.title) + "」";
      }).join("<br>") + "</div>";
    }
    var meta = [];
    if (it.entities && it.entities.length) meta.push("関係: " + it.entities.map(esc).join("、"));
    if (it.themes && it.themes.length) meta.push("テーマ: " + it.themes.map(esc).join(" / "));
    if (it.source) meta.push("出典: " + esc(it.source));
    if (meta.length) html += '<div class="meta">' + meta.join("<br>") + "</div>";
    html += "<h3>つながり（" + conns.length + "件）</h3>";
    if (!conns.length) {
      html += '<p class="empty">リンクはまだありません。</p>';
    } else {
      html += '<ul class="conn">';
      conns.forEach(function (c) {
        var col = TYPE_COLORS[c.L.type] || TYPE_COLORS.related;
        var weak = isWeak(c.L);
        html += '<li><button type="button" data-jump="' + esc(c.it.id) + '"' + (weak ? ' class="weak"' : "") + ">" +
          '<div class="rel"><b style="color:' + col + '">' + c.dir + " " + esc(TYPE_LABELS[c.L.type] || c.L.type) + "</b>" +
          "<span>信頼度 " + c.L.confidence.toFixed(2) + (c.L.auto ? "（自動）" : "（手動）") + "</span>" +
          (c.L.label ? "<span>· " + esc(c.L.label) + "</span>" : "") + "</div>" +
          '<div class="t">' + esc(shortDate(c.it.date)) + "　" + esc(c.it.title) + "</div>" +
          (c.L.contrast ? '<div class="contrast">違い: ' + esc(c.L.contrast) + "</div>" : "") +
          "</button></li>";
      });
      html += "</ul>";
    }
    var body = $("#sheet-body");
    body.innerHTML = html;
    body.scrollTop = 0;
    var sheet = $("#sheet");
    sheet.classList.add("open");
    sheet.setAttribute("aria-hidden", "false");
    state.network.selectNodes([id], true);
    if (opts && opts.center) return;
    requestAnimationFrame(function () { ensureVisible(id); });
  }

  function closeSheet() {
    var sheet = $("#sheet");
    sheet.classList.remove("open");
    sheet.setAttribute("aria-hidden", "true");
    if (state.network) state.network.unselectAll();
  }

  function jumpTo(id) {
    if (!state.network || !state.byId[id]) return;
    var scale = Math.max(state.network.getScale(), 0.9);
    var sheetH = $("#sheet").getBoundingClientRect().height || 0;
    openSheet(id, { center: true });
    state.network.focus(id, {
      scale: scale,
      offset: { x: 0, y: -Math.min(sheetH / 2, window.innerHeight * 0.3) },
      animation: { duration: 400, easingFunction: "easeInOutQuad" },
    });
  }

  function renderLegend() {
    var used = {};
    state.items.forEach(function (it) { used[groupOf(it).key] = true; });
    var html = GROUPS.concat([OTHER]).filter(function (g) { return used[g.key]; }).map(function (g) {
      return '<span><i style="background:' + g.color + '"></i>' + esc(g.short) + "</span>";
    }).join("");
    if (state.items.some(isKt)) html += '<span><i class="kt"></i>▶ 投稿回</span>';
    if (state.links.some(function (L) { return L.type === "confusable"; })) {
      html += '<span><i class="dash"></i>似て聞こえる</span>';
    }
    $("#legend").innerHTML = html;
  }

  function load() {
    return fetch("data/graph.json", { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  function init(data) {
    state.items = data.items || [];
    state.links = (data.links || []).map(function (L) { L.confidence = +L.confidence || 0; return L; });
    state.byId = {};
    var times = [];
    state.items.forEach(function (it) { state.byId[it.id] = it; var t = Date.parse(it.date); if (!isNaN(t)) times.push(t); });
    state.minT = Math.min.apply(null, times);
    state.maxT = Math.max.apply(null, times);
    state.latest = data.lastUpdated || state.items.reduce(function (m, it) { return it.date > m ? it.date : m; }, "");
    $("#updated").textContent = "最終更新: " + (state.latest || "—");
    renderLegend();
    render();
  }

  // UI wiring
  $("#weak").addEventListener("change", function (e) { state.showWeak = e.target.checked; refreshEdges(); });
  $("#fit").addEventListener("click", function () { fitAll(true); });
  $("#sheet-close").addEventListener("click", closeSheet);
  $("#sheet-body").addEventListener("click", function (e) {
    var b = e.target.closest("[data-jump]");
    if (b) jumpTo(b.getAttribute("data-jump"));
  });
  // swipe down on grabber area to close
  (function () {
    var y0 = null;
    var sheet = $("#sheet");
    sheet.addEventListener("touchstart", function (e) {
      y0 = ($("#sheet-body").scrollTop <= 0) ? e.touches[0].clientY : null;
    }, { passive: true });
    sheet.addEventListener("touchend", function (e) {
      if (y0 == null) return;
      var dy = e.changedTouches[0].clientY - y0;
      if (dy > 70) closeSheet();
      y0 = null;
    }, { passive: true });
  })();

  if (typeof vis === "undefined") {
    $("#status").textContent = "グラフライブラリを読み込めませんでした。";
    return;
  }
  load().then(init).catch(function (err) {
    console.warn("graph load failed", err);
    $("#status").textContent = "データを読み込めませんでした。\n通信状況を確認してください。";
  });

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js", { scope: "./" }).catch(function (e) {
        console.warn("SW registration failed", e);
      });
    });
  }
})();
