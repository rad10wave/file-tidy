import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { buildPlan, executePlan, loadJournal, undoLastRun } from "../src/core/file-organizer.ts";
import { categoryForFilename, DEFAULT_CATEGORIES, findExtensionConflicts } from "../src/core/rules.ts";
import type { Category, OrganizationJournal } from "../src/core/types.ts";
import { validateCategories } from '../src/core/category-settings.ts';

const execFileAsync = promisify(execFile);

test('saved custom categories route files into the configured folder and support undo', async (t) => {
  const root = await temporaryFolder(t);
  const categories = validateCategories([{ id: 'design', name: 'Design', folder: 'Design assets', enabled: true, extensions: [' .PSD ', 'fig'] }]);
  await fs.writeFile(path.join(root, 'mockup.psd'), 'design');
  const plan = await buildPlan(root, {}, categories);
  assert.equal(plan.entries[0].destination, path.join(root, 'Design assets', 'mockup.psd'));
  const journal = path.join(root, 'journal', 'last-run.json');
  await executePlan(plan, journal);
  assert.equal((await undoLastRun(journal)).movedBack, 1);
});

test('category settings reject conflicting rules and unsafe destination paths', () => {
  const rule = { id: 'design', name: 'Design', folder: 'Design', enabled: true, extensions: ['psd'] };
  assert.throws(() => validateCategories([rule, { ...rule, id: 'other' }]), /more than one/);
  for (const folder of ['../outside', 'C:\\other', 'CON', 'trailing ']) {
    assert.throws(() => validateCategories([{ ...rule, folder }]), /folder name/);
  }
});

async function temporaryFolder(t: test.TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-tidy-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

const FIXED_FILE_TIME_MS = Date.parse("2020-01-02T03:04:05.000Z");

async function writeWithFixedTimestamp(target: string, contents: string): Promise<void> {
  await fs.writeFile(target, contents, "utf8");
  const timestamp = new Date(FIXED_FILE_TIME_MS);
  await fs.utimes(target, timestamp, timestamp);
}

test("classifies every default category and leaves unknown files untouched by default", async (t) => {
  const root = await temporaryFolder(t);
  for (const category of DEFAULT_CATEGORIES.filter((item) => item.id !== "others")) {
    await fs.writeFile(path.join(root, `${category.id}.${category.extensions[0]}`), category.id);
  }
  await fs.writeFile(path.join(root, "unmatched.unknown"), "unknown");

  const plan = await buildPlan(root);
  assert.equal(plan.summary.ready, DEFAULT_CATEGORIES.length - 1);
  assert.equal(plan.entries.find((entry) => entry.filename === "unmatched.unknown")?.reason, "No matching rule (left where it is)");
  for (const category of DEFAULT_CATEGORIES.filter((item) => item.id !== "others")) {
    assert.equal(plan.entries.find((entry) => entry.filename === `${category.id}.${category.extensions[0]}`)?.categoryName, category.name);
  }
});

test("creates folders inside the exact selected folder, including a non-default location", async (t) => {
  const parent = await temporaryFolder(t);
  const chosenFolder = path.join(parent, "A different downloads folder");
  const journal = path.join(parent, "journal", "last-run.json");
  await fs.mkdir(chosenFolder);
  await fs.writeFile(path.join(chosenFolder, "holiday.JPG"), "image");

  const plan = await buildPlan(chosenFolder);
  const result = await executePlan(plan, journal);
  assert.equal(result.entries.filter((entry) => entry.status === "moved").length, 1);
  await assert.doesNotReject(fs.access(path.join(chosenFolder, "Images", "holiday.JPG")));
  await assert.rejects(fs.access(path.join(parent, "Images", "holiday.JPG")));
});

test("can opt unmatched files into Others without changing the default policy", async (t) => {
  const root = await temporaryFolder(t);
  await fs.writeFile(path.join(root, "mystery.blob"), "unknown");

  const defaultPlan = await buildPlan(root);
  assert.equal(defaultPlan.entries[0]?.action, "skip");
  const optedInPlan = await buildPlan(root, { moveUnknownToOthers: true });
  assert.equal(optedInPlan.entries[0]?.categoryName, "Others");
  assert.equal(optedInPlan.entries[0]?.destination, path.join(root, "Others", "mystery.blob"));
});

test("keeps collisions untouched by default and creates an explicit safe alternate name", async (t) => {
  const root = await temporaryFolder(t);
  await fs.mkdir(path.join(root, "Images"));
  await fs.writeFile(path.join(root, "Images", "photo.jpg"), "old");
  await fs.writeFile(path.join(root, "photo.jpg"), "new");

  const defaultPlan = await buildPlan(root);
  assert.equal(defaultPlan.entries.find((entry) => entry.filename === "photo.jpg")?.action, "collision");

  const keepBothPlan = await buildPlan(root, { keepBothOnCollision: true });
  const renamed = keepBothPlan.entries.find((entry) => entry.filename === "photo.jpg");
  assert.equal(renamed?.destination, path.join(root, "Images", "photo (1).jpg"));
});

test("does not overwrite a destination that appears after the preview", async (t) => {
  const root = await temporaryFolder(t);
  const journal = path.join(root, "journal", "last-run.json");
  const source = path.join(root, "move.png");
  const destination = path.join(root, "Images", "move.png");
  await fs.writeFile(source, "original source");
  const plan = await buildPlan(root);

  const result = await executePlan(plan, journal, {
    beforeNoOverwriteMove: async () => {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, "external destination");
    },
  });
  assert.equal(result.entries.find((entry) => entry.filename === "move.png")?.status, "failed");
  assert.equal(await fs.readFile(source, "utf8"), "original source");
  assert.equal(await fs.readFile(destination, "utf8"), "external destination");
});

