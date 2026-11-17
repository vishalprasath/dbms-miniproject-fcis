#!/usr/bin/env python3
"""Draws the FCIS entity-relationship diagram (Chen notation) as SVG.

    python3 scripts/make_er_diagram.py      ->  docs/er-diagram.svg

Entities are rectangles, attributes are ovals (primary keys underlined),
relationships are diamonds, and the 1 / N marks give the cardinality.
"""
import math
import os

W, H = 2200, 1700
RX, RY = 250, 162            # radius of the ring of attributes around an entity
EW, EH = 210, 58             # entity box
DW, DH = 150, 76             # relationship diamond

ENTITIES = {
    'CATEGORIES':          (1100, 215, ['*category_id', 'name', 'direction']),
    'COUNTERPARTIES':      (1850, 215, ['*counterparty_id', 'name', 'kind', 'contact_email', 'phone', 'reliability_score']),
    'BANK_ACCOUNTS':       (350, 640,  ['*account_id', 'account_name', 'bank_name', 'account_type', 'current_balance',
                                        'min_buffer', 'overdraft_limit', 'is_active']),
    'COMMITMENTS':         (1100, 640, ['*commitment_id', 'title', 'direction', 'amount', 'frequency', 'start_date',
                                        'end_date', 'priority', 'is_flexible', 'status']),
    'COMMITMENT_SCHEDULE': (1850, 640, ['*schedule_id', 'due_date', 'original_due_date', 'amount_due', 'amount_paid',
                                        'status', 'paid_on']),
    'FORECAST_RUNS':       (350, 1065, ['*run_id', 'batch_id', 'run_at', 'horizon_days',
                                        'min_projected_balance', 'shortfall_days']),
    'USERS':               (1100, 1065, ['*user_id', 'full_name', 'email', 'password_hash', 'role', 'is_active']),
    'TRANSACTIONS':        (1850, 1065, ['*txn_id', 'txn_date', 'direction', 'amount', 'narration', 'txn_kind']),
    'SHORTFALL_ALERTS':    (350, 1470, ['*alert_id', 'shortfall_start', 'shortfall_end', 'deficit', 'severity', 'status',
                                        'min_projected_balance']),
    'AUDIT_LOG':           (1100, 1470, ['*audit_id', 'table_name', 'action', 'row_pk', 'changed_by', 'changed_at',
                                         'old_data', 'new_data']),
}

# (name, "one" side, "many" side, diamond centre or None for the midpoint)
RELATIONSHIPS = [
    ('classifies',    'CATEGORIES',          'COMMITMENTS',         None),
    ('party to',      'COUNTERPARTIES',      'COMMITMENTS',         None),
    ('funds',         'BANK_ACCOUNTS',       'COMMITMENTS',         None),
    ('expands into',  'COMMITMENTS',         'COMMITMENT_SCHEDULE', None),
    ('settled by',    'COMMITMENT_SCHEDULE', 'TRANSACTIONS',        None),
    ('creates',       'USERS',               'COMMITMENTS',         None),
    ('records',       'USERS',               'TRANSACTIONS',        None),
    ('runs',          'USERS',               'FORECAST_RUNS',       None),
    ('projected in',  'BANK_ACCOUNTS',       'FORECAST_RUNS',       None),
    ('raises',        'FORECAST_RUNS',       'SHORTFALL_ALERTS',    None),
    ('acknowledges',  'USERS',               'SHORTFALL_ALERTS',    None),
    ('holds',         'BANK_ACCOUNTS',       'TRANSACTIONS',        (725, 852)),
    ('affects',       'BANK_ACCOUNTS',       'SHORTFALL_ALERTS',    (78, 1065)),
]
SELF = ('parent of', 'CATEGORIES', (800, 100))

out = []
add = out.append


