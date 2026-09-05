export type OrganizationAction = "move" | "collision" | "skip";
export type JournalEntryStatus = "pending" | "in_progress" | "moved" | "failed" | "skipped";
/** A retryable Undo entry stays visible until the user has resolved it. */
export type UndoStatus = "in_progress" | "moved_back" | "not_needed" | "retryable";

/**
 * A filesystem identity captured from `lstat`. It is deliberately stored as
 * strings because Node can expose the values as bigint on some platforms.
 */
export interface FileIdentity {
  device: string;
  inode: string;
}

export interface Category {
  id: string;
  name: string;
  folder: string;
  enabled: boolean;
  extensions: readonly string[];
}

export interface OrganizationOptions {
  moveUnknownToOthers?: boolean;
  keepBothOnCollision?: boolean;
}

export interface NormalizedOrganizationOptions {
  moveUnknownToOthers: boolean;
  keepBothOnCollision: boolean;
}

export interface PlanEntry {
  source: string;
  filename: string;
  categoryId: string | null;
  categoryName: string | null;
  destination: string | null;
  action: OrganizationAction;
  reason: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  fileIdentity: FileIdentity | null;
}

export interface PlanSummary {
  total: number;
  ready: number;
  collisions: number;
  skipped: number;
  byCategory: Record<string, number>;
}

export interface OrganizationPlan {
  id: string;
  root: string;
  createdAt: string;
  options: NormalizedOrganizationOptions;
  entries: PlanEntry[];
  summary: PlanSummary;
}

export interface JournalEntry extends PlanEntry {
  status: JournalEntryStatus;
  startedAt?: string;
  movedAt?: string;
  failureReason?: string;
  undoStatus?: UndoStatus;
  undoReason?: string;
  undoStartedAt?: string;
  undoneAt?: string;
}

export interface OrganizationJournal {
  /** Version 1 records can be displayed, but cannot be safely restored. */
  version: 1 | 2;
  id: string;
  root: string;
  createdAt: string;
  startedAt: string;
  completedAt: string | null;
  state: "running" | "cancelled" | "completed" | "needs_recovery";
  options: NormalizedOrganizationOptions;
  entries: JournalEntry[];
  undoCompletedAt?: string;
}

export interface OperationProgress {
  phase: "organize" | "undo";
  current: number;
  total: number;
  filename: string;
}

export interface UndoSummary {
  movedBack: number;
  skipped: number;
  notNeeded: number;
  /** A move may have started but could not be proved safe to finish or undo. */
  unresolved: number;
  total: number;
}

export interface LastRunState {
  exists: boolean;
  canUndo: boolean;
  error?: string;
  state?: OrganizationJournal["state"];
  root?: string;
  completedAt?: string | null;
  moved?: number;
  unresolved?: number;
  results?: Array<Pick<JournalEntry, "filename" | "source" | "destination" | "status" | "failureReason" | "undoStatus" | "undoReason">>;
}
