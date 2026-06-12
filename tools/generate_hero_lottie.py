#!/usr/bin/env python3
"""Generate the Angler BI hero Lottie animation.

Concept: messy scattered data sources (left) -> bezier flow lines with
travelling cyan pulses (middle) -> clean dashboard card (right).

Canvas 1004x700, fr=30, op=240 (8s). Seamless loop. Frame 90 = static poster.

Output overwrites /assets/hero-flow.json (minified).
"""
import json
import math
import os

W, H = 1004, 700
FR = 30
OP = 240  # 8 seconds

# ── Palette (hex -> normalized rgb) ────────────────────────────────
def hexc(h):
    h = h.lstrip("#")
    return [int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]

INK      = hexc("0e1a26")
INK2     = hexc("3c4d5e")
MUTED    = hexc("66788a")
FAINT    = hexc("9aaab9")
HAIR     = hexc("e4eaef")
HAIR2    = hexc("d3dde4")
DASH     = hexc("c5d2db")
WHITE    = hexc("ffffff")
PAPER    = hexc("fbfcfd")
PAPER2   = hexc("f4f7f9")
CYAN     = hexc("07c3e8")
CYAN_INK = hexc("06729a")
TINT1    = hexc("eafafe")
TINT2    = hexc("c9f1fb")
TINT3    = hexc("9fe6f7")
AMBER    = hexc("ffb648")
CORAL    = hexc("e8604c")


# ── Easing helpers ─────────────────────────────────────────────────
def ease(x=0.42, y=0.0):
    return {"x": [x], "y": [y]}

EASE_IO_I = {"x": [0.6], "y": [0.0]}
EASE_IO_O = {"x": [0.4], "y": [1.0]}


def kf(t, v, i=None, o=None, hold=False):
    """One keyframe. i/o are bezier handle dicts (out-handle 'o', in-handle 'i')."""
    k = {"t": t, "s": v if isinstance(v, list) else [v]}
    if hold:
        k["h"] = 1
    else:
        k["o"] = o if o else {"x": [0.4], "y": [0.0]}
        k["i"] = i if i else {"x": [0.6], "y": [1.0]}
    return k


def anim(keys):
    return {"a": 1, "k": keys}


def static(v):
    return {"a": 0, "k": v if isinstance(v, list) else [v]}


# ── Shape primitives ───────────────────────────────────────────────
def fill(color, opacity=100):
    return {"ty": "fl", "c": static(color), "o": static(opacity), "r": 1, "nm": "fill"}


def fill_anim(color, op_keys):
    return {"ty": "fl", "c": static(color), "o": anim(op_keys), "r": 1, "nm": "fill"}


def stroke(color, width=2.0, opacity=100):
    return {"ty": "st", "c": static(color), "o": static(opacity), "w": static(width),
            "lc": 2, "lj": 2, "ml": 4, "nm": "stroke"}


def stroke_anim_w(color, w_keys, opacity=100):
    return {"ty": "st", "c": static(color), "o": static(opacity), "w": anim(w_keys),
            "lc": 2, "lj": 2, "ml": 4, "nm": "stroke"}


def trim(start_keys, end_keys, offset=0):
    return {"ty": "tm",
            "s": anim(start_keys) if isinstance(start_keys, list) else start_keys,
            "e": anim(end_keys) if isinstance(end_keys, list) else end_keys,
            "o": static(offset), "m": 1, "nm": "trim"}


def rect(w, h, rad=0, pos=(0, 0)):
    return {"ty": "rc", "d": 1, "s": static([w, h]),
            "p": static(list(pos)), "r": static(rad), "nm": "rect"}


def ellipse(w, h, pos=(0, 0)):
    return {"ty": "el", "d": 1, "s": static([w, h]), "p": static(list(pos)), "nm": "ellipse"}


def path_shape(verts, in_t, out_t, closed=False):
    return {"ty": "sh", "d": 1, "nm": "path",
            "ks": static_path(verts, in_t, out_t, closed)}


def static_path(verts, in_t, out_t, closed=False):
    return {"a": 0, "k": {"i": in_t, "o": out_t, "v": verts, "c": closed}}


def group(items, name="grp", tr=None):
    if tr is None:
        tr = transform()
    return {"ty": "gr", "nm": name, "it": items + [tr]}


