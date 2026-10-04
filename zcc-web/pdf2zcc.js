/* PDF -> ZCC converter (JavaScript port of zcc/pdf2zcc.py).
 *
 * Layer name in the PDF (optional content group) selects the <Method Name=...>; stroke colour is the fallback.
 * Dark filled shapes (registration circles) become Register points.
 * Machine coordinates: origin = registration mark with max X / min Y(up);
 *   zcc_x = Y(up) - Y0, zcc_y = X0 - X  (90 degree rotation, Orientation=1).
 *
 * Works in the browser (window.Pdf2Zcc) and in Node (module.exports).
 */
(function (root) {
  "use strict";

  const PT = 25.4 / 72;
  const TOL = 0.05; // mm, endpoint joining
  // fallback stroke colour (hex) -> method name
  const COLOR_MAP = { ee1c24: "c", "00a651": "b", "2e3192": "v", bf1e2e: "s" };
  const TYPE_BY_NAME = { c: "Thru-cut", c_2: "Thru-cut", b: "Bevel-cut", v: "V-cut", s: "Score" };

  const hex = (rgb) => rgb.map((v) => v.toString(16).padStart(2, "0")).join("");
  const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= TOL;
  const round1 = (v) => Math.round(v * 10) / 10;
  const fmt = (v) => {
    const s = v.toFixed(3);
    return s === "-0.000" ? "0.000" : s;
  };

  // ---- 2D affine matrices [a,b,c,d,e,f] ----
  const mul = (m, n) => [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
  const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

  function bezier(p0, p1, p2, p3, n = 16) {
    const out = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n, u = 1 - t;
      out.push([
        u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
        u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
      ]);
    }
    return out;
  }

  /**
   * Walk a pdf.js operator list.
   * Returns { marks: [[x,y]mm], layers: { name: [polyline,...] }, warnings } with coordinates in mm, Y up.
   * ocName(id) -> layer name for an optional-content group id.
   */
  function extract(opList, OPS, ocName) {
    const marks = [], layers = {}, warnings = [];
    let ctm = [1, 0, 0, 1, 0, 0];
    const gstack = [];
    let fill = [0, 0, 0], stroke = [0, 0, 0];
    const mc = []; // marked content stack of layer names (or null)
    let subpaths = [], cur = null; // current path (device space, pt)
    const layer = () => { for (let i = mc.length - 1; i >= 0; i--) if (mc[i]) return mc[i]; return ""; };

    const addPath = (ops, c) => {
      let k = 0;
      for (const op of ops) {
        if (op === OPS.moveTo) {
          cur = [apply(ctm, c[k], c[k + 1])]; subpaths.push(cur); k += 2;
        } else if (op === OPS.lineTo) {
          if (!cur) { cur = [apply(ctm, c[k], c[k + 1])]; subpaths.push(cur); } else cur.push(apply(ctm, c[k], c[k + 1]));
          k += 2;
        } else if (op === OPS.curveTo) {
          const p0 = cur[cur.length - 1];
          const p1 = apply(ctm, c[k], c[k + 1]), p2 = apply(ctm, c[k + 2], c[k + 3]), p3 = apply(ctm, c[k + 4], c[k + 5]);
          cur.push(...bezier(p0, p1, p2, p3).slice(1)); k += 6;
        } else if (op === OPS.curveTo2) { // v: first control = current point
          const p0 = cur[cur.length - 1];
          const p2 = apply(ctm, c[k], c[k + 1]), p3 = apply(ctm, c[k + 2], c[k + 3]);
          cur.push(...bezier(p0, p0, p2, p3).slice(1)); k += 4;
        } else if (op === OPS.curveTo3) { // y: second control = end point
          const p0 = cur[cur.length - 1];
          const p1 = apply(ctm, c[k], c[k + 1]), p3 = apply(ctm, c[k + 2], c[k + 3]);
          cur.push(...bezier(p0, p1, p3, p3).slice(1)); k += 4;
        } else if (op === OPS.closePath) {
          if (cur && cur.length) cur.push(cur[0].slice());
        } else if (op === OPS.rectangle) {
          const [x, y, w, h] = [c[k], c[k + 1], c[k + 2], c[k + 3]]; k += 4;
          const r = [apply(ctm, x, y), apply(ctm, x + w, y), apply(ctm, x + w, y + h), apply(ctm, x, y + h)];
          cur = [...r, r[0].slice()]; subpaths.push(cur);
        }
      }
    };

    const paint = (doFill, doStroke) => {
      const toMM = (p) => [p[0] * PT, p[1] * PT];
      if (doFill && fill[0] + fill[1] + fill[2] < 0.9 * 255) {
        // dark fill -> registration mark at the bbox centre of the path
        const pts = subpaths.flat();
        if (pts.length) {
          const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
          marks.push(toMM([(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]));
        }
      }
      if (doStroke) {
        let key = layer();
        if (!TYPE_BY_NAME[key]) {
          const hc = hex(stroke);
          const dist = (h) => [0, 2, 4].reduce((s, i) => s + (parseInt(h.slice(i, i + 2), 16) - parseInt(hc.slice(i, i + 2), 16)) ** 2, 0);
          const best = Object.keys(COLOR_MAP).reduce((a, b) => (dist(b) < dist(a) ? b : a));
          if (dist(best) > 30 * 30 * 3) { warnings.push(`unmapped stroke colour ${hc} (layer '${layer()}') skipped`); key = null; }
          else key = COLOR_MAP[best];
        }
        if (key) for (const sp of subpaths) if (sp.length > 1) (layers[key] = layers[key] || []).push(sp.map(toMM));
      }
    };

    for (let i = 0; i < opList.fnArray.length; i++) {
      const fn = opList.fnArray[i], a = opList.argsArray[i];
      switch (fn) {
        case OPS.save: gstack.push([ctm, fill, stroke]); break;
        case OPS.restore: if (gstack.length) [ctm, fill, stroke] = gstack.pop(); break;
        case OPS.transform: ctm = mul(ctm, a); break;
        case OPS.setFillRGBColor: fill = [a[0], a[1], a[2]]; break;
        case OPS.setStrokeRGBColor: stroke = [a[0], a[1], a[2]]; break;
        case OPS.setFillGray: fill = [a[0], a[0], a[0]]; break;
        case OPS.setStrokeGray: stroke = [a[0], a[0], a[0]]; break;
        case OPS.beginMarkedContentProps:
          mc.push(a[0] === "OC" && a[1] && a[1].id ? ocName(a[1].id) : null); break;
        case OPS.beginMarkedContent: mc.push(null); break;
        case OPS.endMarkedContent: mc.pop(); break;
        case OPS.constructPath: addPath(a[0], a[1]); break;
        case OPS.stroke: case OPS.closeStroke: paint(false, true); subpaths = []; cur = null; break;
        case OPS.fill: case OPS.eoFill: paint(true, false); subpaths = []; cur = null; break;
        case OPS.fillStroke: case OPS.eoFillStroke: case OPS.closeFillStroke: case OPS.closeEOFillStroke:
          paint(true, true); subpaths = []; cur = null; break;
        case OPS.endPath: subpaths = []; cur = null; break;
        default: break;
      }
    }
    return { marks, layers, warnings };
  }

  function join(paths) {
    paths = paths.map((p) => p.slice());
    const out = [];
    while (paths.length) {
      let cur = paths.shift(), grew = true;
      while (grew) {
        grew = false;
        for (let i = 0; i < paths.length; i++) {
          const p = paths[i];
          if (near(cur[cur.length - 1], p[0])) cur = cur.concat(p.slice(1));
          else if (near(cur[cur.length - 1], p[p.length - 1])) cur = cur.concat(p.slice().reverse().slice(1));
          else if (near(cur[0], p[p.length - 1])) cur = p.slice(0, -1).concat(cur);
          else if (near(cur[0], p[0])) cur = p.slice().reverse().slice(0, -1).concat(cur);
          else continue;
          paths.splice(i, 1); grew = true; break;
        }
      }
      out.push(cur);
    }
    return out;
  }

  /* Direction rules observed in Cut Editor output: Thru-cut open paths run opposite to the PDF,
   * closed Score paths are CCW, closed V-cut paths CW. Bevel-cut keeps PDF direction.
   * Start corner of closed paths is NOT reproduced (unknown rule); we start at the max-X/min-Y corner. */
  function orient(name, path) {
    const closed = near(path[0], path[path.length - 1]);
    if (!closed) return name.startsWith("c") ? path.slice().reverse() : path;
    let area = 0;
    for (let i = 0; i < path.length - 1; i++) area += path[i][0] * path[i + 1][1] - path[i + 1][0] * path[i][1];
    area /= 2;
    if (area > 0 !== (name === "s")) path = path.slice().reverse();
    let ring = path.slice(0, -1);
    let k = 0;
    for (let i = 1; i < ring.length; i++) {
      const a = [-round1(ring[i][0]), round1(ring[i][1])], b = [-round1(ring[k][0]), round1(ring[k][1])];
      if (a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])) k = i;
    }
    ring = ring.slice(k).concat(ring.slice(0, k));
    return ring.concat([ring[0]]);
  }

  /** Map extracted geometry into machine coordinates. */
  function toMachine(ex) {
    const { marks, layers } = ex;
    if (!marks.length) throw new Error("no registration marks (dark filled circles) found in the PDF");
    let ref = marks[0];
    for (const m of marks) {
      const a = [round1(m[0]), -m[1]], b = [round1(ref[0]), -ref[1]];
      if (a[0] > b[0] || (a[0] === b[0] && a[1] > b[1])) ref = m;
    }
    const [X0, Y0] = ref;
    const tr = (p) => [p[1] - Y0, X0 - p[0]];
    const seen = new Set();
    let regs = [];
    for (const m of marks) {
      const t = tr(m), r = [Number(t[0].toFixed(3)), Number(t[1].toFixed(3))], key = r.join(",");
      if (!seen.has(key)) { seen.add(key); regs.push(r); }
    }
    regs.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    const xmin = regs[0][0];
    regs.sort((p, q) => p[0] - q[0] || (p[0] === xmin ? p[1] - q[1] : q[1] - p[1]));
    const outl = {};
    for (const [k, v] of Object.entries(layers)) outl[k] = join(v).map((path) => orient(k, path.map(tr)));
    if (!Object.keys(outl).length) throw new Error("no cut paths found in the PDF");
    return { regs, outl };
  }

  function geometryXml(regs, outl, order, doubleCut) {
    const L = ["  <Geometry>"];
    for (const [x, y] of regs)
      L.push(`   <Point X="${fmt(x)}" Y="${fmt(y)}">`, '    <Method Type="Register" Name="Layer 1"/>', "   </Point>");
    const emit = (name, paths) => {
      for (const path of paths) {
        L.push("   <Outline>", `    <MoveTo X="${fmt(path[0][0])}" Y="${fmt(path[0][1])}"/>`);
        for (const [x, y] of path.slice(1)) L.push(`    <LineTo X="${fmt(x)}" Y="${fmt(y)}"/>`);
        L.push(`    <Method Type="${TYPE_BY_NAME[name]}" Name="${name}"/>`, "   </Outline>");
      }
    };
    for (const n of order) if (outl[n]) emit(n, outl[n]);
    if (doubleCut && outl.c) emit("c_2", outl.c);
    L.push("  </Geometry>");
    return L.join("\n");
  }

  /** Build the .zcc text from a template .zcc text and a pdf.js operator list. */
  function build(templateText, opList, OPS, ocName, jobName, doubleCut) {
    const ex = extract(opList, OPS, ocName);
    const { regs, outl } = toMachine(ex);
    if (!templateText.includes("<Geometry>")) throw new Error("template has no <Geometry> block");
    const geo = geometryXml(regs, outl, ["b", "s", "c", "v"], doubleCut);
    let txt = templateText.replace(/ {2}<Geometry>[\s\S]*?<\/Geometry>/, () => geo);
    const xs = regs.map((p) => p[0]), ys = regs.map((p) => p[1]);
    const mn = (a) => Math.min(...a), mx = (a) => Math.max(...a);
    txt = txt.replace(/<BottomLeft X="[^"]*" Y="[^"]*"\/>/, `<BottomLeft X="${fmt(mn(xs) - 15.019)}" Y="${fmt(mn(ys) - 30.002)}"/>`);
    txt = txt.replace(/<TopRight X="[^"]*" Y="[^"]*"\/>/, `<TopRight X="${fmt(mx(xs) + 15.019)}" Y="${fmt(mx(ys) + 30.0)}"/>`);
    txt = txt.replace(/(<Job Name=")[^"]*"/, (m, a) => a + jobName + '"');
    return { text: txt, regs, outl, warnings: ex.warnings };
  }

  const api = { build, extract, toMachine, join, orient, PT };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Pdf2Zcc = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
