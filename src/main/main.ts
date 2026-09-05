import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent, OpenDialogOptions } from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import { DEFAULT_CATEGORIES } from "../core/rules.js";
import { validateCategories } from "../core/category-settings.js";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildPlan,
  canUndo,
  executePlan,
  loadJournal,
  OrganizerError,
  undoLastRun,
} from "../core/file-organizer.js";
import type {
  LastRunState,
  OperationProgress,
  OrganizationOptions,
  OrganizationPlan,
} from "../core/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rendererEntry = path.join(__dirname, "..", "renderer", "index.html");
const rendererUrl = pathToFileURL(rendererEntry).toString();
const plans = new Map<string, OrganizationPlan>();
let mainWindow: BrowserWindow | undefined;
let selectedFolder = "";
let activeOperation: { planId: string; cancelled: boolean } | null = null;

function journalFile(): string {
  return path.join(app.getPath("userData"), "last-run.json");
}

function errorMessage(error: unknown): string {
  if (error instanceof OrganizerError || error instanceof Error) return error.message;
  return "Something went wrong. No files were deleted.";
}

function reportProgress(payload: OperationProgress): void {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send("organizer:progress", payload);
  }
}

function isTrustedRenderer(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  return mainWindow !== undefined
    && !mainWindow.isDestroyed()
    && event.sender === mainWindow.webContents
    && event.senderFrame === event.sender.mainFrame
    && event.senderFrame.url === rendererUrl;
}

function invalidatePlans(): void {
  plans.clear();
}

async function readCategories() {
  try { return validateCategories(JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'categories.json'), 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_CATEGORIES;
    throw error;
  }
}

ipcMain.handle('organizer:categories', async (event) => {
  if (!isTrustedRenderer(event)) throw new Error('Untrusted frame.');
  return readCategories();
});
ipcMain.handle('organizer:save-categories', async (event, value: unknown) => {
  if (!isTrustedRenderer(event)) throw new Error('Untrusted frame.');
  if (activeOperation) throw new Error('Wait for the current operation to finish.');
  const categories = validateCategories(value);
  const target = path.join(app.getPath('userData'), 'categories.json');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target + '.tmp', JSON.stringify(categories, null, 2));
  await fs.rename(target + '.tmp', target);
  invalidatePlans();
  return categories;
});

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 850,
    minHeight: 620,
    show: false,
    backgroundColor: "#f7f9fc",
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#f7f9fc",
      symbolColor: "#27364a",
      height: 36,
    },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = window;

  void window.loadFile(rendererEntry).catch((error: unknown) => {
    console.error("Unable to load File Tidy's local interface:", error);
  });
  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== rendererUrl) event.preventDefault();
  });
  window.webContents.on("will-redirect", (event, url) => {
    if (url !== rendererUrl) event.preventDefault();
  });
  window.on("close", (event) => {
    if (!activeOperation) return;
    event.preventDefault();
    if (!window.webContents.isDestroyed()) window.webContents.send("organizer:close-blocked");
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = undefined;
  });
}

ipcMain.handle("organizer:choose-folder", async (event) => {
  if (!isTrustedRenderer(event)) return { canceled: true as const };
  const options: OpenDialogOptions = {
    title: "Choose a folder to organize",
    defaultPath: selectedFolder || undefined,
    properties: ["openDirectory"],
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths[0]) return { canceled: true as const };
  selectedFolder = result.filePaths[0];
  invalidatePlans();
  return { canceled: false as const, folder: selectedFolder };
});

ipcMain.handle("organizer:scan", async (event, request: { folder?: unknown; options?: OrganizationOptions } | undefined) => {
  if (!isTrustedRenderer(event)) return { ok: false as const, error: "Request rejected from an untrusted frame." };
  // A new review makes every older preview stale, even when this scan fails.
  invalidatePlans();
  try {
    const plan = await buildPlan(typeof request?.folder === "string" ? request.folder : "", request?.options, await readCategories());
    selectedFolder = plan.root;
    plans.clear();
    plans.set(plan.id, plan);
    return { ok: true as const, plan };
  } catch (error: unknown) {
    return { ok: false as const, error: errorMessage(error) };
  }
});

