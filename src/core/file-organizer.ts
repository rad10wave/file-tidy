import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { DEFAULT_CATEGORIES, categoryForFilename, findExtensionConflicts } from "./rules.js";
import type {
  Category,
  FileIdentity,
  JournalEntry,
  OperationProgress,
  OrganizationJournal,
  OrganizationOptions,
  OrganizationPlan,
  PlanEntry,
  PlanSummary,
  UndoSummary,
} from "./types.js";

const execFileAsync = promisify(execFile);
const INVALID_FOLDER_CHARACTERS = /[<>:"/\\|?*\u0000-\u001F\u007F]/;
const WINDOWS_RESERVED_FOLDER_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const PARTIAL_DOWNLOAD_EXTENSIONS = new Set([".crdownload", ".part", ".partial", ".tmp", ".download"]);
const SHORTCUT_EXTENSIONS = new Set([".lnk", ".url"]);

type AttributeMap = Map<string, string> | null;
type FolderResult = { destination: string; problem?: never } | { destination?: never; problem: string };
type RecoveryResult = { kind: "not_needed" | "moved_back" | "moved" } | { kind: "reason"; reason: string } | null;
type JournalEvent =
  | { version: 1; journalId: string; kind: "entry"; entryIndex: number; entry: JournalEntry }
  | { version: 1; journalId: string; kind: "journal"; state: OrganizationJournal["state"]; completedAt: string | null; undoCompletedAt?: string };

export class OrganizerError extends Error {}
export class SafetyError extends OrganizerError {}
export class RuleConflictError extends OrganizerError {}
class PartialMoveError extends OrganizerError {}

const WINDOWS_ATTRIBUTE_LIST_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
  "$target = [Environment]::GetEnvironmentVariable('FILE_TIDY_ATTRIBUTE_TARGET')",
  "@((Get-ChildItem -LiteralPath $target -Force -File -ErrorAction Stop | ForEach-Object { [pscustomobject]@{ Path = $_.FullName; Attributes = [string]$_.Attributes } })) | ConvertTo-Json -Compress",
].join("; ");
const WINDOWS_ATTRIBUTE_SINGLE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
  "$target = [Environment]::GetEnvironmentVariable('FILE_TIDY_ATTRIBUTE_TARGET')",
  "$item = Get-Item -LiteralPath $target -Force -ErrorAction Stop",
  "[pscustomobject]@{ Path = $item.FullName; Attributes = [string]$item.Attributes } | ConvertTo-Json -Compress",
].join("; ");