test("refuses a same-size, same-mtime source replacement before organize", async (t) => {
  const root = await temporaryFolder(t);
  const journal = path.join(root, "journal", "last-run.json");
  const source = path.join(root, "move.png");
  await writeWithFixedTimestamp(source, "first");
  const plan = await buildPlan(root);
  const plannedEntry = plan.entries.find((entry) => entry.filename === "move.png");
  assert.ok(plannedEntry);

  await writeWithFixedTimestamp(source, "other");
  const replacementStats = await fs.lstat(source);
  assert.equal(replacementStats.size, plannedEntry.size);
  assert.equal(replacementStats.mtimeMs, plannedEntry.mtimeMs);

  const result = await executePlan(plan, journal);
  const resultEntry = result.entries.find((entry) => entry.filename === "move.png");
  assert.equal(resultEntry?.status, "failed");
  assert.match(resultEntry?.failureReason ?? "", /Source changed since the preview/);
  assert.equal(await fs.readFile(source, "utf8"), "other");
  await assert.rejects(fs.access(path.join(root, "Images", "move.png")));
});

test("skips a Unicode Windows hidden file without relying on console encoding", { skip: process.platform !== "win32" }, async (t) => {
  const root = await temporaryFolder(t);
  const hiddenFile = path.join(root, "秘密.png");
  await fs.writeFile(hiddenFile, "hidden image");
  await execFileAsync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$target = [Environment]::GetEnvironmentVariable('FILE_TIDY_TEST_HIDDEN_PATH'); [IO.File]::SetAttributes($target, [IO.FileAttributes]::Hidden)",
    ],
    { windowsHide: true, env: { ...process.env, FILE_TIDY_TEST_HIDDEN_PATH: hiddenFile } },
  );

  const plan = await buildPlan(root);
  const entry = plan.entries.find((item) => item.filename === "秘密.png");
  assert.equal(entry?.action, "skip");
  assert.equal(entry?.reason, "Hidden or system file");
});

test("preserves the destination when the source disappears just after a safe link", async (t) => {
  const root = await temporaryFolder(t);
  const journal = path.join(root, "journal", "last-run.json");
  const source = path.join(root, "move.png");
  const destination = path.join(root, "Images", "move.png");
  await fs.writeFile(source, "original");
  const plan = await buildPlan(root);

  const result = await executePlan(plan, journal, {
    afterSafeLinkCreated: async () => fs.unlink(source),
  });
  assert.equal(result.entries.find((entry) => entry.filename === "move.png")?.status, "in_progress");
  await assert.rejects(fs.access(source));
  assert.equal(await fs.readFile(destination, "utf8"), "original");

  const undone = await undoLastRun(journal);
  assert.deepEqual(undone, { movedBack: 1, skipped: 0, notNeeded: 0, unresolved: 0, total: 1 });
  assert.equal(await fs.readFile(source, "utf8"), "original");
  await assert.rejects(fs.access(destination));
});

