import { PRIORITY, titleCase } from '@/lib/format';

const STATUS_CLASS = {
  active: 'b-good', paused: 'b-warn', closed: 'b-neutral',
  pending: 'b-info', partial: 'b-warn', paid: 'b-good', overdue: 'b-critical', waived: 'b-neutral',
  open: 'b-critical', acknowledged: 'b-warn', resolved: 'b-good', superseded: 'b-neutral',
  credit: 'b-good', debit: 'b-neutral', inflow: 'b-good', outflow: 'b-neutral',
  admin: 'b-critical', analyst: 'b-info', viewer: 'b-neutral',
  INSERT: 'b-good', UPDATE: 'b-info', DELETE: 'b-critical',
};
const SEVERITY_CLASS = { critical: 'b-critical', high: 'b-serious', medium: 'b-warn', low: 'b-neutral' };
const PRIORITY_CLASS = { 1: 'b-critical', 2: 'b-serious', 3: 'b-info', 4: 'b-neutral', 5: 'b-neutral' };

export const StatusBadge = ({ value }) => (
  <span className={`badge ${STATUS_CLASS[value] ?? 'b-neutral'}`}>{titleCase(String(value).toLowerCase())}</span>
);
export const SeverityBadge = ({ value }) => (
  <span className={`badge ${SEVERITY_CLASS[value] ?? 'b-neutral'}`}>{titleCase(value)}</span>
);
export const PriorityBadge = ({ value }) => (
  <span className={`badge plain ${PRIORITY_CLASS[value]}`}>P{value} {PRIORITY[value]}</span>
);
export const DirectionLabel = ({ value }) => (
  <span className={value === 'inflow' ? 'pos' : 'muted'}>{value === 'inflow' ? '↓ Inflow' : '↑ Outflow'}</span>
);

export function Stat({ label, value, note, alert }) {
  return (
    <div className={`stat ${alert ? 'alert' : ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {note ? <div className="stat-note">{note}</div> : null}
    </div>
  );
}

export function Card({ title, sub, actions, children, flush }) {
  return (
    <section className="card">
      {title ? (
        <div className="card-head">
          <h2>{title} {sub ? <span className="sub">&nbsp;{sub}</span> : null}</h2>
          {actions}
        </div>
      ) : null}
      <div className={`card-body ${flush ? 'flush' : ''}`}>{children}</div>
    </section>
  );
}

export function PageHead({ title, children, actions }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {children ? <p>{children}</p> : null}
      </div>
      {actions}
    </div>
  );
}

/** Small generic table for query results: columns are taken from the first row. */
export function ResultTable({ rows, format = {} }) {
  if (!rows?.length) return <div className="empty">No rows.</div>;
  const cols = Object.keys(rows[0]);
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>{cols.map((c) => <th key={c} className={typeof rows[0][c] === 'number' ? 'num' : ''}>{c.replace(/_/g, ' ')}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c} className={typeof r[c] === 'number' ? 'num' : ''}>
                  {format[c] ? format[c](r[c], r) : r[c] === null ? <span className="muted">-</span> : String(r[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