def frect(w, h, rad, pos, fillc, opacity=100, name="frect"):
    """Self-contained filled rounded rect (own fill -> safe to mix in a group)."""
    return group([rect(w, h, rad, pos), fill(fillc, opacity)], name=name)


def srect(w, h, rad, pos, strokec, width=2.0, opacity=100, name="srect"):
    """Self-contained stroked rounded rect."""
    return group([rect(w, h, rad, pos), stroke(strokec, width, opacity)], name=name)


def fell(w, h, pos, fillc, opacity=100, name="fell"):
    return group([ellipse(w, h, pos), fill(fillc, opacity)], name=name)


def transform(pos=(0, 0), anchor=(0, 0), scale=(100, 100), rot=0, opacity=100,
              pos_anim=None, scale_anim=None, op_anim=None, rot_anim=None):
    tr = {"ty": "tr",
          "a": static(list(anchor)),
          "s": anim(scale_anim) if scale_anim else static(list(scale)),
          "r": anim(rot_anim) if rot_anim else static(rot),
          "o": anim(op_anim) if op_anim else static(opacity),
          "sk": static(0), "sa": static(0)}
    tr["p"] = anim(pos_anim) if pos_anim else static(list(pos))
    return tr


def layer(shapes, name="layer", ind=1, op_anim=None, parent=None):
    L = {"ddd": 0, "ind": ind, "ty": 4, "nm": name, "sr": 1,
         "ks": {"a": static([0, 0, 0]), "p": static([0, 0, 0]),
                "s": static([100, 100, 100]), "r": static(0),
                "o": anim(op_anim) if op_anim else static(100)},
         "ao": 0, "shapes": shapes, "ip": 0, "op": OP, "st": 0, "bm": 0}
    if parent is not None:
        L["parent"] = parent
    return L


# ── Bezier sampling for flow geometry (for pulse trim alignment) ──
def bezier_pt(p0, c0, c1, p1, t):
    mt = 1 - t
    x = mt**3 * p0[0] + 3 * mt**2 * t * c0[0] + 3 * mt * t**2 * c1[0] + t**3 * p1[0]
    y = mt**3 * p0[1] + 3 * mt**2 * t * c0[1] + 3 * mt * t**2 * c1[1] + t**3 * p1[1]
    return [x, y]


layers = []
ind = [0]
def nxt():
    ind[0] += 1
    return ind[0]


# ════════════════════════════════════════════════════════════════
# 1. FLOW LINES (middle) — drawn first so they sit behind nodes/card
# ════════════════════════════════════════════════════════════════
# Sources on the left, converging toward a hub near the card's left edge.
HUB = (560, 350)
SOURCES = [
    (150, 175),
    (120, 330),
    (140, 490),
    (190, 600),
]

flow_items = []
pulse_layers = []

for li, src in enumerate(SOURCES):
    # Construct a gentle S-curve from source to hub.
    sx, sy = src
    hx, hy = HUB
    midx = (sx + hx) / 2
    # control points: leave source horizontally, arrive hub horizontally
    c0 = [sx + 120, sy]
    c1 = [hx - 150, hy + (sy - hy) * 0.25]
    verts = [[sx, sy], [hx, hy]]
    in_t = [[0, 0], [0, 0]]
    out_t = [[c0[0] - sx, c0[1] - sy], [0, 0]]
    in_t[1] = [c1[0] - hx, c1[1] - hy]

    # Base hairline path
    base = group([
        path_shape(verts, in_t, out_t, closed=False),
        stroke(DASH, 1.6, opacity=70),
    ], name=f"flowbase{li}")
    flow_items.append(base)

# Put all base flow lines in one layer (behind).
layers.append(layer(flow_items, name="flowlines", ind=nxt()))