ipcMain.handle("organizer:discard-plans", (event) => {
  if (!isTrustedRenderer(event)) return { ok: false as const, error: "Request rejected from an untrusted frame." };
  invalidatePlans();
  return { ok: true as const };
});

ipcMain.handle("organizer:organize", async (event, planId: unknown) => {
  if (!isTrustedRenderer(event)) return { ok: false as const, error: "Request rejected from an untrusted frame." };
  if (typeof planId !== "string") return { ok: false as const, error: "The organization plan is invalid." };
  const plan = plans.get(planId);
  if (!plan) return { ok: false as const, error: "This preview has expired. Review the folder again before moving files." };
  if (activeOperation) return { ok: false as const, error: "An operation is already in progress." };

  activeOperation = { planId, cancelled: false };
  try {
    const journal = await executePlan(plan, journalFile(), {
      isCancelled: () => activeOperation?.cancelled === true,
      onProgress: reportProgress,
    });
    return { ok: true as const, journal };
  } catch (error: unknown) {
    return { ok: false as const, error: errorMessage(error) };
  } finally {
    plans.delete(planId);
    activeOperation = null;
  }
});

ipcMain.on("organizer:cancel", (event, planId: unknown) => {
  if (!isTrustedRenderer(event)) return;
  if (typeof planId !== "string") return;
  if (activeOperation?.planId === planId) activeOperation.cancelled = true;
});

ipcMain.handle("organizer:undo", async (event) => {
  if (!isTrustedRenderer(event)) return { ok: false as const, error: "Request rejected from an untrusted frame." };
  if (activeOperation) return { ok: false as const, error: "Wait for the current operation to finish first." };
  // Undo can change any prior folder. No cached preview remains trustworthy.
  invalidatePlans();
  activeOperation = { planId: "undo", cancelled: false };
  try {
    const summary = await undoLastRun(journalFile(), { onProgress: reportProgress });
    return { ok: true as const, summary };
  } catch (error: unknown) {
    return { ok: false as const, error: errorMessage(error) };
  } finally {
    activeOperation = null;
  }
});

ipcMain.handle("organizer:last-run", async (event): Promise<LastRunState> => {
  if (!isTrustedRenderer(event)) return { exists: false, canUndo: false };
  try {
    const journal = await loadJournal(journalFile());
    if (!journal) return { exists: false, canUndo: false };
    const moved = journal.entries.filter((entry) => (
      (entry.status === "moved" || entry.status === "in_progress")
      && (!entry.undoStatus || entry.undoStatus === "in_progress" || entry.undoStatus === "retryable")
    )).length;
    const unresolved = journal.entries.filter((entry) => (
      entry.status === "in_progress"
      || entry.undoStatus === "in_progress"
      || entry.undoStatus === "retryable"
    )).length;
    return {
      exists: true,
      canUndo: canUndo(journal),
      state: journal.state,
      root: journal.root,
      completedAt: journal.completedAt,
      moved,
      unresolved,
      results: journal.entries.map((entry) => ({
        filename: entry.filename,
        source: entry.source,
        destination: entry.destination,
        status: entry.status,
        failureReason: entry.failureReason,
        undoStatus: entry.undoStatus,
        undoReason: entry.undoReason,
      })),
    };
  } catch (error: unknown) {
    return { exists: true, canUndo: false, error: errorMessage(error) };
  }
});

ipcMain.handle("organizer:open-folder", async (event) => {
  if (!isTrustedRenderer(event)) return { ok: false as const, error: "Request rejected from an untrusted frame." };
  if (!selectedFolder) return { ok: false as const, error: "Choose a folder first." };
  try {
    const error = await shell.openPath(selectedFolder);
    return error ? { ok: false as const, error } : { ok: true as const };
  } catch (error: unknown) {
    return { ok: false as const, error: errorMessage(error) };
  }
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    app.setAppUserModelId("com.filetidy.organizer");
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => app.quit());
}
