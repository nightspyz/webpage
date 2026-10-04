#!/usr/bin/env python3
"""Convert a cut-layout PDF to a Zünd .zcc job, using an existing .zcc as template.

Layer name in the PDF (OCG) selects the <Method Name=...>; stroke colour is the fallback.
Black filled circles on 'Layer 1' become Register points.
The PDF is mapped into machine coordinates with the registration marks as reference:
origin = mark with max X / min Y(up); zcc_x = Y(up) - Y0, zcc_y = X0 - X (90 deg rotation, see Orientation=1).
"""
import argparse, math, re, sys
import pymupdf

PT = 25.4 / 72
# fallback stroke colour (hex of PDF stroke) -> (Type, Name)
COLOR_MAP = {"ee1c24": ("Thru-cut", "c"), "00a651": ("Bevel-cut", "b"),
             "2e3192": ("V-cut", "v"), "bf1e2e": ("Score", "s")}
TYPE_BY_NAME = {"c": "Thru-cut", "c_2": "Thru-cut", "b": "Bevel-cut", "v": "V-cut", "s": "Score"}
TOL = 0.05  # mm, endpoint joining


def hexcol(c):
    return "%02x%02x%02x" % tuple(round(v * 255) for v in c)


def flatten(item, n=16):
    if item[0] == "l":
        return [item[1], item[2]]
    if item[0] == "re":
        r, sign = item[1], item[2]
        pts = [pymupdf.Point(r.x0, r.y0), pymupdf.Point(r.x1, r.y0), pymupdf.Point(r.x1, r.y1), pymupdf.Point(r.x0, r.y1)]
        if sign < 0:
            pts = [pts[0], pts[3], pts[2], pts[1]]
        return pts + [pts[0]]
    if item[0] == "c":
        p0, p1, p2, p3 = item[1:5]
        return [pymupdf.Point(
            (1-t)**3*p0.x+3*(1-t)**2*t*p1.x+3*(1-t)*t*t*p2.x+t**3*p3.x,
            (1-t)**3*p0.y+3*(1-t)**2*t*p1.y+3*(1-t)*t*t*p2.y+t**3*p3.y) for t in [i/n for i in range(n+1)]]
    if item[0] == "qu":
        q = item[1]
        return [q.ul, q.ur, q.lr, q.ll, q.ul]
    raise ValueError(item[0])


def near(a, b):
    return math.hypot(a[0]-b[0], a[1]-b[1]) <= TOL


def join(paths):
    paths = [list(p) for p in paths]
    out = []
    while paths:
        cur = paths.pop(0)
        grew = True
        while grew:
            grew = False
            for i, p in enumerate(paths):
                if near(cur[-1], p[0]):
                    cur += p[1:]
                elif near(cur[-1], p[-1]):
                    cur += p[::-1][1:]
                elif near(cur[0], p[-1]):
                    cur = p[:-1] + cur
                elif near(cur[0], p[0]):
                    cur = p[::-1][:-1] + cur
                else:
                    continue
                paths.pop(i); grew = True; break
        out.append(cur)
    return out


def orient(name, path):
    """Direction rules observed in Cut Editor output: Thru-cut open paths run opposite to the PDF,
    closed Score paths are CCW, closed V-cut paths CW. Bevel-cut keeps PDF direction.
    Start corner of closed paths is NOT reproduced (unknown rule); we start at max-X/min-Y corner."""
    closed = near(path[0], path[-1])
    if not closed:
        return path[::-1] if name.startswith("c") else path
    area = sum(path[i][0]*path[i+1][1]-path[i+1][0]*path[i][1] for i in range(len(path)-1)) / 2
    want_ccw = name == "s"
    if (area > 0) != want_ccw:
        path = path[::-1]
    ring = path[:-1]
    k = min(range(len(ring)), key=lambda i: (-round(ring[i][0], 1), round(ring[i][1], 1)))
    ring = ring[k:] + ring[:k]
    return ring + [ring[0]]