# ── Travelling cyan pulses (separate layers, animated trim) ──
# Each pulse: a short trim window advancing 0->100 over the loop, integer cycles.
PULSE_CYCLES = [2, 2, 2, 2]  # full passes over the loop (integer => seamless)
PULSE_LEN = 0.14  # fraction of path lit
for li, src in enumerate(SOURCES):
    sx, sy = src
    hx, hy = HUB
    c0 = [sx + 120, sy]
    c1 = [hx - 150, hy + (sy - hy) * 0.25]
    verts = [[sx, sy], [hx, hy]]
    in_t = [[0, 0], [c1[0] - hx, c1[1] - hy]]
    out_t = [[c0[0] - sx, c0[1] - sy], [0, 0]]

    cycles = PULSE_CYCLES[li]
    seg = OP / cycles  # frames per travel pass
    win = PULSE_LEN * 100.0  # window width in percent

    # A short lit window slides from the path start (0%) off the far end
    # (100%) once per segment. We model it with paired start/end keyframes
    # that move linearly together; the window enters from -win and exits at
    # 100, so at the segment boundary the path is empty (start==end==edge),
    # which makes the loop seam invisible. Phase the lead so the four pulses
    # are staggered down the lines.
    lin_o = {"x": [0.5], "y": [0.5]}
    lin_i = {"x": [0.5], "y": [0.5]}
    LEAD = -win  # window head position at segment start (just before 0)
    s_keys, e_keys = [], []
    phase_frac = li / len(SOURCES)
    for cyc in range(cycles + 1):
        t0 = cyc * seg
        # window head travels LEAD -> 100 across the segment
        for frac in (0.0,):
            pass
        # two keyframes per segment: start and end of pass
        head_start = LEAD
        head_end = 100.0 + win
        s_keys.append({"t": t0, "head": head_start})
        s_keys.append({"t": t0 + seg, "head": head_end})

    # Build clamped start/end percentage keyframes from the moving head.
    def clamp(v):
        return max(0.0, min(100.0, v))

    start_kfs, end_kfs = [], []
    # sample finely so the clamped corners are crisp; use linear travel
    SAMPLES = cycles * 12
    for s in range(SAMPLES + 1):
        t = s * OP / SAMPLES
        # global progress with stagger
        prog = (s / SAMPLES) * cycles + phase_frac
        local = prog % 1.0  # 0..1 within current pass
        head = LEAD + local * (100.0 + win - LEAD)  # head position
        st = clamp(head - win)
        en = clamp(head)
        tt = int(round(t))
        start_kfs.append({"t": tt, "s": [st], "o": lin_o, "i": lin_i})
        end_kfs.append({"t": tt, "s": [en], "o": lin_o, "i": lin_i})
    # de-dup identical consecutive times
    def dedup(ks):
        out = []
        for k in ks:
            if out and out[-1]["t"] == k["t"]:
                out[-1] = k
            else:
                out.append(k)
        return out
    start_kfs = dedup(start_kfs)
    end_kfs = dedup(end_kfs)
    # enforce exact seam equality
    end_kfs[-1]["s"] = list(end_kfs[0]["s"])
    start_kfs[-1]["s"] = list(start_kfs[0]["s"])

    pulse_trim = {"ty": "tm", "s": anim(start_kfs), "e": anim(end_kfs),
                  "o": static(0), "m": 1, "nm": "pulsetrim"}

    pulse = group([
        path_shape(verts, in_t, out_t, closed=False),
        pulse_trim,
        stroke(CYAN, 2.6, opacity=100),
    ], name=f"pulse{li}")

    pulse_layers.append(layer([pulse], name=f"pulselayer{li}", ind=nxt()))

layers.extend(pulse_layers)


# ════════════════════════════════════════════════════════════════
# 2. SOURCE NODES (left) — scattered rounded squares, bobbing
# ════════════════════════════════════════════════════════════════
NODE_FILLS = [TINT1, TINT2, TINT1, PAPER2]
NODE_SIZES = [54, 44, 50, 40]
for li, src in enumerate(SOURCES):
    sx, sy = src
    size = NODE_SIZES[li]
    fillc = NODE_FILLS[li]
    # bob: vertical sine, integer cycles, staggered phase
    cycles = 2
    amp = 6 + li * 1.5
    phase = (li / len(SOURCES)) * 2 * math.pi
    pos_keys = []
    steps = cycles * 4
    for s in range(steps + 1):
        t = int(round(s * OP / steps))
        ph = phase + (s / steps) * cycles * 2 * math.pi
        dy = amp * math.sin(ph)
        pos_keys.append({"t": t, "s": [sx, sy + dy],
                         "o": EASE_IO_O, "i": EASE_IO_I})
    pos_keys[-1]["s"] = pos_keys[0]["s"]  # exact seam

    # subtle pulse scale out of phase
    sc_keys = []
    for s in range(steps + 1):
        t = int(round(s * OP / steps))
        ph = phase + (s / steps) * cycles * 2 * math.pi
        sc = 100 + 3 * math.sin(ph + 1.0)
        sc_keys.append({"t": t, "s": [sc, sc], "o": EASE_IO_O, "i": EASE_IO_I})
    sc_keys[-1]["s"] = sc_keys[0]["s"]

    node = group([
        # ticks on top, then outline, then body fill (bottom of paint stack)
        frect(size * 0.28, 3, 1.5, (-size * 0.07, 0.0), FAINT, 60, "tick2"),
        frect(size * 0.42, 3, 1.5, (0, -size * 0.16), CYAN, 70, "tick1"),
        srect(size, size, 12, (0, 0), HAIR2, 2.0, 100, "nodeoutline"),
        frect(size, size, 12, (0, 0), fillc, 100, "nodebody"),
    ], name=f"node{li}",
       tr=transform(anchor=(0, 0),
                    pos_anim=pos_keys, scale_anim=sc_keys))
    layers.append(layer([node], name=f"sourcenode{li}", ind=nxt()))