function now(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pathKey(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function safeFolderSegment(value: unknown): string | null {
  const rawFolder = String(value ?? "");
  // Windows silently normalizes trailing spaces/dots. Reject them rather than
  // constructing a preview that does not match the path it will use.
  if (rawFolder !== rawFolder.trim()) return null;
  const folder = rawFolder;
  if (!folder) return null;
  if (
    folder === "."
    || folder === ".."
    || /^[a-z]:/i.test(folder)
    || INVALID_FOLDER_CHARACTERS.test(folder)
    || /[. ]$/.test(folder)
    || WINDOWS_RESERVED_FOLDER_NAME.test(folder)
  ) return null;
  return folder;
}

async function lstatOrNull(target: string): Promise<Stats | null> {
  try {
    return await fs.lstat(target);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function exists(target: string): Promise<boolean> {
  return Boolean(await lstatOrNull(target));
}

function fileIdentity(stats: Stats | null): FileIdentity | null {
  if (!stats || stats.dev === undefined || stats.ino === undefined) return null;
  const device = String(stats.dev);
  const inode = String(stats.ino);
  // Zero is the value exposed by filesystems that cannot give us a stable ID.
  if (device === "0" || inode === "0") return null;
  return { device, inode };
}

function sameFileIdentityValue(left: FileIdentity | null, right: FileIdentity | null): boolean {
  return Boolean(left && right && left.device === right.device && left.inode === right.inode);
}

function matchesPlannedFile(
  stats: Stats | null,
  entry: Pick<PlanEntry, "size" | "mtimeMs" | "ctimeMs" | "birthtimeMs" | "fileIdentity">,
): boolean {
  return Boolean(
    stats?.isFile()
    && !stats.isSymbolicLink()
    && stats.size === entry.size
    && stats.mtimeMs === entry.mtimeMs
    && stats.ctimeMs === entry.ctimeMs
    && stats.birthtimeMs === entry.birthtimeMs
    && sameFileIdentityValue(fileIdentity(stats), entry.fileIdentity),
  );
}

/** ctime can change when a hard link is made, so do not use it after linking. */
function matchesMutationTarget(stats: Stats | null, entry: Pick<PlanEntry, "size" | "mtimeMs" | "birthtimeMs" | "fileIdentity">): boolean {
  return Boolean(
    stats?.isFile()
    && !stats.isSymbolicLink()
    && stats.size === entry.size
    && stats.mtimeMs === entry.mtimeMs
    && stats.birthtimeMs === entry.birthtimeMs
    && sameFileIdentityValue(fileIdentity(stats), entry.fileIdentity),
  );
}

function sameFileIdentity(left: Stats | null, right: Stats | null): boolean {
  return sameFileIdentityValue(fileIdentity(left), fileIdentity(right));
}

async function validatedRoot(rootValue: string): Promise<string> {
  if (!rootValue || typeof rootValue !== "string") throw new SafetyError("Choose a folder first.");
  const requested = path.resolve(rootValue);
  const requestedStats = await lstatOrNull(requested);
  if (!requestedStats?.isDirectory()) throw new SafetyError("Choose an existing folder.");
  if (requestedStats.isSymbolicLink()) throw new SafetyError("Choose a real folder, not a symbolic link or junction.");
  const root = await fs.realpath(requested);
  if (path.parse(root).root === root) throw new SafetyError("A whole drive cannot be organized. Choose a folder inside it.");
  return root;
}

async function safeDestinationFolder(root: string, folderName: string): Promise<FolderResult> {
  const safeFolder = safeFolderSegment(folderName);
  if (!safeFolder) return { problem: "Category folder is not safe" };
  const destination = path.resolve(root, safeFolder);
  if (!isInside(destination, root)) return { problem: "Destination would leave the selected folder" };
  const stats = await lstatOrNull(destination);
  if (!stats) return { destination };
  if (!stats.isDirectory() || stats.isSymbolicLink()) return { problem: "Destination folder is a file, link, or junction" };
  const realDestination = await fs.realpath(destination);
  if (!isInside(realDestination, root)) return { problem: "Destination folder would leave the selected folder" };
  return { destination: realDestination };
}

async function readWindowsAttributeJson(script: string, target: string): Promise<unknown> {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, FILE_TIDY_ATTRIBUTE_TARGET: target },
    },
  );
  const text = stdout.replace(/^\uFEFF/, "").trim();
  if (!text) return [];
  return JSON.parse(text) as unknown;
}

function attributeMapFromJson(value: unknown): Map<string, string> {
  const records = Array.isArray(value) ? value : [value];
  const attributes = new Map<string, string>();
  for (const record of records) {
    if (!record || typeof record !== "object") throw new Error("Windows attributes response was not valid");
    const pathValue = (record as { Path?: unknown }).Path;
    const flags = (record as { Attributes?: unknown }).Attributes;
    if (typeof pathValue !== "string" || typeof flags !== "string") throw new Error("Windows attributes response was incomplete");
    attributes.set(pathKey(pathValue), flags.toUpperCase());
  }
  return attributes;
}

async function readWindowsAttributes(root: string): Promise<AttributeMap> {
  if (process.platform !== "win32") return new Map();
  try {
    return attributeMapFromJson(await readWindowsAttributeJson(WINDOWS_ATTRIBUTE_LIST_SCRIPT, root));
  } catch {
    // A missing or unreadable attribute is never treated as "not hidden".
    return null;
  }
}

async function readCurrentWindowsAttributes(target: string): Promise<string | null> {
  if (process.platform !== "win32") return "";
  try {
    const records = attributeMapFromJson(await readWindowsAttributeJson(WINDOWS_ATTRIBUTE_SINGLE_SCRIPT, target));
    return records.get(pathKey(target)) ?? null;
  } catch {
    return null;
  }
}

function hiddenOrSystemReason(target: string, attributeMap: AttributeMap): string | null {
  if (path.basename(target).startsWith(".")) return "Hidden or system file";
  if (process.platform !== "win32") return null;
  if (!attributeMap) return "Windows file attributes could not be read (left unchanged for safety)";
  const attributes = attributeMap.get(pathKey(target));
  if (attributes === undefined) return "Windows file attributes could not be read for this file (left unchanged for safety)";
  return attributes.split(/[,\s]+/).some((attribute) => attribute === "HIDDEN" || attribute === "SYSTEM")
    ? "Hidden or system file"
    : null;
}

async function currentHiddenOrSystemReason(target: string): Promise<string | null> {
  if (path.basename(target).startsWith(".")) return "Source is now hidden or system file";
  if (process.platform !== "win32") return null;
  const attributes = await readCurrentWindowsAttributes(target);
  if (attributes === null) return "Windows file attributes could not be read for this file (left unchanged for safety)";
  return attributes.split(/[,\s]+/).some((attribute) => attribute === "HIDDEN" || attribute === "SYSTEM")
    ? "Source is now hidden or system file"
    : null;
}

async function nextAvailableDestination(destination: string, reserved: Set<string>): Promise<string> {
  if (!await exists(destination) && !reserved.has(pathKey(destination))) return destination;
  const parsed = path.parse(destination);
  for (let index = 1; index < 100_000; index += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name} (${index})${parsed.ext}`);
    if (!await exists(candidate) && !reserved.has(pathKey(candidate))) return candidate;
  }
  throw new OrganizerError(`Could not find a free name for ${path.basename(destination)}.`);
}

function planEntry({
  source,
  filename,
  category,
  destination = null,
  action,
  reason,
  stats,
}: {
  source: string;
  filename: string;
  category?: Category;
  destination?: string | null;
  action: PlanEntry["action"];
  reason: string;
  stats: Stats | null;
}): PlanEntry {
  return {
    source,
    filename,
    categoryId: category?.id ?? null,
    categoryName: category?.name ?? null,
    destination,
    action,
    reason,
    size: stats?.size ?? 0,
    mtimeMs: stats?.mtimeMs ?? 0,
    ctimeMs: stats?.ctimeMs ?? 0,
    birthtimeMs: stats?.birthtimeMs ?? 0,
    fileIdentity: fileIdentity(stats),
  };
}

function planSummary(entries: PlanEntry[]): PlanSummary {
  return entries.reduce<PlanSummary>((summary, entry) => {
    summary.total += 1;
    if (entry.action === "move") summary.ready += 1;
    else if (entry.action === "collision") summary.collisions += 1;
    else summary.skipped += 1;
    if (entry.action === "move" && entry.categoryName) {
      summary.byCategory[entry.categoryName] = (summary.byCategory[entry.categoryName] ?? 0) + 1;
    }
    return summary;
  }, { total: 0, ready: 0, collisions: 0, skipped: 0, byCategory: {} });
}

export async function buildPlan(
  rootValue: string,
  options: OrganizationOptions = {},
  categories: readonly Category[] = DEFAULT_CATEGORIES,
): Promise<OrganizationPlan> {
  const root = await validatedRoot(rootValue);
  const conflicts = findExtensionConflicts(categories);
  if (conflicts.length) {
    throw new RuleConflictError(`Resolve duplicate extension rules first: ${conflicts.map(({ extension }) => `.${extension}`).join(", ")}`);
  }

  const moveUnknownToOthers = Boolean(options.moveUnknownToOthers);
  const keepBothOnCollision = Boolean(options.keepBothOnCollision);
  const otherCategory = categories.find((category) => category.id === "others" && category.enabled);
  const directoryEntries = await fs.readdir(root, { withFileTypes: true });
  const windowsAttributeMap = await readWindowsAttributes(root);
  const reserved = new Set<string>();
  const entries: PlanEntry[] = [];

  for (const directoryEntry of directoryEntries.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }))) {
    const source = path.join(root, directoryEntry.name);
    try {
      const stats = await lstatOrNull(source);
      if (!stats) {
        entries.push(planEntry({ source, filename: directoryEntry.name, action: "skip", reason: "File disappeared during scan", stats: null }));
        continue;
      }

      if (stats.isDirectory()) {
        entries.push(planEntry({ source, filename: directoryEntry.name, action: "skip", reason: "Folder (folders are not scanned)", stats }));
        continue;
      }
      if (directoryEntry.isSymbolicLink() || stats.isSymbolicLink()) {
        entries.push(planEntry({ source, filename: directoryEntry.name, action: "skip", reason: "Link or junction (skipped for safety)", stats }));
        continue;
      }
      if (!stats.isFile()) {
        entries.push(planEntry({ source, filename: directoryEntry.name, action: "skip", reason: "Not a regular file", stats }));
        continue;
      }
      if (!fileIdentity(stats)) {
        entries.push(planEntry({ source, filename: directoryEntry.name, action: "skip", reason: "This file system does not provide a stable file identity", stats }));
        continue;
      }
      const protectedReason = hiddenOrSystemReason(source, windowsAttributeMap);
      if (protectedReason) {
        entries.push(planEntry({ source, filename: directoryEntry.name, action: "skip", reason: protectedReason, stats }));
        continue;
      }

      const extension = path.extname(directoryEntry.name).toLowerCase();
      if (PARTIAL_DOWNLOAD_EXTENSIONS.has(extension)) {
        entries.push(planEntry({ source, filename: directoryEntry.name, action: "skip", reason: "Incomplete download", stats }));
        continue;
      }
      if (SHORTCUT_EXTENSIONS.has(extension)) {
        entries.push(planEntry({ source, filename: directoryEntry.name, action: "skip", reason: "Shortcut (left unchanged)", stats }));
        continue;
      }

      let category = categoryForFilename(directoryEntry.name, categories);
      if (!category && moveUnknownToOthers) category = otherCategory;
      if (!category) {
        entries.push(planEntry({ source, filename: directoryEntry.name, action: "skip", reason: "No matching rule (left where it is)", stats }));
        continue;
      }

      const folder = await safeDestinationFolder(root, category.folder);
      if (folder.problem || !folder.destination) {
        entries.push(planEntry({ source, filename: directoryEntry.name, category, action: "skip", reason: folder.problem ?? "Category folder is not safe", stats }));
        continue;
      }
      const intendedDestination = path.join(folder.destination, directoryEntry.name);
      if (!isInside(intendedDestination, root)) {
        entries.push(planEntry({ source, filename: directoryEntry.name, category, action: "skip", reason: "Destination would leave the selected folder", stats }));
        continue;
      }

      const collision = await exists(intendedDestination) || reserved.has(pathKey(intendedDestination));
      if (collision && !keepBothOnCollision) {
        entries.push(planEntry({
          source,
          filename: directoryEntry.name,
          category,
          destination: intendedDestination,
          action: "collision",
          reason: "A file with this name is already there",
          stats,
        }));
        continue;
      }

      const destination = collision ? await nextAvailableDestination(intendedDestination, reserved) : intendedDestination;
      reserved.add(pathKey(destination));
      entries.push(planEntry({
        source,
        filename: directoryEntry.name,
        category,
        destination,
        action: "move",
        reason: collision ? "Renamed to keep both files" : "Ready to move",
        stats,
      }));
    } catch (error: unknown) {
      // A single protected/inaccessible file should not prevent a user from
      // reviewing the safe files beside it.
      entries.push(planEntry({
        source,
        filename: directoryEntry.name,
        action: "skip",
        reason: `Could not inspect this file safely: ${errorMessage(error)}`,
        stats: null,
      }));
    }
  }

  return {
    id: randomUUID(),
    root,
    createdAt: now(),
    options: { moveUnknownToOthers, keepBothOnCollision },
    entries,
    summary: planSummary(entries),
  };
}

function journalEventFile(journalFile: string): string {
  return `${journalFile}.events.jsonl`;
}

async function syncParentDirectory(target: string): Promise<void> {
  // Directory fsync is supported on Unix. Windows normally rejects it, so the
  // durable file flush below remains the meaningful guarantee there.
  try {
    const handle = await fs.open(path.dirname(target), "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Best-effort only: a failure here must not hide an already durable record.
  }
}

async function writeJournalSnapshot(journalFile: string, journal: OrganizationJournal): Promise<void> {
  await fs.mkdir(path.dirname(journalFile), { recursive: true });
  const temporary = `${journalFile}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(journal, null, 2), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, journalFile);
  await syncParentDirectory(journalFile);
}