def edge_point(cx, cy, tx, ty):
    """Where the line from an entity's centre towards (tx, ty) leaves its box."""
    dx, dy = tx - cx, ty - cy
    if dx == 0 and dy == 0:
        return cx, cy
    sx = (EW / 2) / abs(dx) if dx else 1e9
    sy = (EH / 2) / abs(dy) if dy else 1e9
    s = min(sx, sy)
    return cx + dx * s, cy + dy * s


def diamond_point(cx, cy, tx, ty):
    dx, dy = tx - cx, ty - cy
    s = 1 / (abs(dx) / (DW / 2) + abs(dy) / (DH / 2))
    return cx + dx * s, cy + dy * s


blocked = {name: [] for name in ENTITIES}    # directions already used by relationship lines
lines, diamonds, marks = [], [], []

for label, one, many, pos in RELATIONSHIPS:
    ax, ay, _ = ENTITIES[one]
    bx, by, _ = ENTITIES[many]
    mx, my = pos if pos else ((ax + bx) / 2, (ay + by) / 2)
    for (ex, ey, name, card) in ((ax, ay, one, '1'), (bx, by, many, 'N')):
        p = edge_point(ex, ey, mx, my)
        q = diamond_point(mx, my, ex, ey)
        lines.append((p, q))
        blocked[name].append(math.degrees(math.atan2(my - ey, mx - ex)))
        # cardinality mark a little way out from the entity box
        d = math.hypot(q[0] - p[0], q[1] - p[1]) or 1
        ux, uy = (q[0] - p[0]) / d, (q[1] - p[1]) / d
        marks.append((p[0] + ux * 36 - uy * 14, p[1] + uy * 36 + ux * 14, card))
    diamonds.append((mx, my, label))

# recursive relationship on CATEGORIES
label, ent, (mx, my) = SELF
cx, cy, _ = ENTITIES[ent]
for (tx, ty, card) in ((cx - EW / 2, cy - 8, '1'), (cx - 40, cy - EH / 2, 'N')):
    q = diamond_point(mx, my, tx, ty)
    lines.append(((tx, ty), q))
    marks.append((tx - 20 if card == '1' else tx - 16, ty - 16 if card == '1' else ty - 22, card))
    blocked[ent].append(math.degrees(math.atan2(my - cy, mx - cx)))
blocked[ent].append(200)
# keep the left side of FORECAST_RUNS clear for the 'affects' relationship
blocked['FORECAST_RUNS'] += [165, 195]
diamonds.append((mx, my, label))


def free_angles(name, n):
    """n directions around an entity, evenly spread over the gaps between its relationship lines."""
    cand = [a for a in range(0, 360, 2)
            if all(min(abs(a - b % 360), 360 - abs(a - b % 360)) > 21 for b in blocked[name])]
    step = len(cand) / n
    return [cand[int(i * step + step / 2)] for i in range(n)]


add(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" '
    f'font-family="Helvetica, Arial, sans-serif">')
add(f'<rect width="{W}" height="{H}" fill="#ffffff"/>')
add('<text x="60" y="64" font-size="30" font-weight="700" fill="#101a2c">FCIS: Entity-Relationship Diagram</text>')
add('<text x="60" y="96" font-size="17" fill="#4b5563">Financial Commitment Intelligence System, PostgreSQL schema fcis (Chen notation)</text>')

# attribute connectors first, so everything else is drawn over them
attr_shapes = []
for name, (cx, cy, attrs) in ENTITIES.items():
    for i, (attr, ang) in enumerate(zip(attrs, free_angles(name, len(attrs)))):
        scale = 1.0 if i % 2 == 0 else 0.66
        if len(attrs) <= 6:
            scale = 0.95 if i % 2 == 0 else 0.8
        ax = cx + RX * scale * math.cos(math.radians(ang))
        ay = cy + RY * scale * math.sin(math.radians(ang))
        add(f'<line x1="{cx}" y1="{cy}" x2="{ax:.0f}" y2="{ay:.0f}" stroke="#9aa3b2" stroke-width="1.2"/>')
        attr_shapes.append((ax, ay, attr))