test("moves only planned files, then safely undoes the last run", async (t) => {
  const root = await temporaryFolder(t);
  const journal = path.join(root, "journal", "last-run.json");
  await fs.writeFile(path.join(root, "keep.txt"), "document");
  await fs.writeFile(path.join(root, "move.png"), "image");
  await fs.writeFile(path.join(root, "ignore.xyz"), "unknown");

  const plan = await buildPlan(root);
  const result = await executePlan(plan, journal);
  assert.equal(result.entries.filter((entry) => entry.status === "moved").length, 2);
  await assert.doesNotReject(fs.access(path.join(root, "Images", "move.png")));
  await assert.doesNotReject(fs.access(path.join(root, "Documents", "keep.txt")));
  await assert.doesNotReject(fs.access(path.join(root, "ignore.xyz")));

  const undone = await undoLastRun(journal);
  assert.deepEqual(undone, { movedBack: 2, skipped: 0, notNeeded: 0, unresolved: 0, total: 2 });
  await assert.doesNotReject(fs.access(path.join(root, "move.png")));
  await assert.doesNotReject(fs.access(path.join(root, "keep.txt")));
});

test("does not overwrite a source path that appears while undoing", async (t) => {
  const root = await temporaryFolder(t);
  const journal = path.join(root, "journal", "last-run.json");
  const source = path.join(root, "move.png");
  const destination = path.join(root, "Images", "move.png");
  await fs.writeFile(source, "organized source");
  await executePlan(await buildPlan(root), journal);

  const undone = await undoLastRun(journal, {
    beforeRestoreMove: async () => fs.writeFile(source, "new external file"),
  });
  assert.deepEqual(undone, { movedBack: 0, skipped: 1, notNeeded: 0, unresolved: 0, total: 1 });
  assert.equal(await fs.readFile(source, "utf8"), "new external file");
  assert.equal(await fs.readFile(destination, "utf8"), "organized source");
});

test("counts an interrupted hard-link move as unresolved without deleting either file", async (t) => {
  const root = await temporaryFolder(t);
  const journalFile = path.join(root, "journal", "last-run.json");
  const source = path.join(root, "move.png");
  const destination = path.join(root, "Images", "move.png");
  await fs.writeFile(source, "original");
  const plan = await buildPlan(root);
  const plannedEntry = plan.entries.find((entry) => entry.filename === "move.png");
  assert.ok(plannedEntry);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.link(source, destination);

  const journal: OrganizationJournal = {
    version: 2,
    id: plan.id,
    root,
    createdAt: plan.createdAt,
    startedAt: new Date().toISOString(),
    completedAt: null,
    state: "running",
    options: plan.options,
    entries: plan.entries.map((entry) => ({ ...entry, status: entry === plannedEntry ? "in_progress" : "skipped" })),
  };
  await fs.mkdir(path.dirname(journalFile), { recursive: true });
  await fs.writeFile(journalFile, JSON.stringify(journal), "utf8");

  const undone = await undoLastRun(journalFile);
  assert.deepEqual(undone, { movedBack: 0, skipped: 0, notNeeded: 0, unresolved: 1, total: 1 });
  assert.equal(await fs.readFile(source, "utf8"), "original");
  assert.equal(await fs.readFile(destination, "utf8"), "original");
  const persisted = await loadJournal(journalFile);
  assert.equal(persisted?.entries.find((entry) => entry.filename === "move.png")?.undoStatus, "in_progress");
});

