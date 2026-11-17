'use client';

import { useMemo, useRef, useState } from 'react';
import { fmtDate, money, moneyShort } from '@/lib/format';

const W = 760;
const H = 270;
const M = { top: 16, right: 18, bottom: 30, left: 62 };

function niceTicks(min, max, count = 4) {
  const span = max - min || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-6; v += step) ticks.push(Math.round(v));
  return ticks;
}

/**
 * Projected balance of one account, day by day.
 * points: [{ date, balance, inflow, outflow, shortfall, items }]
 */
export default function BalanceChart({ points, threshold }) {
  const wrap = useRef(null);
  const [hover, setHover] = useState(null);

  const geo = useMemo(() => {
    const values = points.map((p) => p.balance).concat([threshold]);
    let lo = Math.min(...values);
    let hi = Math.max(...values);
    const pad = (hi - lo || 1) * 0.1;
    lo -= pad;
    hi += pad;
    const iw = W - M.left - M.right;
    const ih = H - M.top - M.bottom;
    const x = (i) => M.left + (points.length === 1 ? iw / 2 : (i / (points.length - 1)) * iw);
    const y = (v) => M.top + (1 - (v - lo) / (hi - lo)) * ih;
    const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.balance).toFixed(1)}`).join(' ');
    const area = `${line} L${x(points.length - 1).toFixed(1)},${M.top + ih} L${x(0).toFixed(1)},${M.top + ih} Z`;

    // continuous runs of shortfall days -> shaded bands
    const bands = [];
    points.forEach((p, i) => {
      if (!p.shortfall) return;
      const last = bands[bands.length - 1];
      if (last && last.to === i - 1) last.to = i;
      else bands.push({ from: i, to: i });
    });
    const half = points.length > 1 ? iw / (points.length - 1) / 2 : 6;
    const xTicks = [];
    const every = Math.max(1, Math.round(points.length / 7));
    for (let i = 0; i < points.length; i += every) xTicks.push(i);
    return { x, y, line, area, bands, half, iw, ih, yTicks: niceTicks(lo, hi), xTicks };
  }, [points, threshold]);

  function onMove(e) {
    const rect = wrap.current.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - M.left) / geo.iw) * (points.length - 1));
    if (i < 0 || i >= points.length) return setHover(null);
    setHover({ i, left: (geo.x(i) / W) * rect.width, flip: geo.x(i) > W * 0.62 });
  }

  const hp = hover ? points[hover.i] : null;

  return (
    <div className="chart" ref={wrap} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Projected account balance by day, with the minimum safe balance marked">
        {geo.yTicks.map((t) => (
          <g key={t}>
            <line x1={M.left} x2={W - M.right} y1={geo.y(t)} y2={geo.y(t)} stroke="#e9ebef" strokeWidth="1" />
            <text x={M.left - 8} y={geo.y(t) + 4} textAnchor="end" fontSize="11" fill="#8a909c">{moneyShort(t)}</text>
          </g>
        ))}
        {geo.bands.map((b) => (
          <rect
            key={b.from}
            x={geo.x(b.from) - geo.half}
            width={geo.x(b.to) - geo.x(b.from) + geo.half * 2}
            y={M.top}
            height={geo.ih}
            fill="#c22f2f"
            opacity="0.09"
          />
        ))}
        <path d={geo.area} fill="#2a78d6" opacity="0.07" />
        <line
          x1={M.left} x2={W - M.right} y1={geo.y(threshold)} y2={geo.y(threshold)}
          stroke="#c22f2f" strokeWidth="1.5" strokeDasharray="5 4"
        />
        <path d={geo.line} fill="none" stroke="#2a78d6" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {geo.xTicks.map((i) => (
          <text key={i} x={geo.x(i)} y={H - 9} textAnchor="middle" fontSize="11" fill="#8a909c">
            {fmtDate(points[i].date, { year: false })}
          </text>
        ))}
        {hp ? (
          <g>
            <line x1={geo.x(hover.i)} x2={geo.x(hover.i)} y1={M.top} y2={M.top + geo.ih} stroke="#8a909c" strokeWidth="1" />
            <circle cx={geo.x(hover.i)} cy={geo.y(hp.balance)} r="5" fill={hp.shortfall ? '#c22f2f' : '#2a78d6'} stroke="#fff" strokeWidth="2" />
          </g>
        ) : null}
      </svg>
      {hp ? (
        <div
          className="chart-tip"
          style={{ top: 8, left: hover.flip ? undefined : hover.left + 14, right: hover.flip ? `calc(100% - ${hover.left - 14}px)` : undefined }}
        >
          <div className="tip-date">{fmtDate(hp.date)}{hp.shortfall ? ' · shortfall' : ''}</div>
          <div className="tip-row"><span>Projected balance</span><b>{money(hp.balance)}</b></div>
          <div className="tip-row"><span>Expected in</span><b>{money(hp.inflow)}</b></div>
          <div className="tip-row"><span>Committed out</span><b>{money(hp.outflow)}</b></div>
          {hp.items?.length ? (
            <div className="tip-items">
              {hp.items.slice(0, 4).map((it) => (
                <div key={it.scheduleId} className="tip-row">
                  <span>{it.direction === 'inflow' ? '+' : '−'} {it.title.slice(0, 26)}</span>
                  <b>{moneyShort(it.amount)}</b>
                </div>
              ))}
              {hp.items.length > 4 ? <div>and {hp.items.length - 4} more</div> : null}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="legend" style={{ marginTop: 6 }}>
        <span><i style={{ borderColor: '#2a78d6' }} />Projected balance</span>
        <span><i className="dash" style={{ borderColor: '#c22f2f' }} />Minimum safe balance ({money(threshold)})</span>
        <span><i className="box" style={{ background: 'rgba(194,47,47,0.18)' }} />Shortfall days</span>
      </div>
    </div>
  );
}