# small connector dot at hub
hub_dot = group([
    group([ellipse(16, 16, (0, 0)), stroke(CYAN, 2.2, 100)], name="hubring"),
    group([ellipse(16, 16, (0, 0)), fill(WHITE, 100)], name="hubfill"),
], name="hubdot", tr=transform(pos=list(HUB)))
layers.append(layer([hub_dot], name="hubdot", ind=nxt()))


# ════════════════════════════════════════════════════════════════
# 3. DASHBOARD CARD (right) ~45% of canvas
# ════════════════════════════════════════════════════════════════
CARD_X, CARD_Y = 590, 110
CARD_W, CARD_H = 360, 480
card_items = [
    # outline (top of stack), main body, shadow plate (bottom)
    srect(CARD_W, CARD_H, 14, (CARD_X + CARD_W / 2, CARD_Y + CARD_H / 2), HAIR2, 2.0, 100, "cardoutline"),
    frect(CARD_W, CARD_H, 14, (CARD_X + CARD_W / 2, CARD_Y + CARD_H / 2), WHITE, 100, "cardbody"),
    frect(CARD_W + 6, CARD_H + 6, 16, (CARD_X + CARD_W / 2 + 4, CARD_Y + CARD_H / 2 + 6), PAPER2, 100, "cardshadow"),
]
layers.append(layer([group(card_items, name="card")], name="card", ind=nxt()))

# ── Card header: title bar + KPI blocks ──
hx0 = CARD_X + 28
header_items = [
    fell(11, 11, (CARD_X + CARD_W - 34, CARD_Y + 40), AMBER, 100, "statustick"),
    frect(70, 7, 3.5, (hx0 + 35, CARD_Y + 56), FAINT, 100, "subtitle"),
    frect(120, 10, 5, (hx0 + 60, CARD_Y + 36), INK2, 100, "title"),
]
layers.append(layer([group(header_items, name="header")], name="header", ind=nxt()))

# ── KPI placeholder blocks (3) ──
kpi_y = CARD_Y + 90
kpi_w = (CARD_W - 56 - 24) / 3
kpi_items = []
for i in range(3):
    kx = hx0 + i * (kpi_w + 12)
    # paint order: text lines on top, then outline, then panel body
    kpi_items += [
        frect(kpi_w * 0.62, 5, 2.5, (kx + kpi_w * 0.36, kpi_y + 38), FAINT, 100, f"kpilabel{i}"),
        frect(kpi_w * 0.5, 8, 4, (kx + kpi_w * 0.32, kpi_y + 20), INK, 100, f"kpival{i}"),
        srect(kpi_w, 56, 8, (kx + kpi_w / 2, kpi_y + 28), HAIR, 1.5, 100, f"kpiline{i}"),
        frect(kpi_w, 56, 8, (kx + kpi_w / 2, kpi_y + 28), PAPER2, 100, f"kpibody{i}"),
    ]
# tiny cyan accent on first KPI (on top)
kpi_items.insert(0, frect(4, 20, 2, (hx0 + 3, kpi_y + 28), CYAN, 100, "kpiaccent"))
layers.append(layer([group(kpi_items, name="kpis")], name="kpis", ind=nxt()))

# ── BAR CHART (morphs between two states) ──
bar_base_y = CARD_Y + 330  # baseline
bar_area_x = hx0
bar_area_w = CARD_W - 56
n_bars = 5
gap = 14
bw = (bar_area_w - gap * (n_bars - 1)) / n_bars
state_a = [88, 130, 62, 150, 104]
state_b = [120, 78, 140, 96, 152]