async function appendJournalEvent(journalFile: string, event: JournalEvent): Promise<void> {
  await fs.mkdir(path.dirname(journalFile), { recursive: true });
  const handle = await fs.open(journalEventFile(journalFile), "a", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function persistEntry(journalFile: string, journal: OrganizationJournal, entryIndex: number): Promise<void> {
  const entry = journal.entries[entryIndex];
  if (!entry) throw new OrganizerError("The recovery record entry could not be found.");
  await appendJournalEvent(journalFile, { version: 1, journalId: journal.id, kind: "entry", entryIndex, entry });
}

async function persistJournalState(journalFile: string, journal: OrganizationJournal): Promise<void> {
  await appendJournalEvent(journalFile, {
    version: 1,
    journalId: journal.id,
    kind: "journal",
    state: journal.state,
    completedAt: journal.completedAt,
    ...(journal.undoCompletedAt ? { undoCompletedAt: journal.undoCompletedAt } : {}),
  });
}

async function compactJournal(journalFile: string, journal: OrganizationJournal): Promise<void> {
  await writeJournalSnapshot(journalFile, journal);
  try {
    await fs.unlink(journalEventFile(journalFile));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // Leaving an event log after a complete snapshot is safe: events are
      // idempotent when loaded. It can be removed on a later compaction.
    }
  }
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new OrganizerError("The last-run recovery record is not valid.");
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new OrganizerError("The last-run recovery record is not valid.");
  return value;
}

function nullableString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value !== "string" && value !== null) throw new OrganizerError("The last-run recovery record is not valid.");
  return value;
}

function requiredFiniteNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new OrganizerError("The last-run recovery record is not valid.");
  return value;
}

function nullableStringField(value: unknown): string | null {
  if (value === null || typeof value === "string") return value;
  throw new OrganizerError("The last-run recovery record is not valid.");
}

function parseFileIdentity(value: unknown): FileIdentity | null {
  if (value === null) return null;
  const record = recordOf(value);
  if (!record) throw new OrganizerError("The last-run recovery record is not valid.");
  const device = requiredString(record, "device");
  const inode = requiredString(record, "inode");
  if (!device || !inode || device === "0" || inode === "0") throw new OrganizerError("The last-run recovery record is not valid.");
  return { device, inode };
}

function parseAction(value: unknown): PlanEntry["action"] {
  if (value === "move" || value === "collision" || value === "skip") return value;
  throw new OrganizerError("The last-run recovery record is not valid.");
}

function parseStatus(value: unknown): JournalEntry["status"] {
  if (value === "pending" || value === "in_progress" || value === "moved" || value === "failed" || value === "skipped") return value;
  throw new OrganizerError("The last-run recovery record is not valid.");
}

function parseUndoStatus(value: unknown): JournalEntry["undoStatus"] {
  if (value === undefined) return undefined;
  // Version 1 wrote `skipped`. Treat it as retryable rather than making a
  // recoverable file permanently disappear from the Undo action.
  if (value === "skipped") return "retryable";
  if (value === "in_progress" || value === "moved_back" || value === "not_needed" || value === "retryable") return value;
  throw new OrganizerError("The last-run recovery record is not valid.");
}

function parseJournalEntry(value: unknown, version: 1 | 2): JournalEntry {
  const record = recordOf(value);
  if (!record) throw new OrganizerError("The last-run recovery record is not valid.");
  const categoryId = nullableStringField(record.categoryId);
  const categoryName = nullableStringField(record.categoryName);
  const destination = nullableStringField(record.destination);
  const size = requiredFiniteNumber(record, "size");
  if (size < 0) throw new OrganizerError("The last-run recovery record is not valid.");
  const mtimeMs = requiredFiniteNumber(record, "mtimeMs");
  const hasV2Fingerprint = version === 2;
  return {
    source: requiredString(record, "source"),
    filename: requiredString(record, "filename"),
    categoryId,
    categoryName,
    destination,
    action: parseAction(record.action),
    reason: requiredString(record, "reason"),
    size,
    mtimeMs,
    ctimeMs: hasV2Fingerprint ? requiredFiniteNumber(record, "ctimeMs") : 0,
    birthtimeMs: hasV2Fingerprint ? requiredFiniteNumber(record, "birthtimeMs") : 0,
    fileIdentity: hasV2Fingerprint ? parseFileIdentity(record.fileIdentity) : null,
    status: parseStatus(record.status),
    ...(optionalString(record, "startedAt") ? { startedAt: optionalString(record, "startedAt") } : {}),
    ...(optionalString(record, "movedAt") ? { movedAt: optionalString(record, "movedAt") } : {}),
    ...(optionalString(record, "failureReason") ? { failureReason: optionalString(record, "failureReason") } : {}),
    ...(parseUndoStatus(record.undoStatus) ? { undoStatus: parseUndoStatus(record.undoStatus) } : {}),
    ...(optionalString(record, "undoReason") ? { undoReason: optionalString(record, "undoReason") } : {}),
    ...(optionalString(record, "undoStartedAt") ? { undoStartedAt: optionalString(record, "undoStartedAt") } : {}),
    ...(optionalString(record, "undoneAt") ? { undoneAt: optionalString(record, "undoneAt") } : {}),
  };
}