test("does not undo a file changed after it was organized", async (t) => {
  const root = await temporaryFolder(t);
  const journal = path.join(root, "journal", "last-run.json");
  await fs.writeFile(path.join(root, "move.png"), "original");
  await executePlan(await buildPlan(root), journal);
  const destination = path.join(root, "Images", "move.png");
  await fs.writeFile(destination, "changed after organization");

  const undone = await undoLastRun(journal);
  assert.deepEqual(undone, { movedBack: 0, skipped: 1, notNeeded: 0, unresolved: 0, total: 1 });
  await assert.rejects(fs.access(path.join(root, "move.png")));
  await assert.doesNotReject(fs.access(destination));
});

test("refuses a same-size, same-mtime replacement at the organized destination before undo", async (t) => {
  const root = await temporaryFolder(t);
  const journal = path.join(root, "journal", "last-run.json");
  const source = path.join(root, "move.png");
  const destination = path.join(root, "Images", "move.png");
  await writeWithFixedTimestamp(source, "first");
  const plan = await buildPlan(root);
  const plannedEntry = plan.entries.find((entry) => entry.filename === "move.png");
  assert.ok(plannedEntry);
  await executePlan(plan, journal);

  await fs.unlink(destination);
  await writeWithFixedTimestamp(destination, "other");
  const replacementStats = await fs.lstat(destination);
  assert.equal(replacementStats.size, plannedEntry.size);
  assert.equal(replacementStats.mtimeMs, plannedEntry.mtimeMs);

  const undone = await undoLastRun(journal);
  assert.deepEqual(undone, { movedBack: 0, skipped: 1, notNeeded: 0, unresolved: 0, total: 1 });
  assert.equal(await fs.readFile(destination, "utf8"), "other");
  await assert.rejects(fs.access(source));
});

test("leaves a malformed recovery journal unreadable and unchanged", async (t) => {
  const root = await temporaryFolder(t);
  const journal = path.join(root, "journal", "last-run.json");
  const malformed = '{"version":';
  await fs.mkdir(path.dirname(journal), { recursive: true });
  await fs.writeFile(journal, malformed, "utf8");
  await fs.writeFile(path.join(root, "move.png"), "original");
  const plan = await buildPlan(root);

  await assert.rejects(loadJournal(journal), /recovery record could not be read/);
  await assert.rejects(executePlan(plan, journal), /recovery record could not be read/);
  assert.equal(await fs.readFile(journal, "utf8"), malformed);
});

test("does not replace an unresolved recovery journal with a new plan", async (t) => {
  const root = await temporaryFolder(t);
  const journalFile = path.join(root, "journal", "last-run.json");
  const source = path.join(root, "move.png");
  const destination = path.join(root, "Images", "move.png");
  await fs.writeFile(source, "original");
  const firstPlan = await buildPlan(root);
  const firstEntry = firstPlan.entries.find((entry) => entry.filename === "move.png");
  assert.ok(firstEntry);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.link(source, destination);

  const interruptedJournal: OrganizationJournal = {
    version: 2,
    id: firstPlan.id,
    root,
    createdAt: firstPlan.createdAt,
    startedAt: new Date().toISOString(),
    completedAt: null,
    state: "needs_recovery",
    options: firstPlan.options,
    entries: firstPlan.entries.map((entry) => ({ ...entry, status: entry === firstEntry ? "in_progress" : "skipped" })),
  };
  await fs.mkdir(path.dirname(journalFile), { recursive: true });
  await fs.writeFile(journalFile, JSON.stringify(interruptedJournal), "utf8");
  const before = await fs.readFile(journalFile, "utf8");

  const laterSource = path.join(root, "later.png");
  await fs.writeFile(laterSource, "later");
  const laterPlan = await buildPlan(root);
  await assert.rejects(executePlan(laterPlan, journalFile), /Resolve the previous recovery items/);
  assert.equal(await fs.readFile(journalFile, "utf8"), before);
  assert.equal(await fs.readFile(laterSource, "utf8"), "later");
  await assert.rejects(fs.access(path.join(root, "Images", "later.png")));
});