# axis baseline
axis_items = [
    rect(bar_area_w, 2, rad=1, pos=(bar_area_x + bar_area_w / 2, bar_base_y + 1)),
    fill(HAIR2, 100),
]
layers.append(layer([group(axis_items, name="baraxis")], name="baraxis", ind=nxt()))

bar_fills = [TINT3, CYAN, TINT2, CYAN, TINT3]
for bi in range(n_bars):
    bx = bar_area_x + bi * (bw + gap) + bw / 2
    ha, hb = state_a[bi], state_b[bi]
    # scaleY morph a->b->a over loop, with hold dwell. Anchor at baseline.
    # Use 4 keyframes: 0(a) 96(b) 144(b hold) 240(a). Smooth ease.
    h_keys = [
        kf(0, [ha], i={"x": [0.65], "y": [1]}, o={"x": [0.35], "y": [0]}),
        kf(96, [hb], i={"x": [0.65], "y": [1]}, o={"x": [0.35], "y": [0]}),
        kf(144, [hb], i={"x": [0.65], "y": [1]}, o={"x": [0.35], "y": [0]}),
        kf(240, [ha], i={"x": [0.65], "y": [1]}, o={"x": [0.35], "y": [0]}),
    ]
    # We morph the rect's height by animating its size + position together.
    # Build size + position keyframes.
    sz_keys = []
    py_keys = []
    seq = [(0, ha), (96, hb), (144, hb), (240, ha)]
    for (t, hv) in seq:
        sz_keys.append({"t": t, "s": [bw, hv],
                        "o": {"x": [0.35], "y": [0]}, "i": {"x": [0.65], "y": [1]}})
        py_keys.append({"t": t, "s": [bx, bar_base_y - hv / 2],
                        "o": {"x": [0.35], "y": [0]}, "i": {"x": [0.65], "y": [1]}})
    bar_rect = {"ty": "rc", "d": 1, "s": anim(sz_keys), "p": anim(py_keys),
                "r": static(5), "nm": "barrect"}
    bar = group([bar_rect, fill(bar_fills[bi], 100)], name=f"bar{bi}")
    layers.append(layer([bar], name=f"bar{bi}", ind=nxt()))


# ── LINE/AREA CHART (trim-path redraw + subtle morph) ──
line_y0 = CARD_Y + 380
line_w = CARD_W - 56
lx = hx0
# two shapes
def line_verts(amps, base):
    pts = []
    n = len(amps)
    for i, a in enumerate(amps):
        x = lx + (line_w) * (i / (n - 1))
        y = base - a
        pts.append([x, y])
    return pts

amps_a = [18, 44, 30, 60, 40, 72]
amps_b = [30, 22, 52, 38, 66, 50]
base_line = line_y0 + 70
va = line_verts(amps_a, base_line)
vb = line_verts(amps_b, base_line)

# tangents (smooth) — auto compute simple tangents
def tangents(v):
    n = len(v)
    it, ot = [], []
    for i in range(n):
        if i == 0:
            d = [(v[1][0] - v[0][0]) * 0.3, (v[1][1] - v[0][1]) * 0.3]
        elif i == n - 1:
            d = [(v[i][0] - v[i - 1][0]) * 0.3, (v[i][1] - v[i - 1][1]) * 0.3]
        else:
            d = [(v[i + 1][0] - v[i - 1][0]) * 0.18, (v[i + 1][1] - v[i - 1][1]) * 0.18]
        ot.append(d)
        it.append([-d[0], -d[1]])
    return it, ot

ita, ota = tangents(va)
itb, otb = tangents(vb)

# Morphing path keyframes (shape value animated)
def path_kf(t, verts, it, ot, ease_o, ease_i):
    return {"t": t, "s": [{"i": it, "o": ot, "v": verts, "c": False}],
            "o": ease_o, "i": ease_i}

eo = {"x": [0.35], "y": [0]}
ei = {"x": [0.65], "y": [1]}
line_path = {"ty": "sh", "d": 1, "nm": "linepath", "ks": {"a": 1, "k": [
    path_kf(0, va, ita, ota, eo, ei),
    path_kf(120, vb, itb, otb, eo, ei),
    path_kf(240, va, ita, ota, eo, ei),
]}}