def convert(pdf, page_no=0):
    page = pymupdf.open(pdf)[page_no]
    H = page.rect.height
    mm = lambda p: (p[0]*PT, (H-p[1])*PT)  # X right, Y up, mm
    regs, layers, warn = [], {}, []
    for d in page.get_drawings():
        lay = d.get("layer") or ""
        if d["type"] == "f" and d["fill"] and sum(d["fill"]) < 0.9:
            r = d["rect"]; regs.append(mm(((r.x0+r.x1)/2, (r.y0+r.y1)/2))); continue
        if d["color"] is None:
            continue
        key = lay if lay in TYPE_BY_NAME else None
        if key is None:
            hc = hexcol(d["color"])
            best = min(COLOR_MAP, key=lambda h: sum((int(h[i:i+2],16)-int(hc[i:i+2],16))**2 for i in (0,2,4)))
            if sum((int(best[i:i+2],16)-int(hc[i:i+2],16))**2 for i in (0,2,4)) > 30**2*3:
                warn.append(f"unmapped stroke colour {hc} (layer {lay!r}) skipped"); continue
            key = COLOR_MAP[best][1]
        for it in d["items"]:
            layers.setdefault(key, []).append([mm(p) for p in flatten(it)])
    # reference: mark with max X, min Y
    X0, Y0 = max(regs, key=lambda p: (round(p[0], 1), -p[1]))
    tr = lambda p: (p[1]-Y0, X0-p[0])
    regs_z = sorted({(round(tr(p)[0], 3), round(tr(p)[1], 3)) for p in regs})
    xmin = regs_z[0][0]
    regs_z.sort(key=lambda p: (p[0], p[1] if p[0] == xmin else -p[1]))
    outl = {k: [orient(k, [tr(p) for p in path]) for path in join(v)] for k, v in layers.items()}
    return regs_z, outl, warn


def geometry_xml(regs, outl, order, double_cut):
    L = ["  <Geometry>"]
    for x, y in regs:
        L += [f'   <Point X="{x:.3f}" Y="{y:.3f}">', '    <Method Type="Register" Name="Layer 1"/>', "   </Point>"]
    def emit(name, paths):
        for path in paths:
            L.append("   <Outline>")
            L.append(f'    <MoveTo X="{path[0][0]:.3f}" Y="{path[0][1]:.3f}"/>')
            L.extend(f'    <LineTo X="{x:.3f}" Y="{y:.3f}"/>' for x, y in path[1:])
            L.extend([f'    <Method Type="{TYPE_BY_NAME[name]}" Name="{name}"/>', "   </Outline>"])
    for n in order:
        if n in outl: emit(n, outl[n])
    if double_cut and "c" in outl: emit("c_2", outl["c"])
    L.append("  </Geometry>")
    return "\n".join(L)


def build(template_text, pdf, double_cut, job_name):
    regs, outl, warn = convert(pdf)
    geo = geometry_xml(regs, outl, ["b", "s", "c", "v"], double_cut)
    txt = re.sub(r"  <Geometry>.*?</Geometry>", lambda m: geo, template_text, flags=re.S)
    xs = [p[0] for p in regs]; ys = [p[1] for p in regs]
    txt = re.sub(r'<BottomLeft X="[^"]*" Y="[^"]*"/>', f'<BottomLeft X="{min(xs)-15.019:.3f}" Y="{min(ys)-30.002:.3f}"/>', txt)
    txt = re.sub(r'<TopRight X="[^"]*" Y="[^"]*"/>', f'<TopRight X="{max(xs)+15.019:.3f}" Y="{max(ys)+30.0:.3f}"/>', txt)
    txt = re.sub(r'(<Job Name=")[^"]*"', lambda m: m.group(1)+job_name+'"', txt, count=1)
    return txt, regs, outl, warn


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf"); ap.add_argument("-t", "--template", required=True)
    ap.add_argument("-o", "--output"); ap.add_argument("--double-cut", action="store_true",
                    help="also emit a second Thru-cut pass (method c_2) over the c outlines")
    a = ap.parse_args()
    out = a.output or a.pdf + ".zcc"
    txt, regs, outl, warn = build(open(a.template, encoding="utf-8").read(), a.pdf, a.double_cut, out.split("/")[-1])
    open(out, "w", encoding="utf-8").write(txt)
    print(f"wrote {out}: {len(regs)} marks, " + ", ".join(f"{k}:{len(v)}" for k, v in outl.items()))
    for w in warn: print("WARN", w, file=sys.stderr)