test("does not replace a running journal after moved entries were durably recorded", async (t) => {
  const root = await temporaryFolder(t);
  const journalFile = path.join(root, "journal", "last-run.json");
  await fs.writeFile(path.join(root, "first.png"), "first");
  await executePlan(await buildPlan(root), journalFile);

  // Simulate a crash after the moved-entry event but before the final journal
  // state was written. The moved file must remain recoverable on next launch.
  const interrupted = await loadJournal(journalFile);
  assert.ok(interrupted);
  interrupted.state = "running";
  interrupted.completedAt = null;
  await fs.writeFile(journalFile, JSON.stringify(interrupted), "utf8");

  await fs.writeFile(path.join(root, "later.png"), "later");
  const laterPlan = await buildPlan(root);
  await assert.rejects(executePlan(laterPlan, journalFile), /Resolve the previous recovery items/);
  await assert.doesNotReject(fs.access(path.join(root, "Images", "first.png")));
  await assert.doesNotReject(fs.access(path.join(root, "later.png")));
});

test("replays a valid journal when only the final append was torn", async (t) => {
  const root = await temporaryFolder(t);
  const journalFile = path.join(root, "journal", "last-run.json");
  await fs.writeFile(path.join(root, "move.png"), "original");
  await executePlan(await buildPlan(root), journalFile);

  // A mutation is always preceded by a synced intent event. A crash can only
  // leave this final, unterminated result append incomplete.
  await fs.writeFile(`${journalFile}.events.jsonl`, '{"version":', "utf8");
  const recovered = await loadJournal(journalFile);
  assert.equal(recovered?.entries.find((entry) => entry.filename === "move.png")?.status, "moved");

  const undone = await undoLastRun(journalFile);
  assert.deepEqual(undone, { movedBack: 1, skipped: 0, notNeeded: 0, unresolved: 0, total: 1 });
  await assert.doesNotReject(fs.access(path.join(root, "move.png")));
});

test("retries a collision-blocked undo after the collision is cleared", async (t) => {
  const root = await temporaryFolder(t);
  const journal = path.join(root, "journal", "last-run.json");
  const source = path.join(root, "move.png");
  const destination = path.join(root, "Images", "move.png");
  await fs.writeFile(source, "organized source");
  await executePlan(await buildPlan(root), journal);
  await fs.writeFile(source, "external collision");

  const firstUndo = await undoLastRun(journal);
  assert.deepEqual(firstUndo, { movedBack: 0, skipped: 1, notNeeded: 0, unresolved: 0, total: 1 });
  assert.equal(await fs.readFile(destination, "utf8"), "organized source");
  assert.equal((await loadJournal(journal))?.entries.find((entry) => entry.filename === "move.png")?.undoStatus, "retryable");

  await fs.unlink(source);
  const retry = await undoLastRun(journal);
  assert.deepEqual(retry, { movedBack: 1, skipped: 0, notNeeded: 0, unresolved: 0, total: 1 });
  assert.equal(await fs.readFile(source, "utf8"), "organized source");
  await assert.rejects(fs.access(destination));
});

test("normalizes custom rule aliases consistently while matching filenames", () => {
  const categories: readonly Category[] = [
    { id: "documents", name: "Documents", folder: "Documents", enabled: true, extensions: [" .PDF "] },
  ];

  assert.equal(categoryForFilename("report.PDF", categories)?.id, "documents");
  assert.deepEqual(findExtensionConflicts(categories), []);
});

test("does not treat aliases within one category as extension conflicts", () => {
  const categories: readonly Category[] = [
    { id: "documents", name: "Documents", folder: "Documents", enabled: true, extensions: ["pdf", ".PDF", " .pdf "] },
    { id: "images", name: "Images", folder: "Images", enabled: true, extensions: ["png"] },
  ];

  assert.deepEqual(findExtensionConflicts(categories), []);
});

test("reports normalized extensions owned by distinct categories as conflicts", () => {
  const categories: readonly Category[] = [
    { id: "documents", name: "Documents", folder: "Documents", enabled: true, extensions: ["pdf", ".PDF"] },
    { id: "archive", name: "Archive", folder: "Archive", enabled: true, extensions: [" .pdf "] },
  ];

  assert.deepEqual(findExtensionConflicts(categories), [{ extension: "pdf", names: ["Documents", "Archive"] }]);
});
