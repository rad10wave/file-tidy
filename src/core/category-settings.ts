import type { Category } from './types.js';
import { findExtensionConflicts, normalizeExtension } from './rules.js';

export function validateCategories(value: unknown): Category[] {
  if (!Array.isArray(value) || value.length > 100 || value.length === 0) throw new Error('Keep between 1 and 100 categories.');
  const ids = new Set<string>();
  const categories = value.map((raw): Category => {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid category.');
    const { id, name, folder, enabled, extensions } = raw;
    if (typeof id !== 'string' || !id || ids.has(id)) throw new Error('Category IDs must be unique.');
    ids.add(id);
    if (typeof name !== 'string' || !name.trim() || name.length > 80) throw new Error('Give every category a name (up to 80 characters).');
    if (typeof folder !== 'string' || !folder || folder.length > 100 || folder !== folder.trim()
      || /[<>:"/\\|?*\u0000-\u001f]/.test(folder) || /[. ]$/.test(folder)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(folder)) throw new Error(`${name}: use a single folder name without path separators or reserved characters.`);
    if (typeof enabled !== 'boolean' || !Array.isArray(extensions) || extensions.some((item) => typeof item !== 'string')) throw new Error(`${name}: invalid file types.`);
    const normalized = [...new Set(extensions.map(normalizeExtension))].filter(Boolean);
    if (normalized.some((item) => !/^[a-z0-9][a-z0-9_+-]*$/.test(item))) throw new Error(`${name}: enter file extensions such as jpg, png, or pdf.`);
    return { id, name: name.trim(), folder, enabled, extensions: normalized };
  });
  const conflicts = findExtensionConflicts(categories);
  if (conflicts.length) throw new Error(`File types belong to more than one active category: ${conflicts.map((item) => '.' + item.extension).join(', ')}. Remove the duplicate rules first.`);
  return categories;
}
