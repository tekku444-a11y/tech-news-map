/* テックニュース相関図 — view-only PWA (3 levels)
 *  1) #/            theme bubbles (count + cross-theme link counts)
 *  2) #/t/<theme>   that theme's items, newest on top + dimmed directly-linked items of other themes
 *  3) #/t/<theme>/i/<id>  (or #/i/<id>)  focus: item + direct neighbours, detail sheet
 * Browser back works through the hash history. Weak links (auto, confidence < 0.4) are hidden
 * unless 「弱いリンクも」 is on; the period filter (全期間 / 直近2週間) applies at every level.
 */
(function () {
  "use strict";

  var WEAK_THRESHOLD = 0.4;
  var RECENT_DAYS = 14;
  var FACE = "-apple-system, Hiragino Sans, Hiragino Kaku Gothic ProN, Noto Sans JP, Noto Sans CJK JP, sans-serif";

  var TYPE_COLORS = { causes: "#ef4444", leads_to: "#f59e0b", same_arc: "#3b82f6", related: "#94a3b8", confusable: "#c084fc" };
  var TYPE_LABELS = { causes: "因果", leads_to: "波及", same_arc: "同じ流れ", related: "関連", confusable: "似て聞こえる" };
  var KT_COLOR = "#f472b6"; // これだけテック投稿回 (kind: koredake_post)
  var OTHER = { key: "other", name: "その他", short: "その他", color: "#94a3b8" };

  var $ = function (s) { return document.querySelector(s); };
  var SIDE_PANEL = window.matchMedia("(min-width: 900px) and (min-height: 500px)"); // keep in sync with app.css
  var state = {
    items: [], links: [], byId: {}, themes: [], themeBy: {}, latest: "", cutoff: "",
    showWeak: false, period: "all", view: { level: "overview" }, network: null, sheetMin: false,
    overview: null, token: 0,
  };

  // ------------------------------------------------------------------ helpers
  function isKt(it) { return !!it && it.kind === "koredake_post"; }
  function hasAddenda(it) { return !!it && Array.isArray(it.addenda) && it.addenda.length > 0; }
  // hand-written follow-up notes (items.addenda): labeled box, one <p> per line, source links
  function addendaHtml(it) {
    if (!hasAddenda(it)) return "";
    return it.addenda.map(function (a) {
      var paras = String(a.body || "").split(/\r?\n/).filter(function (x) { return x.trim(); });
      var srcs = (a.sources || []).filter(function (x) { return x && /^https?:\/\//.test(x.url || ""); });
      return '<section class="addendum"><div class="ah"><b>追加情報</b>' + (a.date ? "<span>" + esc(a.date) + "</span>" : "") + "</div>" +
        (a.title ? "<h4>" + esc(a.title) + "</h4>" : "") +
        paras.map(function (x) { return "<p>" + esc(x) + "</p>"; }).join("") +
        (srcs.length ? '<div class="src">出典: ' + srcs.map(function (x) {
          return '<a href="' + esc(x.url) + '" target="_blank" rel="noopener">' + esc(x.label || x.url) + "</a>";
        }).join("、") + "</div>" : "") + "</section>";
    }).join("");
  }
  function isWeak(L) { return L.auto && L.confidence < WEAK_THRESHOLD; }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function shortDate(d) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || "");
    return m ? (+m[2]) + "/" + (+m[3]) : d;
  }
  // Truncate by visual width: CJK/full-width = 2, others = 1
  function vtrunc(s, units) {
    s = String(s || ""); var w = 0, out = "";
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i), cw = /[\u0000-\u00ff\uff61-\uff9f]/.test(ch) ? 1 : 2;
      if (w + cw > units) return out.replace(/[\s：:・、,（(]+$/, "") + "…";
      w += cw; out += ch;
    }
    return out;
  }
  function stripKt(title) { return String(title || "").replace(/^これだけテック[:：]\s*/, ""); }
  function hexA(hex, a) {
    var h = String(hex || "#94a3b8").replace("#", "");
    var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return "rgba(" + r + "," + g + "," + b + "," + a + ")";
  }
  function themeOf(it) { return state.themeBy[it && it.theme] || state.themeBy.other || OTHER; }
  function inPeriod(it) { return state.period === "all" || it.date >= state.cutoff; }
  function linkShown(L) { return state.showWeak || !isWeak(L); }
  function byNewest(a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); }
  function addDays(iso, n) {
    var t = Date.parse(iso + "T00:00:00Z"); if (isNaN(t)) return "";
    return new Date(t + n * 86400000).toISOString().slice(0, 10);
  }
  function nodeFont(size, color, tagColor) {
    var f = { size: size, color: color, face: FACE, multi: tagColor ? "html" : false };
    if (tagColor) f.bold = { color: tagColor, size: size - 2, face: FACE, mod: "bold" };
    return f;
  }
  function htmlSafe(s) { return String(s || "").replace(/[<>]/g, " "); }

  // Links touching `id` that pass the weak toggle and period filter (other end in period).
  function connectionsOf(id) {
    var out = [], hiddenWeak = 0, hiddenPeriod = 0;
    state.links.forEach(function (L) {
      if (L.from !== id && L.to !== id) return;
      var other = state.byId[L.from === id ? L.to : L.from];
      if (!other) return;
      if (!linkShown(L)) { hiddenWeak++; return; }
      if (!inPeriod(other)) { hiddenPeriod++; return; }
      var dir = L.type === "causes" || L.type === "leads_to" ? (L.from === id ? "→" : "←") : "↔";
      out.push({ L: L, it: other, dir: dir });
    });
    out.sort(function (a, b) {
      if (a.L.auto !== b.L.auto) return a.L.auto ? 1 : -1;
      return b.L.confidence - a.L.confidence;
    });
    return { list: out, hiddenWeak: hiddenWeak, hiddenPeriod: hiddenPeriod };
  }

  // ------------------------------------------------------------------ routing
  function hashFor(v) {
    if (v.level === "theme") return "#/t/" + encodeURIComponent(v.theme);
    if (v.level === "item") return (v.theme ? "#/t/" + encodeURIComponent(v.theme) : "") + "/i/" + encodeURIComponent(v.item);
    return "#/";
  }
  function go(v) {
    var h = hashFor(v);
    if (h.charAt(0) !== "#") h = "#" + h;
    if (location.hash === h) route(); else location.hash = h;
  }
  function parseHash() {
    var h = (location.hash || "").replace(/^#\/?/, "");
    var m = /^t\/([^/]+)\/i\/(.+)$/.exec(h);
    if (m) return { level: "item", theme: decodeURIComponent(m[1]), item: decodeURIComponent(m[2]) };
    m = /^i\/(.+)$/.exec(h);
    if (m) return { level: "item", theme: null, item: decodeURIComponent(m[1]) };
    m = /^t\/([^/]+)$/.exec(h);
    if (m) return { level: "theme", theme: decodeURIComponent(m[1]) };
    return { level: "overview" };
  }
  function route() {
    if (!state.network) return;
    var v = parseHash();
    if (v.level === "item") {
      var it = state.byId[v.item];
      if (!it) v = { level: "overview" };
      else if (!v.theme || !state.themeBy[v.theme]) v.theme = themeOf(it).key;
    }
    if (v.level === "theme" && !state.themeBy[v.theme]) v = { level: "overview" };
    state.view = v;
    render();
  }
  function parentOf(v) {
    if (v.level === "item") return { level: "theme", theme: v.theme };
    return { level: "overview" };
  }

  // ------------------------------------------------------------------ header / chrome
  function setChrome() {
    var v = state.view, th = v.theme ? state.themeBy[v.theme] : null;
    document.body.setAttribute("data-view", v.level);
    $("#back").hidden = v.level === "overview";
    $("#back").setAttribute("aria-label", v.level === "item" ? (th ? th.name + " に戻る" : "戻る") : "テーマ一覧に戻る");
    var crumb = "";
    if (v.level !== "overview") {
      crumb += '<button type="button" data-go="overview">全体</button>';
      if (v.level === "item" && th) {
        crumb += '<span class="sep">›</span><button type="button" data-go="theme">' + esc(th.name) + "</button>";
      }
    }
    $("#crumb").innerHTML = crumb;
    var title = "テーマ一覧";
    if (v.level === "theme" && th) title = th.name;
    if (v.level === "item") { var it = state.byId[v.item]; title = shortDate(it.date) + " " + (isKt(it) ? "▶ " + stripKt(it.title) : it.title); }
    $("#title").textContent = title;
    document.title = (v.level === "overview" ? "" : title + " — ") + "テックニュース相関図";
    var hint = $("#hint");
    hint.style.top = ($("#hdr").getBoundingClientRect().bottom + 6) + "px";
  }

  // ------------------------------------------------------------------ rendering core
  function makeNetwork() {
    var net = new vis.Network($("#graph"), { nodes: [], edges: [] }, {
      autoResize: true,
      layout: { improvedLayout: false },
      physics: { enabled: false },
      interaction: {
        dragNodes: false, dragView: true, zoomView: true, hover: false, selectable: true,
        selectConnectedEdges: false, tooltipDelay: 999999, navigationButtons: false, keyboard: false, zoomSpeed: 0.8,
      },
      nodes: { chosen: false }, edges: { chosen: false },
    });
    net.on("click", onTap);
    net.on("afterDrawing", afterDrawing);
    net.on("beforeDrawing", beforeDrawing);
    return net;
  }

  function render() {
    var v = state.view, token = ++state.token;
    setChrome();
    var built = v.level === "theme" ? buildTheme(v.theme) : v.level === "item" ? buildFocus(v.item) : buildOverview();
    state.built = built;
    showSheet(v.level === "item");
    if (v.level === "item") fillSheet(v.item);
    $("#hint").innerHTML = built.hint || "";
    $("#status").textContent = built.empty || "";
    var g = $("#graph");
    g.classList.add("laying");
    document.body.removeAttribute("data-ready");
    state.network.setData({ nodes: new vis.DataSet(built.nodes), edges: new vis.DataSet(built.edges) });
    state.network.once("afterDrawing", function () {
      // node sizes are known after the first draw -> final layout, then frame it
      setTimeout(function () {
        if (token !== state.token) return;
        if (built.relayout) built.relayout(state.network);
        frame(false);
        g.classList.remove("laying");
        document.body.setAttribute("data-ready", "1");
      }, 0);
    });
    state.network.redraw();
  }

  // Visible map rectangle (graph element minus the detail sheet when open).
  function visibleRect() {
    var g = $("#graph").getBoundingClientRect();
    var r = { x: 0, y: 0, w: g.width, h: g.height };
    var hint = $("#hint");
    if (hint.innerHTML) { var hb = hint.getBoundingClientRect(); var top = Math.max(0, hb.bottom - g.top + 4); r.y = top; r.h -= top; }
    if (state.built && state.built.reserveBottom) r.h -= state.built.reserveBottom; // keep clear of 「全体表示」
    var sh = $("#sheet");
    if (sh.classList.contains("open")) { // final geometry (offset* ignores the slide-in transform)
      if (SIDE_PANEL.matches) r.w = Math.min(r.w, window.innerWidth - sh.offsetWidth - g.left);
      else r.h = Math.min(r.h, window.innerHeight - sh.offsetHeight - g.top - r.y);
    }
    return r;
  }

  // Node size (canvas units). vis only refreshes bounding boxes on redraw, so combine the
  // size with the live position (moveNode() positions are current immediately).
  function nodeSize(net, id) {
    if (state.built.sizeOf) return state.built.sizeOf(id);
    var bb = net.getBoundingBox(id);
    return bb ? { w: bb.right - bb.left, h: bb.bottom - bb.top } : { w: 0, h: 0 };
  }
  function nodesBBox(net) {
    var ids = state.built.nodes.map(function (n) { return n.id; }), pos = net.getPositions(ids);
    var b = { l: Infinity, r: -Infinity, t: Infinity, b: -Infinity };
    ids.forEach(function (id) {
      var p = pos[id], sz = nodeSize(net, id); if (!p) return;
      b.l = Math.min(b.l, p.x - sz.w / 2); b.r = Math.max(b.r, p.x + sz.w / 2);
      b.t = Math.min(b.t, p.y - sz.h / 2); b.b = Math.max(b.b, p.y + sz.h / 2);
    });
    if (state.built.extraLeft) b.l -= state.built.extraLeft;
    return b;
  }

  // Frame the current view: fit into the visible rect; theme view fits width and starts at the top.
  function frame(animate) {
    var net = state.network; if (!net || !state.built || !state.built.nodes.length) return;
    var el = $("#graph"), W = el.clientWidth, H = el.clientHeight;
    var r = visibleRect(), pad = 12, b = nodesBBox(net);
    if (!isFinite(b.l)) return;
    var bw = b.r - b.l, bh = b.b - b.t;
    var maxScale = state.built.maxScale || 1.25;
    var sx = (r.w - 2 * pad) / Math.max(1, bw), sy = (r.h - 2 * pad) / Math.max(1, bh);
    var s = state.built.fitWidth ? Math.min(sx, maxScale) : Math.min(sx, sy, maxScale);
    var cx = (b.l + b.r) / 2, cy;
    if (state.built.fitWidth && bh * s > r.h - 2 * pad) cy = b.t + (r.h / 2 - pad) / s;  // top-aligned (newest first)
    else cy = (b.t + b.b) / 2;
    // canvas centre maps to element centre; shift so the bbox centre lands in the visible rect's centre
    var dx = (r.x + r.w / 2) - W / 2, dy = (r.y + r.h / 2) - H / 2;
    net.moveTo({ position: { x: cx - dx / s, y: cy - dy / s }, scale: s,
      animation: animate ? { duration: 300, easingFunction: "easeInOutQuad" } : false });
  }

  function onTap(p) {
    var v = state.view;
    if (!p.nodes || !p.nodes.length) return;
    var id = p.nodes[0];
    state.network.unselectAll();
    if (v.level === "overview") return go({ level: "theme", theme: id });
    if (v.level === "theme") return go({ level: "item", theme: v.theme, item: id });
    if (v.level === "item") {
      if (id === v.item) { setSheetMin(!state.sheetMin); return; }
      return go({ level: "item", theme: v.theme, item: id });
    }
  }

  function afterDrawing(ctx) {
    if (state.built && state.built.afterDrawing) state.built.afterDrawing(ctx, state.network);
  }
  function beforeDrawing(ctx) {
    if (state.built && state.built.beforeDrawing) state.built.beforeDrawing(ctx, state.network);
  }

  // ------------------------------------------------------------------ level 1: theme bubbles
  function bubbleRadius(n) { return 46 + 12 * Math.sqrt(n); }

  // Order bubbles around the ellipse so strongly linked themes sit next to each other
  // (minimise sum(weight x ring distance); deterministic, brute force for <= 9 themes).
  function orderThemes(keys, pairW) {
    var n = keys.length;
    if (n <= 3) return keys.slice();
    function w(a, b) { return pairW[a < b ? a + "|" + b : b + "|" + a] || 0; }
    function cost(order) {
      var c = 0;
      for (var i = 0; i < n; i++) for (var j = i + 1; j < n; j++) {
        var ww = w(order[i], order[j]); if (!ww) continue;
        var d = Math.abs(i - j); c += ww * Math.min(d, n - d);
      }
      return c;
    }
    if (n > 9) return keys.slice();
    var best = keys.slice(), bestC = cost(best), rest = keys.slice(1), used = [], cur = [keys[0]];
    (function perm() {
      if (cur.length === n) { var c = cost(cur); if (c < bestC) { bestC = c; best = cur.slice(); } return; }
      for (var i = 0; i < rest.length; i++) {
        if (used[i]) continue;
        used[i] = true; cur.push(rest[i]); perm(); cur.pop(); used[i] = false;
      }
    })();
    return best;
  }

  function ellipsePoints(radii, portrait) {
    var n = radii.length;
    if (n === 1) return [{ x: 0, y: 0 }];
    var GAP = 34, need = 0; for (var i = 0; i < n; i++) need += radii[i] + radii[(i + 1) % n] + GAP;
    var k = portrait ? 1.75 : 0.62; // ry / rx
    // perimeter ~ 2*pi*sqrt((rx^2+ry^2)/2)
    var rx = need / (2 * Math.PI * Math.sqrt((1 + k * k) / 2));
    if (n === 2) rx = Math.max(rx, (radii[0] + radii[1] + 30) / 2);
    var ry = rx * k;
    // sample the ellipse and place centres by arc length
    var S = 720, pts = [], len = [0];
    for (var s = 0; s <= S; s++) {
      var a = -Math.PI / 2 + (2 * Math.PI * s) / S;
      pts.push({ x: rx * Math.cos(a), y: ry * Math.sin(a) });
      if (s) len.push(len[s - 1] + Math.hypot(pts[s].x - pts[s - 1].x, pts[s].y - pts[s - 1].y));
    }
    var total = len[S], out = [], acc = 0;
    for (var j = 0; j < n; j++) {
      var target = (acc / need) * total, idx = 0;
      while (idx < S && len[idx] < target) idx++;
      out.push({ x: pts[idx].x, y: pts[idx].y });
      acc += radii[j] + radii[(j + 1) % n] + GAP;
    }
    // chords are shorter than arcs where the ellipse bends: push overlapping circles apart
    for (var it = 0; it < 200; it++) {
      var moved = false;
      for (var a = 0; a < n; a++) for (var b = a + 1; b < n; b++) {
        var dx = out[b].x - out[a].x, dy = out[b].y - out[a].y, d = Math.hypot(dx, dy) || 0.01;
        var ov = radii[a] + radii[b] + 16 - d;
        if (ov <= 0) continue;
        moved = true; dx /= d; dy /= d;
        out[a].x -= dx * ov / 2; out[a].y -= dy * ov / 2; out[b].x += dx * ov / 2; out[b].y += dy * ov / 2;
      }
      if (!moved) break;
    }
    return out;
  }

  function splitName(ctx, name, maxW) {
    if (ctx.measureText(name).width <= maxW || name.indexOf("・") < 0) return [name];
    var parts = name.split("・");
    // split into two lines at the "・" closest to the middle
    var best = null;
    for (var i = 1; i < parts.length; i++) {
      var a = parts.slice(0, i).join("・"), b = parts.slice(i).join("・");
      var m = Math.max(ctx.measureText(a).width, ctx.measureText(b).width);
      if (!best || m < best.m) best = { m: m, lines: [a, b] };
    }
    return best.lines;
  }

  function bubbleRenderer(th, count, fresh) {
    var r = bubbleRadius(count);
    return function (o) {
      var ctx = o.ctx, x = o.x, y = o.y;
      return {
        drawNode: function () {
          ctx.save();
          ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fillStyle = "#101821"; ctx.fill();
          ctx.fillStyle = hexA(th.color, 0.26); ctx.fill();
          ctx.lineWidth = 3.5; ctx.strokeStyle = th.color; ctx.stroke();
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          var fs = 23, maxW = r * 1.72, lines;
          for (; fs >= 14; fs--) {
            ctx.font = "700 " + fs + "px " + FACE;
            lines = splitName(ctx, th.name, maxW);
            var wmax = Math.max.apply(null, lines.map(function (l) { return ctx.measureText(l).width; }));
            if (wmax <= maxW) break;
          }
          var lh = fs * 1.22, cs = 32, blockH = lines.length * lh + cs * 1.05;
          var y0 = y - blockH / 2 + lh / 2;
          ctx.fillStyle = "#f8fafc";
          lines.forEach(function (l, i) { ctx.fillText(l, x, y0 + i * lh); });
          ctx.font = "800 " + cs + "px " + FACE;
          ctx.fillStyle = "#ffffff";
          var cy = y0 + lines.length * lh + cs * 0.42;
          ctx.fillText(String(count), x - 12, cy);
          var nw = ctx.measureText(String(count)).width;
          ctx.font = "700 17px " + FACE; ctx.fillStyle = "#cbd5e1";
          ctx.fillText("件", x - 12 + nw / 2 + 11, cy + 3);
          if (fresh) {
            var label = "新着 " + fresh;
            ctx.font = "800 15px " + FACE;
            var tw = ctx.measureText(label).width + 18, bx = x + r * 0.42, by = y - r * 0.86;
            ctx.beginPath();
            if (ctx.roundRect) ctx.roundRect(bx - tw / 2, by - 13, tw, 26, 13); else ctx.rect(bx - tw / 2, by - 13, tw, 26);
            ctx.fillStyle = "#fef08a"; ctx.fill();
            ctx.fillStyle = "#0f1419"; ctx.fillText(label, bx, by + 1);
          }
          ctx.restore();
        },
        nodeDimensions: { width: 2 * r, height: 2 * r },
      };
    };
  }

  function buildOverview() {
    var counts = {}, fresh = {};
    state.items.forEach(function (it) {
      if (!inPeriod(it)) return;
      var k = themeOf(it).key;
      counts[k] = (counts[k] || 0) + 1;
      if (it.date === state.latest) fresh[k] = (fresh[k] || 0) + 1;
    });
    var keys = state.themes.filter(function (t) { return counts[t.key]; }).map(function (t) { return t.key; });
    if (!keys.length) return { nodes: [], edges: [], empty: "この期間のニュースはありません。" };
    var pairW = {};
    state.links.forEach(function (L) {
      if (!linkShown(L) || L.type === "confusable") return;
      var a = state.byId[L.from], b = state.byId[L.to];
      if (!a || !b || !inPeriod(a) || !inPeriod(b)) return;
      var ka = themeOf(a).key, kb = themeOf(b).key;
      if (ka === kb) return;
      var pk = ka < kb ? ka + "|" + kb : kb + "|" + ka;
      pairW[pk] = (pairW[pk] || 0) + 1;
    });
    var order = orderThemes(keys, pairW);
    var el = $("#graph"), portrait = el.clientHeight >= el.clientWidth * 1.05;
    var radii = order.map(function (k) { return bubbleRadius(counts[k]); });
    var pos = ellipsePoints(radii, portrait);
    var nodes = order.map(function (k, i) {
      return { id: k, x: pos[i].x, y: pos[i].y, shape: "custom", ctxRenderer: bubbleRenderer(state.themeBy[k], counts[k], fresh[k] || 0) };
    });
    // Lines are drawn by hand (beforeDrawing) so that non-adjacent pairs can bow toward the
    // empty centre instead of running behind the bubble between them.
    var badges = [], idx = {};
    order.forEach(function (k, i) { idx[k] = i; });
    Object.keys(pairW).forEach(function (pk) {
      var ab = pk.split("|"), d = Math.abs(idx[ab[0]] - idx[ab[1]]);
      badges.push({ a: ab[0], b: ab[1], n: pairW[pk], adj: Math.min(d, order.length - d) <= 1 || order.length <= 3 });
    });
    var rOf = {}; order.forEach(function (k, i) { rOf[k] = radii[i]; });
    function geom(bd, P) {
      var A = P[bd.a], B = P[bd.b], M = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
      var C = bd.adj ? M : { x: M.x * 0.35, y: M.y * 0.35 }; // pull the control point toward (0,0)
      return { A: A, B: B, C: C, at: function (t) {
        var u = 1 - t; return { x: u * u * A.x + 2 * u * t * C.x + t * t * B.x, y: u * u * A.y + 2 * u * t * C.y + t * t * B.y };
      } };
    }
    function insideOther(pt, bd, P) {
      for (var k in rOf) {
        if (k === bd.a || k === bd.b) continue;
        if (Math.hypot(pt.x - P[k].x, pt.y - P[k].y) < rOf[k] + 12) return true;
      }
      return Math.hypot(pt.x - P[bd.a].x, pt.y - P[bd.a].y) < rOf[bd.a] + 6 || Math.hypot(pt.x - P[bd.b].x, pt.y - P[bd.b].y) < rOf[bd.b] + 6;
    }
    var total = 0; keys.forEach(function (k) { total += counts[k]; });
    return {
      nodes: nodes, edges: [], maxScale: 1.3, lines: badges.length, reserveBottom: 50,
      sizeOf: function (id) { return { w: 2 * rOf[id] + 8, h: 2 * rOf[id] + 8 }; },
      hint: "泡＝テーマ（数字＝件数・" + total + "件）　線の数字＝テーマをまたぐつながり<br>泡をタップ → そのテーマのニュース",
      beforeDrawing: function (ctx, net) {
        var P = net.getPositions(order);
        ctx.save(); ctx.lineCap = "round";
        badges.forEach(function (bd) {
          var g = geom(bd, P);
          ctx.beginPath(); ctx.moveTo(g.A.x, g.A.y); ctx.quadraticCurveTo(g.C.x, g.C.y, g.B.x, g.B.y);
          ctx.lineWidth = Math.min(12, 2.5 + 2.2 * (bd.n - 1)); ctx.strokeStyle = "rgba(203,213,225,0.55)"; ctx.stroke();
        });
        ctx.restore();
      },
      afterDrawing: function (ctx, net) {
        var P = net.getPositions(order);
        ctx.save();
        badges.forEach(function (bd) {
          var g = geom(bd, P), ts = [0.5, 0.44, 0.56, 0.38, 0.62, 0.32, 0.68, 0.26, 0.74], pt = g.at(0.5);
          for (var i = 0; i < ts.length; i++) { var q = g.at(ts[i]); if (!insideOther(q, bd, P)) { pt = q; break; } }
          var mx = pt.x, my = pt.y;
          ctx.beginPath(); ctx.arc(mx, my, 15, 0, 2 * Math.PI);
          ctx.fillStyle = "#0f1419"; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = "#cbd5e1"; ctx.stroke();
          ctx.font = "800 17px " + FACE; ctx.fillStyle = "#ffffff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillText(String(bd.n), mx, my + 1);
        });
        ctx.restore();
      },
    };
  }

  // ------------------------------------------------------------------ level 2: one theme
  var TW = 196, EW = 132, GAPX = 20; // label widths; boxes add ~22 (margins/border)

  function itemNode(it, opt) {
    var th = themeOf(it), latest = it.date === state.latest, ext = !!opt.ext, focus = !!opt.focus;
    var w = opt.width, fs = opt.font;
    var tagged = ext || !!opt.tag, tag = tagged ? "<b>" + htmlSafe(th.short) + "</b> " : "";
    var T = tagged ? htmlSafe : function (x) { return x; };
    var node = {
      id: it.id, x: opt.x || 0, y: opt.y || 0, shape: "box",
      margin: { top: 9, right: 11, bottom: 9, left: 11 },
      widthConstraint: { minimum: w, maximum: w },
      borderWidth: focus ? 4 : latest && !ext ? 3 : 2,
      shapeProperties: { borderRadius: 10 },
    };
    if (isKt(it)) {
      node.label = tag + "▶" + (tagged ? "" : " ") + shortDate(it.date) + (tagged ? "" : " 投稿回") + "\n" + T(vtrunc(it.cover_title || stripKt(it.title), opt.units));
      node.shapeProperties = { borderRadius: 16, borderDashes: [6, 3] };
      node.color = { background: ext ? "rgba(60,8,30,0.9)" : "rgba(80,7,36,0.96)", border: ext ? hexA(KT_COLOR, 0.6) : KT_COLOR };
      node.font = nodeFont(fs, ext ? "rgba(252,231,243,0.72)" : "#fce7f3", tagged ? hexA(th.color, ext ? 0.8 : 1) : null);
    } else {
      node.label = tag + shortDate(it.date) + (it.posts && it.posts.length ? " ▶" : "") + (latest && !ext ? " 新" : "") +
        (hasAddenda(it) && !ext && !opt.tag ? " 追加情報あり" : "") + "\n" + T(vtrunc(it.title, opt.units));
      node.color = { background: ext ? "rgba(18,24,32,0.92)" : focus ? hexA(th.color, 0.22) : "rgba(22,29,38,0.97)",
        border: ext ? hexA(th.color, 0.55) : th.color };
      node.font = nodeFont(fs, ext ? "rgba(203,213,225,0.8)" : "#f1f5f9", tagged ? hexA(th.color, ext ? 0.85 : 1) : null);
    }
    if ((latest && !ext) || focus) node.shadow = { enabled: true, color: hexA(isKt(it) ? KT_COLOR : th.color, 0.5), size: 14, x: 0, y: 0 };
    return node;
  }

  function linkEdge(L, opt) {
    var c = TYPE_COLORS[L.type] || TYPE_COLORS.related, conf = Math.max(0, Math.min(1, L.confidence));
    var e = { id: L.id, from: L.from, to: L.to, width: 1.5 + conf * 4, smooth: opt.smooth || false };
    if (L.type === "confusable") {
      e._conf = true; e.dashes = [6, 7]; e.width = 2.5; e.color = { color: hexA(c, opt.dim ? 0.6 : 0.9) };
      e.smooth = opt.smooth || { enabled: true, type: "curvedCW", roundness: 0.2 };
    } else {
      e.color = { color: hexA(c, (opt.dim ? 0.45 : 0.3 + 0.65 * conf)) };
      e.dashes = L.auto && conf < 0.5 ? [6, 6] : false;
      if (L.type === "causes" || L.type === "leads_to") e.arrows = { to: { enabled: true, scaleFactor: 0.75 } };
    }
    return e;
  }

  function buildTheme(key) {
    var th = state.themeBy[key];
    var mine = state.items.filter(function (it) { return themeOf(it).key === key && inPeriod(it); }).sort(byNewest);
    if (!mine.length) return { nodes: [], edges: [], empty: th.name + "\nこの期間のニュースはありません。\n「全期間」に切り替えてください。" };
    var inTheme = {}; mine.forEach(function (it, i) { inTheme[it.id] = i; });
    var ext = {}, edges = [], hasConf = false, hasKt = mine.some(isKt);
    state.links.forEach(function (L) {
      if (!linkShown(L)) return;
      var fa = L.from in inTheme, fb = L.to in inTheme;
      if (!fa && !fb) return;
      if (fa && fb) {
        var e = linkEdge(L, {}); e._intra = true; e.width = Math.min(e.width, 1.2 + 2.6 * L.confidence); edges.push(e); // arcs routed on the left in relayout
        if (L.type === "confusable") hasConf = true;
        return;
      }
      var oid = fa ? L.to : L.from, mid = fa ? L.from : L.to, o = state.byId[oid];
      if (!o || !inPeriod(o)) return;
      (ext[oid] = ext[oid] || { it: o, to: [] }).to.push(mid);
      edges.push(linkEdge(L, { dim: true }));
      if (L.type === "confusable") hasConf = true;
      if (isKt(o)) hasKt = true;
    });
    var extList = Object.keys(ext).map(function (k) { return ext[k]; });
    var colX = extList.length ? -(EW + GAPX) / 2 : 0, extX = colX + (TW + 22) / 2 + GAPX + (EW + 22) / 2;
    var nodes = mine.map(function (it, i) { return itemNode(it, { x: colX, y: i * 130, width: TW, font: 20, units: 36 }); });
    extList.forEach(function (e) { nodes.push(itemNode(e.it, { ext: true, x: extX, y: 0, width: EW, font: 16, units: 22 })); });
    var hint = "上ほど新しい（" + mine.length + "件）";
    if (extList.length) hint += "・右の薄い箱＝つながる他テーマ";
    if (hasKt) hint += '<br><i class="kt"></i>投稿回';
    if (hasConf) hint += (hasKt ? "　" : "<br>") + '<i class="dash"></i>似て聞こえる（中身は別）';
    return {
      nodes: nodes, edges: edges, fitWidth: true, maxScale: 1.15, hint: hint,
      relayout: function (net) {
        var top = 0, ys = {};
        mine.forEach(function (it) {
          var b = net.getBoundingBox(it.id), h = b.bottom - b.top;
          ys[it.id] = top + h / 2; net.moveNode(it.id, colX, ys[it.id]); top += h + 26;
        });
        var want = extList.map(function (e) {
          var s = 0; e.to.forEach(function (id) { s += ys[id]; });
          var b = net.getBoundingBox(e.it.id);
          return { id: e.it.id, y: s / e.to.length, h: b.bottom - b.top };
        }).sort(function (a, b) { return a.y - b.y || (a.id < b.id ? -1 : 1); });
        var bottom = -Infinity;
        want.forEach(function (w) {
          var y = Math.max(w.y, bottom + 14 + w.h / 2);
          net.moveNode(w.id, extX, y); bottom = y + w.h / 2;
        });
        // in-theme links: arcs that bulge to the LEFT of the column, peaking just outside the boxes
        var ups = [];
        edges.forEach(function (e) {
          if (!e._intra) return;
          var l = Math.abs(ys[e.from] - ys[e.to]) || 1, down = ys[e.from] < ys[e.to];
          if (Math.abs(inTheme[e.from] - inTheme[e.to]) === 1 && !e._conf) {
            ups.push({ id: e.id, smooth: false }); return; // neighbouring rows: short straight line
          }
          ups.push({ id: e.id, smooth: { enabled: true, type: down ? "curvedCCW" : "curvedCW", roundness: arcRoundness(l, (TW + 22) / 2 + 14) } });
        });
        if (ups.length) net.body.data.edges.update(ups);
      },
      extraLeft: 16,
    };
  }

  // vis curvedCW/CCW: control point at f*l from `from`, rotated by A*pi/2 (f = 0.5A + 0.5);
  // the quadratic curve's max offset from the chord is 0.5*f*l*sin(A*pi/2). Solve A for `dev`.
  function arcRoundness(l, dev) {
    var lo = 0, hi = 1;
    if (0.5 * l < dev) return 1;
    for (var i = 0; i < 24; i++) {
      var A = (lo + hi) / 2, d = 0.5 * (0.5 * A + 0.5) * l * Math.sin(A * Math.PI / 2);
      if (d < dev) lo = A; else hi = A;
    }
    return (lo + hi) / 2;
  }

  // ------------------------------------------------------------------ level 3: focus on one item
  var NW = 140;

  function buildFocus(id) {
    var it = state.byId[id], conns = connectionsOf(id).list;
    var seen = {}, later = [], earlier = [];
    conns.forEach(function (c) {
      if (seen[c.it.id]) return; seen[c.it.id] = true;
      (c.it.date > it.date ? later : earlier).push(c.it);
    });
    // same-day neighbours: move to the lighter side
    earlier.sort(byNewest); later.sort(byNewest);
    while (earlier.length > later.length + 1 && earlier[0].date === it.date) later.push(earlier.shift());
    var nodes = [itemNode(it, { focus: true, x: 0, y: 0, width: 206, font: 19, units: 40 })];
    function perRowOf(list) { return list.length <= 4 ? 2 : list.length <= 9 ? 3 : 4; }
    later.concat(earlier).forEach(function (n) {
      nodes.push(itemNode(n, { tag: true, x: 0, y: 0, width: NW, font: 16, units: 24 }));
    });
    var edges = [];
    state.links.forEach(function (L) {
      if ((L.from === id && seen[L.to]) || (L.to === id && seen[L.from])) {
        if (linkShown(L)) edges.push(linkEdge(L, {}));
      }
    });
    function rows(list) { var k = perRowOf(list), out = []; for (var i = 0; i < list.length; i += k) out.push(list.slice(i, i + k)); return out; }
    var hint = later.length || earlier.length ? "上＝後のニュース・下＝前（同日含む）　箱をタップで移動" : "";
    return {
      nodes: nodes, edges: edges, maxScale: 1.15, hint: hint,
      relayout: function (net) {
        var fb = net.getBoundingBox(id), fh = fb.bottom - fb.top, nh = 0, nw = NW + 26;
        later.concat(earlier).forEach(function (n) {
          var b = net.getBoundingBox(n.id); nh = Math.max(nh, b.bottom - b.top); nw = Math.max(nw, b.right - b.left);
        });
        function place(list, dir) {
          rows(list).forEach(function (row, ri) {
            var y = dir * (fh / 2 + 26 + nh / 2 + ri * (nh + 12));
            row.forEach(function (n, j) {
              var x = (j - (row.length - 1) / 2) * (nw + 14);
              net.moveNode(n.id, x, y + (row.length > 2 ? dir * Math.abs(x) * 0.12 : 0));
            });
          });
        }
        place(later, -1); place(earlier, 1);
      },
    };
  }

  // ------------------------------------------------------------------ detail sheet
  function showSheet(open) {
    var sh = $("#sheet");
    sh.classList.toggle("open", open);
    sh.setAttribute("aria-hidden", open ? "false" : "true");
    if (!open) { state.sheetMin = false; sh.classList.remove("min"); }
  }
  function setSheetMin(min) {
    state.sheetMin = min;
    $("#sheet").classList.toggle("min", min);
    setTimeout(function () { frame(true); }, 240);
  }

  function fillSheet(id) {
    var it = state.byId[id], th = themeOf(it), cs = connectionsOf(id), conns = cs.list, v = state.view;
    var ctxTh = state.themeBy[v.theme] || th;
    var html = '<div class="date"><span>' + esc(it.date) + "</span>" +
      '<button type="button" class="chip" data-theme="' + esc(th.key) + '" style="background:' + th.color + '">' + esc(th.name) + "</button>" +
      (isKt(it) ? '<span class="chip kt">▶ 投稿回</span>' : "") +
      (it.ai === true ? '<span class="chip ai">AI</span>' : it.ai === false ? '<span class="chip nonai">AI以外</span>' : "") +
      (!isKt(it) && it.posts && it.posts.length ? '<span class="chip posted">▶ 投稿済</span>' : "") +
      (hasAddenda(it) ? '<span class="chip addm">追加情報あり</span>' : "") + "</div>";
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
      if (hn.length) html += "<div>具体名: " + hn.slice(0, 2).map(function (n) { return '<b class="hn">' + esc(n) + "</b>"; }).join(" ") + "</div>";
      if (it.hook_contrast) html += "<div>対比: " + esc(it.hook_contrast) + "</div>";
      html += "</div>";
    }
    if (!isKt(it) && it.posts && it.posts.length) {
      html += '<div class="posted-list">' + it.posts.map(function (p) {
        return "▶ " + esc(p.post_date ? shortDate(p.post_date) : "日付不明") + "「" + esc(p.title) + "」";
      }).join("<br>") + "</div>";
    }
    html += addendaHtml(it);
    var meta = [];
    if (it.entities && it.entities.length) meta.push("関係: " + it.entities.map(esc).join("、"));
    if (it.source) meta.push("出典: " + esc(it.source));
    if (meta.length) html += '<div class="meta">' + meta.join("<br>") + "</div>";
    html += "<h3>つながり（" + conns.length + "件）<span style='font-weight:400'>　タップで移動</span></h3>";
    var notes = [];
    if (cs.hiddenWeak) notes.push("弱いリンク " + cs.hiddenWeak + " 件は非表示（上の「弱いリンクも」で表示）");
    if (cs.hiddenPeriod) notes.push("期間外 " + cs.hiddenPeriod + " 件は非表示（「全期間」で表示）");
    if (!conns.length) html += '<p class="empty">表示できるつながりはありません。</p>';
    else {
      html += '<ul class="conn">';
      conns.forEach(function (c) {
        var col = TYPE_COLORS[c.L.type] || TYPE_COLORS.related, oth = themeOf(c.it);
        html += '<li><button type="button" data-jump="' + esc(c.it.id) + '"' + (isWeak(c.L) ? ' class="weak"' : "") +
          ' style="border-left-color:' + (isKt(c.it) ? KT_COLOR : oth.color) + '">' +
          '<div class="rel"><b style="color:' + col + '">' + c.dir + " " + esc(TYPE_LABELS[c.L.type] || c.L.type) + "</b>" +
          (c.L.label ? "<span>· " + esc(c.L.label) + "</span>" : "") +
          '<span class="th" style="color:' + oth.color + '">［' + esc(oth.short) + "］</span>" +
          "<span>" + (c.L.auto ? "自動" : "手動") + " " + c.L.confidence.toFixed(2) + "</span></div>" +
          '<div class="t">' + esc(shortDate(c.it.date)) + "　" + (isKt(c.it) ? "▶ " : "") + esc(isKt(c.it) ? stripKt(c.it.title) : c.it.title) + "</div>" +
          (c.L.contrast ? '<div class="contrast">違い: ' + esc(c.L.contrast) + "</div>" : "") +
          "</button></li>";
      });
      html += "</ul>";
    }
    if (notes.length) html += '<p class="note">' + notes.map(esc).join("<br>") + "</p>";
    html += '<div class="navs"><button type="button" data-go="theme">‹ ' + esc(ctxTh.name) + " に戻る</button>" +
      '<button type="button" data-go="overview">‹‹ テーマ一覧（全体）に戻る</button></div>';
    var body = $("#sheet-body");
    body.innerHTML = html;
    body.scrollTop = 0;
  }

  // ------------------------------------------------------------------ data
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
    state.items.forEach(function (it) { state.byId[it.id] = it; });
    state.themes = (data.themes && data.themes.length ? data.themes : [OTHER]).slice();
    if (!state.themes.some(function (t) { return t.key === "other"; })) state.themes.push(OTHER);
    state.themeBy = {};
    state.themes.forEach(function (t) { state.themeBy[t.key] = t; });
    state.latest = data.lastUpdated || state.items.reduce(function (m, it) { return it.date > m ? it.date : m; }, "");
    state.cutoff = addDays(state.latest, -(RECENT_DAYS - 1));
    $("#updated").textContent = "更新 " + (shortDate(state.latest) || "—");
    state.network = makeNetwork();
    window.__tnm = { network: state.network, state: state, go: go, frame: frame }; // read-only debug hook (scripts/shot_pwa.py)
    route();
  }

  // ------------------------------------------------------------------ UI wiring
  $("#back").addEventListener("click", function () { go(parentOf(state.view)); });
  document.addEventListener("click", function (e) {
    var g = e.target.closest("[data-go]");
    if (g) {
      var to = g.getAttribute("data-go");
      go(to === "theme" ? { level: "theme", theme: state.view.theme } : { level: "overview" });
      return;
    }
    var t = e.target.closest("[data-theme]");
    if (t) { go({ level: "theme", theme: t.getAttribute("data-theme") }); return; }
    var j = e.target.closest("[data-jump]");
    if (j) go({ level: "item", theme: state.view.theme, item: j.getAttribute("data-jump") });
  });
  $("#weak").addEventListener("change", function (e) { state.showWeak = e.target.checked; if (state.network) render(); });
  Array.prototype.forEach.call(document.querySelectorAll("[data-period]"), function (b) {
    b.addEventListener("click", function () {
      state.period = b.getAttribute("data-period");
      Array.prototype.forEach.call(document.querySelectorAll("[data-period]"), function (x) {
        x.setAttribute("aria-pressed", x === b ? "true" : "false");
      });
      if (state.network) render();
    });
  });
  $("#fit").addEventListener("click", function () { frame(true); });
  $("#grab").addEventListener("click", function () { setSheetMin(!state.sheetMin); });
  window.addEventListener("hashchange", route);
  (function () { // swipe down on the sheet = shrink, swipe up = expand
    var y0 = null, sheet = $("#sheet");
    sheet.addEventListener("touchstart", function (e) {
      y0 = ($("#sheet-body").scrollTop <= 0) ? e.touches[0].clientY : null;
    }, { passive: true });
    sheet.addEventListener("touchend", function (e) {
      if (y0 == null) return;
      var dy = e.changedTouches[0].clientY - y0;
      if (dy > 70 && !state.sheetMin) setSheetMin(true);
      else if (dy < -50 && state.sheetMin) setSheetMin(false);
      y0 = null;
    }, { passive: true });
  })();
  var rz = null;
  window.addEventListener("resize", function () {
    clearTimeout(rz);
    rz = setTimeout(function () { if (state.network) render(); }, 200);
  });

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
