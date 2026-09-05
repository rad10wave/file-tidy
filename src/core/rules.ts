import type { Category } from "./types.js";

export const DEFAULT_CATEGORIES: readonly Category[] = [
  { id: "images", name: "Images", folder: "Images", enabled: true, extensions: ["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico", "tif", "tiff", "avif", "heic"] },
  { id: "videos", name: "Videos", folder: "Videos", enabled: true, extensions: ["mp4", "mkv", "webm", "mov", "avi", "wmv", "flv", "m4v", "mpeg", "mpg"] },
  { id: "audio", name: "Audio", folder: "Audio", enabled: true, extensions: ["mp3", "wav", "flac", "aac", "m4a", "ogg", "opus", "wma", "aiff"] },
  { id: "documents", name: "Documents", folder: "Documents", enabled: true, extensions: ["pdf", "doc", "docx", "txt", "rtf", "odt", "pages", "epub"] },
  { id: "spreadsheets", name: "Spreadsheets", folder: "Spreadsheets", enabled: true, extensions: ["xls", "xlsx", "xlsm", "csv", "ods", "tsv"] },
  { id: "presentations", name: "Presentations", folder: "Presentations", enabled: true, extensions: ["ppt", "pptx", "pps", "ppsx", "odp", "key"] },
  { id: "archives", name: "Archives", folder: "Archives", enabled: true, extensions: ["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "tgz", "iso"] },
  { id: "applications", name: "Applications", folder: "Applications", enabled: true, extensions: ["exe", "msi", "msix", "apk", "dmg", "pkg", "deb", "rpm", "appimage"] },
  { id: "code", name: "Code", folder: "Code", enabled: true, extensions: ["js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "java", "c", "cpp", "h", "hpp", "cs", "go", "rs", "rb", "php", "html", "htm", "css", "scss", "json", "xml", "yaml", "yml", "sql", "sh"] },
  { id: "others", name: "Others", folder: "Others", enabled: true, extensions: [] },
];

/**
 * Normalize rule aliases and filename suffixes through one code path. Rules
 * may be entered as `pdf`, `.pdf`, or with incidental surrounding whitespace.
 */
export function normalizeExtension(value: unknown): string {
  return String(value ?? "").trim().replace(/^\./, "").toLowerCase();
}

export function extensionOf(filename: string): string {
  const clean = String(filename || "").split(/[\\/]/).pop() ?? "";
  const dot = clean.lastIndexOf(".");
  return dot > 0 && dot < clean.length - 1 ? normalizeExtension(clean.slice(dot + 1)) : "";
}

export function categoryForFilename(filename: string, categories: readonly Category[] = DEFAULT_CATEGORIES): Category | undefined {
  const extension = extensionOf(filename);
  if (!extension) return undefined;
  return categories.find((category) => category.enabled
    && category.extensions.some((candidate) => normalizeExtension(candidate) === extension));
}

export function findExtensionConflicts(categories: readonly Category[] = DEFAULT_CATEGORIES): Array<{ extension: string; names: string[] }> {
  // IDs identify category ownership. A category can offer several spellings of
  // the same extension without conflicting with itself.
  const owners = new Map<string, Map<string, string>>();
  for (const category of categories) {
    if (!category.enabled) continue;
    const aliases = new Set(category.extensions.map(normalizeExtension));
    for (const extension of aliases) {
      if (!extension) continue;
      const extensionOwners = owners.get(extension) ?? new Map<string, string>();
      extensionOwners.set(category.id, category.name);
      owners.set(extension, extensionOwners);
    }
  }
  return [...owners.entries()]
    .filter(([, categoryOwners]) => categoryOwners.size > 1)
    .map(([extension, categoryOwners]) => ({ extension, names: [...categoryOwners.values()] }));
}
