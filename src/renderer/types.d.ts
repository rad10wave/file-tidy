import type {
  Category,
  LastRunState,
  OperationProgress,
  OrganizationJournal,
  OrganizationPlan,
  UndoSummary,
} from "../core/types";

type ChooseFolderResult = { canceled: true } | { canceled: false; folder: string };
type ScanResult = { ok: true; plan: OrganizationPlan } | { ok: false; error: string };
type DiscardPlansResult = { ok: true } | { ok: false; error: string };
type OrganizeResult = { ok: true; journal: OrganizationJournal } | { ok: false; error: string };
type UndoResult = { ok: true; summary: UndoSummary } | { ok: false; error: string };
type OpenFolderResult = { ok: true } | { ok: false; error: string };

interface FileTidyApi {
  getCategories(): Promise<Category[]>;
  saveCategories(categories: Category[]): Promise<Category[]>;
  chooseFolder(): Promise<ChooseFolderResult>;
  scan(folder: string, options: { moveUnknownToOthers: boolean; keepBothOnCollision: boolean }): Promise<ScanResult>;
  discardPlans(): Promise<DiscardPlansResult>;
  organize(planId: string): Promise<OrganizeResult>;
  cancel(planId: string): void;
  undo(): Promise<UndoResult>;
  getLastRun(): Promise<LastRunState>;
  openFolder(): Promise<OpenFolderResult>;
  onProgress(handler: (payload: OperationProgress) => void): () => void;
  onCloseBlocked(handler: () => void): () => void;
}

declare global {
  interface Window {
    fileTidy: FileTidyApi;
  }
}

export {};