# Line is always fully drawn (end=100, static) so frame 0 == frame 240 with
# no redraw pop. The motion comes purely from the seamless path morph a->b->a.
line_trim = {"ty": "tm", "s": static(0), "e": static(100), "o": static(0), "m": 1, "nm": "linetrim"}

line_group = group([
    line_path,
    line_trim,
    stroke(CYAN_INK, 2.4, 100),
], name="linechart")
layers.append(layer([line_group], name="linechart", ind=nxt()))

# small dot riding the morphing end of the line (always visible; seamless)
endx = va[-1][0]
endy_a = va[-1][1]
endy_b = vb[-1][1]
dot_pos = [
    {"t": 0, "s": [endx, endy_a], "o": eo, "i": ei},
    {"t": 120, "s": [endx, endy_b], "o": eo, "i": ei},
    {"t": 240, "s": [endx, endy_a], "o": eo, "i": ei},
]
line_dot = group([
    group([ellipse(9, 9, (0, 0)), stroke(CYAN_INK, 2.2, 100)], name="dotring"),
    group([ellipse(9, 9, (0, 0)), fill(WHITE, 100)], name="dotfill"),
], name="linedot", tr=transform(pos_anim=dot_pos))
layers.append(layer([line_dot], name="linedot", ind=nxt()))

# legend chips under line
legend_y = CARD_Y + CARD_H - 26
legend_items = [
    frect(46, 6, 3, (hx0 + 146, legend_y), FAINT, 100, "leglabel2"),
    frect(14, 6, 3, (hx0 + 110, legend_y), CYAN_INK, 100, "legswatch2"),
    frect(50, 6, 3, (hx0 + 45, legend_y), FAINT, 100, "leglabel1"),
    frect(14, 6, 3, (hx0 + 7, legend_y), CYAN, 100, "legswatch1"),
]
layers.append(layer([group(legend_items, name="legend")], name="legend", ind=nxt()))

# ── floating secondary chip (depth) bottom-left of card overlap ──
chip_y_keys = []
cyc = 2
camp = 7
cphase = 1.2
steps = cyc * 4
chx, chy = 470, 170
for s in range(steps + 1):
    t = int(round(s * OP / steps))
    ph = cphase + (s / steps) * cyc * 2 * math.pi
    chip_y_keys.append({"t": t, "s": [chx, chy + camp * math.sin(ph)],
                        "o": EASE_IO_O, "i": EASE_IO_I})
chip_y_keys[-1]["s"] = chip_y_keys[0]["s"]
chip = group([
    # label + sparkbars on top, then outline, then body (bottom)
    frect(60, 5, 2.5, (-12, -22), FAINT, 100, "chiplabel"),
    frect(8, 22, 3, (30, 4), TINT3, 100, "spark5"),
    frect(8, 26, 3, (14, 2), CYAN, 100, "spark4"),
    frect(8, 14, 3, (-2, 8), TINT2, 100, "spark3"),
    frect(8, 30, 3, (-18, 0), CYAN, 100, "spark2"),
    frect(8, 18, 3, (-34, 6), TINT3, 100, "spark1"),
    srect(120, 70, 10, (0, 0), HAIR2, 2.0, 100, "chipoutline"),
    frect(120, 70, 10, (0, 0), WHITE, 100, "chipbody"),
], name="chip", tr=transform(anchor=(0, 0), pos_anim=chip_y_keys))
layers.append(layer([chip], name="floatchip", ind=nxt()))


# ════════════════════════════════════════════════════════════════
# Assemble. Lottie draws layers top-of-list = front. Our list is
# back->front, so reverse for correct z-order.
# ════════════════════════════════════════════════════════════════
# Reassign ind sequentially after reversal and fix any parent refs (none used).
ordered = list(reversed(layers))
for i, L in enumerate(ordered):
    L["ind"] = i + 1

doc = {
    "v": "5.7.6", "fr": FR, "ip": 0, "op": OP, "w": W, "h": H,
    "nm": "anglerbi-hero-flow", "ddd": 0,
    "assets": [], "layers": ordered, "markers": [],
}

out_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "assets", "hero-flow.json")
with open(out_path, "w") as f:
    json.dump(doc, f, separators=(",", ":"))

size = os.path.getsize(out_path)
print(f"wrote {out_path}  ({size} bytes, {size/1024:.1f} KB)  layers={len(ordered)}")
