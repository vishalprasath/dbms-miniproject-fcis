// Input shaping for commitment notes (MongoDB).
import { ApiError } from './api';

export function cleanTags(input) {
  const list = Array.isArray(input) ? input : String(input ?? '').split(',');
  const tags = [...new Set(list.map((t) => String(t).trim().toLowerCase().replace(/\s+/g, '-')).filter(Boolean))];
  for (const t of tags) {
    if (!/^[a-z0-9-]{2,24}$/.test(t)) throw new ApiError(400, `Tag "${t}" must be 2-24 letters, digits or hyphens.`);
  }
  if (tags.length > 8) throw new ApiError(400, 'A note can have at most 8 tags.');
  return tags;
}

// terms arrive as [{ key, value }] and are stored as a flexible sub-document
export function cleanTerms(input) {
  const terms = {};
  for (const row of Array.isArray(input) ? input : []) {
    const key = String(row?.key ?? '').trim();
    const raw = String(row?.value ?? '').trim();
    if (!key || !raw) continue;
    if (!/^[A-Za-z][A-Za-z0-9_ ]{0,39}$/.test(key)) throw new ApiError(400, `Term name "${key}" is not valid.`);
    terms[key] = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw === 'true' ? true : raw === 'false' ? false : raw;
  }
  return terms;
}