function parseJournal(value: unknown): OrganizationJournal {
  const record = recordOf(value);
  if (!record || (record.version !== 1 && record.version !== 2) || !Array.isArray(record.entries)) {
    throw new OrganizerError("The last-run recovery record is not valid.");
  }
  const version = record.version;
  const state = record.state;
  if (state !== "running" && state !== "cancelled" && state !== "completed" && state !== "needs_recovery") {
    throw new OrganizerError("The last-run recovery record is not valid.");
  }
  const optionsRecord = recordOf(record.options);
  if (!optionsRecord || typeof optionsRecord.moveUnknownToOthers !== "boolean" || typeof optionsRecord.keepBothOnCollision !== "boolean") {
    throw new OrganizerError("The last-run recovery record is not valid.");
  }
  return {
    version,
    id: requiredString(record, "id"),
    root: requiredString(record, "root"),
    createdAt: requiredString(record, "createdAt"),
    startedAt: requiredString(record, "startedAt"),
    completedAt: nullableString(record, "completedAt"),
    state,
    options: {
      moveUnknownToOthers: optionsRecord.moveUnknownToOthers,
      keepBothOnCollision: optionsRecord.keepBothOnCollision,
    },
    entries: record.entries.map((entry) => parseJournalEntry(entry, version)),
    ...(optionalString(record, "undoCompletedAt") ? { undoCompletedAt: optionalString(record, "undoCompletedAt") } : {}),
  };
}

function parseJournalEvent(value: unknown): JournalEvent {
  const record = recordOf(value);
  if (!record || record.version !== 1 || typeof record.journalId !== "string") {
    throw new OrganizerError("The recovery event log is not valid.");
  }
  if (record.kind === "entry") {
    if (!Number.isInteger(record.entryIndex) || (record.entryIndex as number) < 0) throw new OrganizerError("The recovery event log is not valid.");
    return {
      version: 1,
      journalId: record.journalId,
      kind: "entry",
      entryIndex: record.entryIndex as number,
      entry: parseJournalEntry(record.entry, 2),
    };
  }
  if (record.kind === "journal") {
    const state = record.state;
    if (state !== "running" && state !== "cancelled" && state !== "completed" && state !== "needs_recovery") {
      throw new OrganizerError("The recovery event log is not valid.");
    }
    const completedAt = nullableString(record, "completedAt");
    const undoCompletedAt = optionalString(record, "undoCompletedAt");
    return { version: 1, journalId: record.journalId, kind: "journal", state, completedAt, ...(undoCompletedAt ? { undoCompletedAt } : {}) };
  }
  throw new OrganizerError("The recovery event log is not valid.");
}

async function applyJournalEvents(journalFile: string, journal: OrganizationJournal): Promise<OrganizationJournal> {
  let content: string;
  try {
    content = await fs.readFile(journalEventFile(journalFile), "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return journal;
    throw error;
  }
  const lines = content.split(/\r?\n/);
  const hasTrailingNewline = /\r?\n$/.test(content);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (!line.trim()) continue;
    let event: JournalEvent;
    try {
      event = parseJournalEvent(JSON.parse(line) as unknown);
    } catch (error: unknown) {
      // Intent is fsynced before a filesystem mutation. A crash while writing
      // the *last* event can therefore leave a truncated final line, while the
      // previous intent remains enough to recover safely. Treat only that form
      // as an interrupted append; any complete malformed record stays blocked.
      if (lineIndex === lines.length - 1 && !hasTrailingNewline) break;
      if (error instanceof OrganizerError) throw error;
      throw new OrganizerError("The recovery event log could not be read. It was left untouched; do not delete it if you may need to recover a run.");
    }
    // A stale log from an older snapshot is never applied to a new run.
    if (event.journalId !== journal.id) continue;
    if (event.kind === "entry") {
      if (!journal.entries[event.entryIndex]) throw new OrganizerError("The recovery event log is not valid.");
      journal.entries[event.entryIndex] = event.entry;
    } else {
      journal.state = event.state;
      journal.completedAt = event.completedAt;
      if (event.undoCompletedAt) journal.undoCompletedAt = event.undoCompletedAt;
    }
  }
  return journal;
}

function hasUnresolvedRecovery(journal: OrganizationJournal): boolean {
  return journal.entries.some((entry) => entry.status === "in_progress" || entry.undoStatus === "in_progress" || entry.undoStatus === "retryable");
}