for (p, q) in lines:
    add(f'<line x1="{p[0]:.0f}" y1="{p[1]:.0f}" x2="{q[0]:.0f}" y2="{q[1]:.0f}" stroke="#101a2c" stroke-width="2"/>')

for ax, ay, attr in attr_shapes:
    key = attr.startswith('*')
    text = attr.lstrip('*')
    rx = max(46, len(text) * 4.6 + 16)
    add(f'<ellipse cx="{ax:.0f}" cy="{ay:.0f}" rx="{rx:.0f}" ry="17" fill="#ffffff" stroke="#6b7280" stroke-width="1.3"/>')
    deco = ' text-decoration="underline" font-weight="700"' if key else ''
    add(f'<text x="{ax:.0f}" y="{ay + 5:.0f}" font-size="14" text-anchor="middle" fill="#111827"{deco}>{text}</text>')

for mx, my, label in diamonds:
    pts = f'{mx},{my - DH / 2} {mx + DW / 2},{my} {mx},{my + DH / 2} {mx - DW / 2},{my}'
    add(f'<polygon points="{pts}" fill="#e8f1fc" stroke="#1c5cab" stroke-width="2"/>')
    add(f'<text x="{mx}" y="{my + 5}" font-size="15" text-anchor="middle" fill="#123f78" font-weight="600">{label}</text>')

for name, (cx, cy, _) in ENTITIES.items():
    add(f'<rect x="{cx - EW / 2}" y="{cy - EH / 2}" width="{EW}" height="{EH}" fill="#101a2c" stroke="#101a2c" stroke-width="2" rx="3"/>')
    add(f'<text x="{cx}" y="{cy + 6}" font-size="16" font-weight="700" text-anchor="middle" fill="#ffffff">{name}</text>')

for x, y, card in marks:
    add(f'<text x="{x:.0f}" y="{y + 5:.0f}" font-size="17" font-weight="700" text-anchor="middle" fill="#c22f2f">{card}</text>')

# legend
lx, ly = 1500, 1330
add(f'<rect x="{lx}" y="{ly}" width="640" height="262" fill="#f9fafb" stroke="#cfd3da" rx="8"/>')
add(f'<text x="{lx + 22}" y="{ly + 34}" font-size="17" font-weight="700" fill="#101a2c">Legend</text>')
add(f'<rect x="{lx + 22}" y="{ly + 52}" width="70" height="28" fill="#101a2c" rx="3"/>')
add(f'<text x="{lx + 110}" y="{ly + 71}" font-size="15" fill="#111827">Entity (table)</text>')
add(f'<ellipse cx="{lx + 57}" cy="{ly + 106}" rx="35" ry="14" fill="#fff" stroke="#6b7280"/>')
add(f'<text x="{lx + 110}" y="{ly + 111}" font-size="15" fill="#111827">Attribute; <tspan text-decoration="underline" font-weight="700">underlined</tspan> = primary key</text>')
add(f'<polygon points="{lx + 57},{ly + 130} {lx + 92},{ly + 146} {lx + 57},{ly + 162} {lx + 22},{ly + 146}" fill="#e8f1fc" stroke="#1c5cab" stroke-width="2"/>')
add(f'<text x="{lx + 110}" y="{ly + 151}" font-size="15" fill="#111827">Relationship; <tspan fill="#c22f2f" font-weight="700">1</tspan> and <tspan fill="#c22f2f" font-weight="700">N</tspan> give the cardinality</text>')
notes = [
    'Every relationship is one-to-many and becomes a foreign key on the N side.',
    'CATEGORIES is recursive (parent_id). AUDIT_LOG is written by triggers and',
    'has no foreign keys, so history survives the deletion of the rows it describes.',
]
for i, t in enumerate(notes):
    add(f'<text x="{lx + 22}" y="{ly + 190 + i * 22}" font-size="14" fill="#4b5563">{t}</text>')
add('</svg>')

dest = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'docs', 'er-diagram.svg')
with open(dest, 'w') as f:
    f.write('\n'.join(out))
print('wrote', os.path.normpath(dest))
