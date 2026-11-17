const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const inr2 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 });
const compact = new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 });

export const money = (n) => (n == null ? '-' : inr.format(n));
export const moneyExact = (n) => (n == null ? '-' : inr2.format(n));
export const moneyShort = (n) => (n == null ? '-' : `${n < 0 ? '-' : ''}₹${compact.format(Math.abs(n))}`);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-11-15' or Date/ISO string -> '15 Nov 2026' (no timezone arithmetic) */
export function fmtDate(value, { year = true } = {}) {
  if (!value) return '-';
  const s = typeof value === 'string' ? value : new Date(value).toISOString();
  const [y, m, d] = s.slice(0, 10).split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]}${year ? ` ${y}` : ''}`;
}

export function fmtDateTime(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('en-IN', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

export function daysLabel(n) {
  if (n == null) return '';
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  return n > 0 ? `in ${n} days` : `${-n} days ago`;
}

export const PRIORITY = { 1: 'Critical', 2: 'High', 3: 'Normal', 4: 'Low', 5: 'Discretionary' };
export const titleCase = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ') : '');