async function prepareJournal(journalFile: string, journal: OrganizationJournal): Promise<void> {
  // Loading first protects unreadable records as well as interrupted runs.
  const previous = await loadJournal(journalFile);
  // A crash can occur after a `moved` event is durable but before the final
  // journal-state event. `running` therefore remains recovery state even when
  // no entry is currently marked in_progress.
  if (previous && (previous.state === "running" || previous.state === "needs_recovery" || hasUnresolvedRecovery(previous))) {
    throw new OrganizerError("Resolve the previous recovery items before starting another run. File Tidy kept that record so no partial move is lost.");
  }
  await writeJournalSnapshot(journalFile, journal);
  try {
    await fs.unlink(journalEventFile(journalFile));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function loadJournal(journalFile: string): Promise<OrganizationJournal | null> {
  try {
    const parsed = parseJournal(JSON.parse(await fs.readFile(journalFile, "utf8")) as unknown);
    return applyJournalEvents(journalFile, parsed);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof OrganizerError) throw error;
    throw new OrganizerError("The last-run recovery record could not be read. It was left untouched; do not delete it if you may need to recover a run.");
  }
}

async function recheckDestinationBoundary(root: string, destination: string): Promise<void> {
  const destinationParent = path.dirname(destination);
  // Undo restores directly into the validated selected root. Organize moves
  // into one child category folder, which is checked below.
  if (pathKey(destinationParent) === pathKey(root)) return;
  const folderName = path.relative(root, destinationParent);
  const folder = await safeDestinationFolder(root, folderName);
  if (folder.problem || !folder.destination) throw new SafetyError(folder.problem ?? "Category folder is not safe");
  if (pathKey(folder.destination) !== pathKey(destinationParent)) {
    throw new SafetyError("Destination folder changed since the preview");
  }
}

async function moveWithoutOverwrite(
  root: string,
  entry: JournalEntry,
  sourceValue: string,
  destination: string,
  {
    requirePreviewFingerprint = true,
    afterLinkCreated,
  }: {
    requirePreviewFingerprint?: boolean;
    /** Internal test seam for post-link recovery behavior. */
    afterLinkCreated?: () => Promise<void> | void;
  } = {},
): Promise<void> {
  const source = path.resolve(sourceValue);
  await recheckDestinationBoundary(root, destination);
  const sourceBeforeLink = await lstatOrNull(source);
  if (!(requirePreviewFingerprint ? matchesPlannedFile(sourceBeforeLink, entry) : matchesMutationTarget(sourceBeforeLink, entry))) {
    throw new SafetyError("Source changed since the preview or is no longer a safe regular file");
  }
  const protectedReason = await currentHiddenOrSystemReason(source);
  if (protectedReason) throw new SafetyError(protectedReason);
  if (await exists(destination)) throw new SafetyError("Destination appeared after the preview");

  try {
    // `link` fails atomically with EEXIST instead of replacing an existing
    // destination. The source and destination are beneath the same root, so a
    // hard-link move cannot cross volumes.
    await fs.link(source, destination);
  } catch (error: unknown) {
    // A transport/process fault can be reported after the OS made the link.
    // Preserve a destination matching the planned identity rather than assume
    // it is ours and risk deleting the only remaining copy.
    try {
      if (matchesMutationTarget(await lstatOrNull(destination), entry)) {
        throw new PartialMoveError("File Tidy could not prove whether a safe destination link was created. Both paths were preserved for recovery.");
      }
    } catch (inspectionError: unknown) {
      if (inspectionError instanceof PartialMoveError) throw inspectionError;
      throw new PartialMoveError("File Tidy could not verify the destination after a link attempt. Both paths were preserved for recovery.");
    }
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw new SafetyError("Destination appeared after the preview");
    if (["EXDEV", "EOPNOTSUPP", "ENOSYS"].includes(code ?? "")) {
      throw new SafetyError("This drive does not support File Tidy's safe no-overwrite move. The file was left unchanged.");
    }
    throw new OrganizerError(`Could not create a safe destination for ${path.basename(source)}. The original file was left unchanged.`);
  }

  try {
    await afterLinkCreated?.();
  } catch {
    throw new PartialMoveError("A destination link was created, but File Tidy could not complete its post-link checks. Both paths were preserved for recovery.");
  }

  let linkedDestination: Stats | null;
  let sourceAfterLink: Stats | null;
  try {
    linkedDestination = await lstatOrNull(destination);
    sourceAfterLink = await lstatOrNull(source);
  } catch {
    throw new PartialMoveError("A destination link may exist, but File Tidy could not verify it. Both paths were preserved for recovery.");
  }
  if (
    !matchesMutationTarget(linkedDestination, entry)
    || !matchesMutationTarget(sourceAfterLink, entry)
    || !sameFileIdentity(sourceAfterLink, linkedDestination)
  ) {
    // Never remove an ambiguous destination. A later path lookup cannot prove
    // that it is still the link this process created.
    throw new PartialMoveError("A file changed while File Tidy was moving it. No destination was deleted; review the recorded partial move.");
  }

  try {
    const sourceBeforeUnlink = await lstatOrNull(source);
    const destinationBeforeUnlink = await lstatOrNull(destination);
    if (
      !matchesMutationTarget(sourceBeforeUnlink, entry)
      || !matchesMutationTarget(destinationBeforeUnlink, entry)
      || !sameFileIdentity(sourceBeforeUnlink, destinationBeforeUnlink)
    ) {
      throw new PartialMoveError("A file changed before the original could be removed. Both paths were preserved for recovery.");
    }
    await fs.unlink(source);
  } catch (error: unknown) {
    if (error instanceof PartialMoveError) throw error;
    // Do not try to roll back by deleting the destination: after a successful
    // link, that path can no longer be conclusively owned by this process.
    throw new PartialMoveError("File Tidy could not remove the original file after creating a safe link. Both paths were preserved for recovery.");
  }

  try {
    if (!matchesMutationTarget(await lstatOrNull(destination), entry)) {
      throw new PartialMoveError("The destination changed immediately after the move. The recovery record was kept for review.");
    }
  } catch (error: unknown) {
    if (error instanceof PartialMoveError) throw error;
    throw new PartialMoveError("File Tidy could not verify the moved file. The recovery record was kept for review.");
  }
}

async function validateMove(
  entry: JournalEntry,
  root: string,
  { checkCurrentAttributes = false }: { checkCurrentAttributes?: boolean } = {},
): Promise<string | null> {
  if (!entry.destination) return "Move has no destination";
  const source = path.resolve(entry.source);
  const destination = path.resolve(entry.destination);
  if (!isInside(source, root) || !isInside(destination, root)) return "Move would leave the selected folder";
  if (pathKey(path.dirname(source)) !== pathKey(root)) return "Source is no longer a direct file in the selected folder";
  const sourceStats = await lstatOrNull(source);
  if (!matchesPlannedFile(sourceStats, entry)) return "Source changed since the preview or is no longer a safe regular file";
  if (checkCurrentAttributes) {
    const protectedReason = await currentHiddenOrSystemReason(source);
    if (protectedReason) return protectedReason;
  }
  if (await exists(destination)) return "Destination appeared after the preview";
  try {
    await recheckDestinationBoundary(root, destination);
  } catch (error: unknown) {
    return errorMessage(error);
  }
  return null;
}

export async function executePlan(
  plan: OrganizationPlan,
  journalFile: string,
  { isCancelled = () => false, onProgress = () => {}, beforeNoOverwriteMove, afterSafeLinkCreated }: {
    isCancelled?: () => boolean;
    onProgress?: (payload: OperationProgress) => void;
    /** Internal test seam for validating no-overwrite behavior. */
    beforeNoOverwriteMove?: (entry: JournalEntry) => Promise<void> | void;
    /** Internal test seam for validating recovery after a link was created. */
    afterSafeLinkCreated?: (entry: JournalEntry) => Promise<void> | void;
  } = {},
): Promise<OrganizationJournal> {
  const root = await validatedRoot(plan.root);
  const entries: JournalEntry[] = plan.entries.map((entry) => ({
    ...entry,
    status: entry.action === "move" ? "pending" : "skipped",
  }));
  const journal: OrganizationJournal = {
    version: 2,
    id: plan.id,
    root,
    createdAt: plan.createdAt,
    startedAt: now(),
    completedAt: null,
    state: "running",
    options: plan.options,
    entries,
  };
  await prepareJournal(journalFile, journal);

  const moveEntries = entries
    .map((entry, entryIndex) => ({ entry, entryIndex }))
    .filter(({ entry }) => entry.action === "move");
  let completed = 0;
  for (const { entry, entryIndex } of moveEntries) {
    if (isCancelled()) {
      journal.state = "cancelled";
      await persistJournalState(journalFile, journal);
      break;
    }

    try {
      const problem = await validateMove(entry, root);
      if (problem) throw new SafetyError(problem);
      await fs.mkdir(path.dirname(entry.destination as string), { recursive: true });
      const postCreateProblem = await validateMove(entry, root);
      if (postCreateProblem) throw new SafetyError(postCreateProblem);

      // Persist intent before touching the file. An interrupted link/unlink is
      // reconciled conservatively by Undo instead of silently lost.
      entry.status = "in_progress";
      entry.startedAt = now();
      await persistEntry(journalFile, journal, entryIndex);
      await beforeNoOverwriteMove?.(entry);
      await moveWithoutOverwrite(root, entry, entry.source, entry.destination as string, {
        afterLinkCreated: () => afterSafeLinkCreated?.(entry),
      });
      entry.status = "moved";
      entry.movedAt = now();
    } catch (error: unknown) {
      entry.failureReason = errorMessage(error);
      // Once a link may have been created, retain an in-progress record even
      // for unexpected errors. It is the only safe representation of an
      // operation whose final filesystem state is not known.
      entry.status = error instanceof PartialMoveError ? "in_progress" : "failed";
    }

    completed += 1;
    await persistEntry(journalFile, journal, entryIndex);
    onProgress({ phase: "organize", current: completed, total: moveEntries.length, filename: entry.filename });
  }

  if (hasUnresolvedRecovery(journal)) journal.state = "needs_recovery";
  else if (journal.state === "running") journal.state = "completed";
  journal.completedAt = now();
  await persistJournalState(journalFile, journal);
  await compactJournal(journalFile, journal);
  return journal;
}

function isUndoCandidate(entry: JournalEntry): boolean {
  return (entry.status === "moved" || entry.status === "in_progress")
    && (!entry.undoStatus || entry.undoStatus === "in_progress" || entry.undoStatus === "retryable");
}

async function validateUndoPaths(entry: JournalEntry, root: string): Promise<{ source: string; destination: string; reason: string | null }> {
  if (!entry.destination) return { source: entry.source, destination: "", reason: "Move has no destination" };
  const source = path.resolve(entry.source);
  const destination = path.resolve(entry.destination);
  if (!isInside(source, root) || !isInside(destination, root)) return { source, destination, reason: "Path is no longer inside the original folder" };
  if (pathKey(path.dirname(source)) !== pathKey(root)) return { source, destination, reason: "Original location is no longer a direct path in the original folder" };
  try {
    await recheckDestinationBoundary(root, destination);
  } catch (error: unknown) {
    return { source, destination, reason: errorMessage(error) };
  }
  return { source, destination, reason: null };
}

async function recoverInterruptedMove(entry: JournalEntry, source: string, destination: string): Promise<RecoveryResult> {
  let sourceStats: Stats | null;
  let destinationStats: Stats | null;
  try {
    sourceStats = await lstatOrNull(source);
    destinationStats = await lstatOrNull(destination);
  } catch {
    return { kind: "reason", reason: "File Tidy could not inspect an interrupted move safely" };
  }
  const recoveryWasUndo = entry.undoStatus === "in_progress";
  const recoveryWasMove = entry.status === "in_progress" && !entry.undoStatus;
  if (!recoveryWasUndo && !recoveryWasMove) return null;

  if (sourceStats && !destinationStats) {
    if (!matchesMutationTarget(sourceStats, entry)) {
      return { kind: "reason", reason: "The surviving file from an interrupted operation no longer matches the planned file" };
    }
    // If an interrupted organize had not unlinked its source, no restore is
    // needed. If an interrupted undo did, the original already exists again.
    return { kind: recoveryWasUndo ? "moved_back" : "not_needed" };
  }
  if (!sourceStats && destinationStats) {
    if (!matchesMutationTarget(destinationStats, entry)) {
      return { kind: "reason", reason: "The surviving file from an interrupted operation no longer matches the planned file" };
    }
    // The hard link was followed by unlinking the original, but the status
    // event was not durably recorded. Finish the user's Undo request below.
    return recoveryWasMove ? { kind: "moved" } : null;
  }
  if (sourceStats && destinationStats) {
    if (matchesMutationTarget(sourceStats, entry)
      && matchesMutationTarget(destinationStats, entry)
      && sameFileIdentity(sourceStats, destinationStats)) {
      // Do not delete either path: identity proves equality, not ownership of
      // the path that currently contains the second link.
      return { kind: "reason", reason: "An interrupted move left both paths linked to the planned file. File Tidy preserved both; review this recovery item before continuing." };
    }
    return { kind: "reason", reason: "A partial move could not be verified safely" };
  }
  return { kind: "reason", reason: "Neither path from an interrupted move could be found" };
}

export async function undoLastRun(
  journalFile: string,
  { onProgress = () => {}, beforeRestoreMove }: {
    onProgress?: (payload: OperationProgress) => void;
    /** Internal test seam for validating no-overwrite behavior. */
    beforeRestoreMove?: (entry: JournalEntry) => Promise<void> | void;
  } = {},
): Promise<UndoSummary> {
  const journal = await loadJournal(journalFile);
  if (!journal) throw new OrganizerError("There is no previous run to undo.");
  const root = await validatedRoot(journal.root);
  const candidates = journal.entries
    .map((entry, entryIndex) => ({ entry, entryIndex }))
    .filter(({ entry }) => isUndoCandidate(entry))
    .reverse();
  if (!candidates.length) throw new OrganizerError("The last run has no moves that can be undone.");

  const summary: UndoSummary = { movedBack: 0, skipped: 0, notNeeded: 0, unresolved: 0, total: candidates.length };
  for (let index = 0; index < candidates.length; index += 1) {
    const { entry, entryIndex } = candidates[index];
    let filename = entry.filename;
    try {
      const { source, destination, reason: pathReason } = await validateUndoPaths(entry, root);
      filename = path.basename(destination || source) || entry.filename;
      let reason = pathReason;

      if (!reason) {
        const recovered = await recoverInterruptedMove(entry, source, destination);
        if (recovered?.kind === "moved_back") {
          entry.undoStatus = "moved_back";
          entry.undoneAt = now();
          summary.movedBack += 1;
          await persistEntry(journalFile, journal, entryIndex);
          onProgress({ phase: "undo", current: index + 1, total: candidates.length, filename });
          continue;
        }
        if (recovered?.kind === "not_needed") {
          entry.undoStatus = "not_needed";
          entry.undoReason = "The interrupted move never removed the original file.";
          summary.notNeeded += 1;
          await persistEntry(journalFile, journal, entryIndex);
          onProgress({ phase: "undo", current: index + 1, total: candidates.length, filename });
          continue;
        }
        if (recovered?.kind === "moved") {
          entry.status = "moved";
          entry.movedAt ??= now();
          await persistEntry(journalFile, journal, entryIndex);
        } else if (recovered?.kind === "reason") {
          entry.undoStatus = "in_progress";
          entry.undoReason = recovered.reason;
          summary.unresolved += 1;
          await persistEntry(journalFile, journal, entryIndex);
          onProgress({ phase: "undo", current: index + 1, total: candidates.length, filename });
          continue;
        }
      }

      if (!reason && !entry.fileIdentity) {
        reason = "This recovery record was created by an older File Tidy version and lacks the file identity required for a safe automatic Undo";
      }
      if (!reason && await exists(source)) reason = "Original location now contains a file";
      if (!reason) {
        const destinationStats = await lstatOrNull(destination);
        if (!matchesMutationTarget(destinationStats, entry)) reason = "Organized file is missing, changed, or no longer matches the planned file";
      }

      if (reason) {
        // A collision or permission/path change can be fixed by the user. Keep
        // the candidate in the recovery record instead of making it vanish.
        entry.undoStatus = "retryable";
        entry.undoReason = reason;
        summary.skipped += 1;
      } else {
        // Persist undo intent before creating the safe link so a close/crash can
        // be reconciled on the next Undo request.
        entry.undoStatus = "in_progress";
        entry.undoStartedAt = now();
        await persistEntry(journalFile, journal, entryIndex);
        try {
          await beforeRestoreMove?.(entry);
          await moveWithoutOverwrite(root, entry, destination, source, { requirePreviewFingerprint: false });
          entry.undoStatus = "moved_back";
          entry.undoneAt = now();
          summary.movedBack += 1;
        } catch (error: unknown) {
          entry.undoReason = errorMessage(error);
          if (error instanceof PartialMoveError) {
            entry.undoStatus = "in_progress";
            summary.unresolved += 1;
          } else {
            entry.undoStatus = "retryable";
            summary.skipped += 1;
          }
        }
      }
    } catch (error: unknown) {
      entry.undoStatus = "retryable";
      entry.undoReason = errorMessage(error);
      summary.skipped += 1;
    }

    await persistEntry(journalFile, journal, entryIndex);
    onProgress({ phase: "undo", current: index + 1, total: candidates.length, filename });
  }

  journal.undoCompletedAt = now();
  journal.state = hasUnresolvedRecovery(journal) ? "needs_recovery" : "completed";
  await persistJournalState(journalFile, journal);
  await compactJournal(journalFile, journal);
  return summary;
}

export function canUndo(journal: OrganizationJournal | null): boolean {
  return Boolean(journal?.entries.some(isUndoCandidate));
}
