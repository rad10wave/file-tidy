import {
  Alert,
  AppBar,
  Box,
  Button,
  Checkbox,
  Chip,
  Container,
  CssBaseline,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  FormControl,
  FormControlLabel,
  InputLabel,
  LinearProgress,
  MenuItem,
  Paper,
  Select,
  Snackbar,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  TableSortLabel,
  TextField,
  ThemeProvider,
  Toolbar,
  Tooltip,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import CheckCircleOutlineRoundedIcon from "@mui/icons-material/CheckCircleOutlineRounded";
import TuneRoundedIcon from "@mui/icons-material/TuneRounded";
import appIcon from '../../../icons/icon-128.png';
import { CategoriesDialog } from './CategoriesDialog';
import FolderOpenOutlinedIcon from "@mui/icons-material/FolderOpenOutlined";
import FolderRoundedIcon from "@mui/icons-material/FolderRounded";
import HistoryRoundedIcon from "@mui/icons-material/HistoryRounded";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import SafetyCheckOutlinedIcon from "@mui/icons-material/SafetyCheckOutlined";
import StopCircleOutlinedIcon from "@mui/icons-material/StopCircleOutlined";
import { memo, useCallback, useEffect, useMemo, useState } from "react";

import type { LastRunState, OperationProgress, OrganizationPlan } from "../core/types";
import { theme } from "./theme";

type WorkingPhase = "scan" | "organize" | "undo" | null;
type ConfirmationAction = "organize" | "undo" | null;
type Notice = { message: string; severity: "success" | "error" | "info" } | null;
type PreviewStatusFilter = "all" | "ready" | "attention" | "unchanged";
type PreviewSortKey = "filename" | "category" | "destination" | "status";
type SortDirection = "asc" | "desc";

interface ActionCopy {
  title: string;
  detail: string;
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function relativePath(plan: OrganizationPlan | null, value: string | null): string {
  if (!value) return "—";
  if (plan && value.toLowerCase().startsWith(plan.root.toLowerCase())) {
    return value.slice(plan.root.length).replace(/^[/\\]/, "") || ".";
  }
  return value;
}

function statusChip(entry: OrganizationPlan["entries"][number]) {
  if (entry.action === "move") return { color: "success" as const, label: entry.reason };
  if (entry.action === "collision") return { color: "warning" as const, label: entry.reason };
  return { color: "default" as const, label: entry.reason };
}

function previewStatus(entry: OrganizationPlan["entries"][number]): Exclude<PreviewStatusFilter, "all"> {
  if (entry.action === "move") return "ready";
  if (entry.action === "collision") return "attention";
  return "unchanged";
}

function recoveryReason(entry: NonNullable<LastRunState["results"]>[number]): string {
  return entry.undoReason ?? entry.failureReason ?? (
    entry.undoStatus === "retryable"
      ? "This file can be retried after the conflict is resolved."
      : entry.status === "in_progress" || entry.undoStatus === "in_progress"
        ? "This file needs recovery review before further changes."
        : "No recovery issue was recorded."
  );
}

export function App() {
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [folder, setFolder] = useState("");
  const [moveUnknownToOthers, setMoveUnknownToOthers] = useState(false);
  const [keepBothOnCollision, setKeepBothOnCollision] = useState(false);
  const [plan, setPlan] = useState<OrganizationPlan | null>(null);
  const [activePlanId, setActivePlanId] = useState<string | null>(null);
  const [working, setWorking] = useState<WorkingPhase>(null);
  const [progress, setProgress] = useState<OperationProgress | null>(null);
  const [lastRun, setLastRun] = useState<LastRunState>({ exists: false, canUndo: false });
  const [confirmation, setConfirmation] = useState<ConfirmationAction>(null);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [actionCopy, setActionCopy] = useState<ActionCopy>({
    title: "Nothing has moved.",
    detail: "Review a folder before organizing it.",
  });

  const refreshLastRun = useCallback(async () => {
    try {
      const nextLastRun = await window.fileTidy.getLastRun();
      setLastRun(nextLastRun);
      if (nextLastRun.error) setNotice({ message: nextLastRun.error, severity: "error" });
    } catch {
      setNotice({ message: "File Tidy could not read the local recovery record.", severity: "error" });
    }
  }, []);

  useEffect(() => {
    void refreshLastRun();
    const removeProgressListener = window.fileTidy.onProgress((payload) => setProgress(payload));
    const removeCloseListener = window.fileTidy.onCloseBlocked(() => {
      setNotice({ message: "Finish or stop the current operation before closing File Tidy.", severity: "info" });
    });
    return () => {
      removeProgressListener();
      removeCloseListener();
    };
  }, [refreshLastRun]);

  const busy = working !== null;
  const planMessage = useMemo(() => {
    if (!plan) return "Select a folder to see exactly what would change.";
    const messages: string[] = [];
    if (plan.summary.ready) messages.push(`${countLabel(plan.summary.ready, "file")} will move into folders inside the selected location.`);
    if (plan.summary.collisions) messages.push(`${countLabel(plan.summary.collisions, "collision")} will stay put unless you enable Keep both files.`);
    if (!plan.summary.ready && !plan.summary.collisions) messages.push("No loose files match the active rules in this folder.");
    return messages.join(" ");
  }, [plan]);
  const recoveryEntries = useMemo(() => (lastRun.results ?? []).filter((entry) => (
    entry.status === "failed"
    || entry.status === "in_progress"
    || entry.undoStatus === "in_progress"
    || entry.undoStatus === "retryable"
    || Boolean(entry.failureReason)
    || Boolean(entry.undoReason)
  )), [lastRun.results]);

  const invalidatePlan = useCallback(async (message = "Options changed. Review the folder again before moving files.") => {
    setPlan(null);
    setActionCopy({ title: "Nothing has moved.", detail: message });
    try {
      const result = await window.fileTidy.discardPlans();
      if (!result.ok) setNotice({ message: result.error, severity: "error" });
    } catch {
      setNotice({ message: "The old preview could not be invalidated. Review the folder again before moving files.", severity: "error" });
    }
  }, []);

  const chooseFolder = async () => {
    try {
      const result = await window.fileTidy.chooseFolder();
      if (result.canceled) return;
      setFolder(result.folder);
      setPlan(null);
      setActionCopy({
        title: "Folder selected.",
        detail: "Review the proposed moves before organizing anything.",
      });
    } catch {
      setNotice({ message: "The folder chooser could not be opened.", severity: "error" });
    }
  };

  const reviewPlan = async () => {
    if (!folder || busy) return;
    // A failed refresh must not leave an older preview available for execution.
    setPlan(null);
    setActionCopy({ title: "Nothing has moved.", detail: "Reviewing the folder. A new preview will replace this one." });
    setWorking("scan");
    setProgress(null);
    try {
      const result = await window.fileTidy.scan(folder, { moveUnknownToOthers, keepBothOnCollision });
      if (!result.ok) {
        setNotice({ message: result.error, severity: "error" });
        return;
      }
      setPlan(result.plan);
      setActionCopy({
        title: result.plan.summary.ready
          ? `Ready to organize ${countLabel(result.plan.summary.ready, "file")}.`
          : "No files are ready to move.",
        detail: "Nothing is deleted or overwritten. Successful moves can be undone safely.",
      });
    } catch {
      setNotice({ message: "The folder could not be reviewed.", severity: "error" });
    } finally {
      setWorking(null);
    }
  };

  const runOrganize = async () => {
    if (!plan) return;
    setConfirmation(null);
    const reviewedPlan = plan;
    // Once a mutation is requested, the preview is no longer safe to reuse—even if IPC fails.
    setPlan(null);
    setActivePlanId(reviewedPlan.id);
    setWorking("organize");
    setProgress(null);
    setCancelRequested(false);
    try {
      const result = await window.fileTidy.organize(reviewedPlan.id);
      if (!result.ok) {
        setActionCopy({
          title: "The operation did not finish cleanly.",
          detail: "Check the folder; any recorded successful moves can be undone safely.",
        });
        setNotice({ message: result.error, severity: "error" });
        return;
      }
      const moved = result.journal.entries.filter((entry) => entry.status === "moved").length;
      const failed = result.journal.entries.filter((entry) => entry.status === "failed").length;
      const partial = result.journal.entries.filter((entry) => entry.status === "in_progress").length;
      setActionCopy({
        title: result.journal.state === "cancelled"
          ? `${countLabel(moved, "file")} organized before stopping.`
          : `${countLabel(moved, "file")} organized.`,
        detail: partial
          ? `${countLabel(partial, "file")} needs recovery review before any further changes.`
          : failed
            ? `${countLabel(failed, "file")} stayed unchanged because it could not be moved.`
            : "Your successful moves can be undone safely from this window.",
      });
      setNotice({
        message: partial
          ? "A partial move was recorded for recovery. No file was overwritten."
          : failed
            ? `Organized ${countLabel(moved, "file")}; ${countLabel(failed, "file")} stayed unchanged.`
            : `Organized ${countLabel(moved, "file")}. You can undo this run if needed.`,
        severity: partial || failed ? "info" : "success",
      });
    } catch {
      setNotice({ message: "The organization request could not finish.", severity: "error" });
    } finally {
      setWorking(null);
      setActivePlanId(null);
      setCancelRequested(false);
      await refreshLastRun();
    }
  };

  const stopOrganizing = () => {
    if (working !== "organize" || !activePlanId) return;
    window.fileTidy.cancel(activePlanId);
    setCancelRequested(true);
  };

  const runUndo = async () => {
    setConfirmation(null);
    // Undo affects the last-run folder, which can be different from the selected folder.
    setWorking("undo");
    await invalidatePlan("Undo changed the filesystem. Review the folder again before moving files.");
    setProgress(null);
    try {
      const result = await window.fileTidy.undo();
      if (!result.ok) {
        setNotice({ message: result.error, severity: "error" });
        return;
      }
      const { movedBack, skipped, notNeeded, unresolved } = result.summary;
      setActionCopy({
        title: `${countLabel(movedBack, "file")} restored.`,
        detail: unresolved
          ? `${countLabel(unresolved, "file")} still needs recovery review; you can retry Undo after resolving the issue.`
          : skipped
          ? `${countLabel(skipped, "file")} could not be safely restored.`
          : notNeeded
            ? `${countLabel(notNeeded, "interrupted move")} needed no restoration.`
            : "The last run has been undone safely.",
      });
      setNotice({
        message: unresolved
          ? `${countLabel(movedBack, "file")} restored; ${countLabel(unresolved, "file")} still needs recovery review.`
          : skipped
          ? `${countLabel(movedBack, "file")} restored; ${countLabel(skipped, "file")} skipped safely.`
          : `${countLabel(movedBack, "file")} restored to their original locations.`,
        severity: skipped || unresolved ? "info" : "success",
      });
    } catch {
      setNotice({ message: "The last run could not be undone.", severity: "error" });
    } finally {
      setWorking(null);
      await refreshLastRun();
    }
  };

  const openFolder = async () => {
    try {
      const result = await window.fileTidy.openFolder();
      if (!result.ok) setNotice({ message: result.error, severity: "error" });
    } catch {
      setNotice({ message: "The selected folder could not be opened.", severity: "error" });
    }
  };

  const setOption = (option: "unknown" | "collision", checked: boolean) => {
    if (option === "unknown") setMoveUnknownToOthers(checked);
    else setKeepBothOnCollision(checked);
    void invalidatePlan();
  };

  const workingLabel = working === "scan"
    ? "Reviewing files"
    : working === "undo"
      ? "Undoing the last run"
      : "Organizing files";
  const progressValue = progress?.total ? Math.round((progress.current / progress.total) * 100) : 0;

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box sx={{ height: "100dvh", display: "flex", flexDirection: "column", overflow: "hidden", bgcolor: "background.default" }}>
        <Box sx={{ height: 36, flexShrink: 0, bgcolor: '#f7f9fc', WebkitAppRegion: 'drag' }} />
        <AppBar
          position="static"
          elevation={0}
          color="transparent"
          sx={{
            bgcolor: "background.paper",
            borderBottom: 1,
            borderColor: "divider",
            flexShrink: 0,
          }}
        >
          <Toolbar disableGutters sx={{ minHeight: "68px !important", scrollbarGutter: 'stable', overflowY: 'auto' }}>
            <Container maxWidth="lg" sx={{ px: { xs: 2, sm: 3 } }}>
              <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
                <Box component="img" src={appIcon} alt="" sx={{ width: 40, height: 40, objectFit: 'contain', flexShrink: 0 }} />
                <Box>
                  <Typography variant="h4" sx={{ fontSize: 22 }}>File Tidy</Typography>
                  <Typography variant="body2" color="text.secondary">A place for every file.</Typography>
                </Box>
              </Stack>
            </Container>
          </Toolbar>
        </AppBar>

        <Box component="main" sx={{ flex: 1, minHeight: 0, overflowY: 'auto', scrollbarGutter: 'stable' }}>
        <Container maxWidth="lg" sx={{ py: 2.5, px: { xs: 2, sm: 3 } }}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 2, justifyContent: 'space-between', alignItems: { sm: 'center' } }}>
            <Box><Typography variant="h6">Your folder, organized.</Typography><Typography variant="body2" color="text.secondary">Choose a location. Fine-tune your rules. Review every move.</Typography></Box>
            <Button variant="outlined" startIcon={<TuneRoundedIcon />} disabled={busy} onClick={() => setCategoriesOpen(true)}>Folders & file types</Button>
          </Stack>
          <Paper component="section" variant="outlined" sx={{ p: 2.5, boxShadow: "0 2px 8px rgb(19 37 55 / 4%)" }}>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ justifyContent: "space-between", alignItems: { xs: "flex-start", sm: "center" } }}>
              <Box>
                <Typography variant="overline" color="primary.main" sx={{ fontWeight: 750 }}>Step 1</Typography>
                <Typography variant="h6">Choose a folder</Typography>
              </Box>
              <Button startIcon={<FolderOpenOutlinedIcon />} onClick={openFolder} disabled={!folder || busy}>Open folder</Button>
            </Stack>

            <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ mt: 1.5, alignItems: { sm: 'center' } }}>
              <Tooltip title={folder || "No folder selected"} placement="top-start">
                <TextField
                  fullWidth
                  size="small"
                  value={folder || "No folder selected"}
                  slotProps={{
                    input: { readOnly: true },
                    htmlInput: { "aria-label": "Selected folder" },
                  }}
                  sx={{ "& .MuiInputBase-input": { fontFamily: '"Cascadia Mono", Consolas, monospace', fontSize: 13, overflow: "hidden", textOverflow: "ellipsis" } }}
                />
              </Tooltip>
              <Button variant="outlined" onClick={chooseFolder} disabled={busy} startIcon={<FolderRoundedIcon />} sx={{ whiteSpace: "nowrap", px: 2 }}>Choose folder</Button>
            </Stack>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1.25 }}>
              Only loose files directly inside this folder are scanned. Existing folders and their contents are never changed.
            </Typography>

            <Stack direction={{ xs: "column", md: "row" }} spacing={1.25} sx={{ mt: 1.5 }}>
              <Box sx={{ flex: 1 }}>
                <FormControlLabel
                  control={<Checkbox checked={moveUnknownToOthers} onChange={(event) => setOption("unknown", event.target.checked)} disabled={busy} />}
                  label={<Box><Typography variant="body2" sx={{ fontWeight: 700 }}>Move unmatched files to Others</Typography><Typography variant="caption" color="text.secondary">By default, files without a matching rule stay where they are.</Typography></Box>}
                  sx={{ m: 0, py: 0.75, alignItems: "flex-start" }}
                />
              </Box>
              <Box sx={{ flex: 1 }}>
                <FormControlLabel
                  control={<Checkbox checked={keepBothOnCollision} onChange={(event) => setOption("collision", event.target.checked)} disabled={busy} />}
                  label={<Box><Typography variant="body2" sx={{ fontWeight: 700 }}>Keep both files when names collide</Typography><Typography variant="caption" color="text.secondary">The incoming file becomes file (1).ext; nothing is overwritten.</Typography></Box>}
                  sx={{ m: 0, py: 0.75, alignItems: "flex-start" }}
                />
              </Box>
            </Stack>

            <Stack direction={{ xs: "column", sm: "row" }} spacing={1.75} sx={{ mt: 1.5, alignItems: { xs: "stretch", sm: "center" } }}>
              <Button variant="contained" onClick={reviewPlan} disabled={!folder || busy} endIcon={<PlayArrowRoundedIcon />}>Review organization plan</Button>
              <Typography variant="body2" color="text.secondary">Nothing moves until you approve the preview.</Typography>
            </Stack>
          </Paper>

          <Paper component="section" variant="outlined" sx={{ mt: 2, overflow: "hidden", boxShadow: "0 2px 8px rgb(19 37 55 / 4%)" }}>
            <Box sx={{ p: 2.5, pb: 1.5 }}>
              <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ justifyContent: "space-between", alignItems: { xs: "flex-start", sm: "center" } }}>
                <Box>
                  <Typography variant="overline" color="primary.main" sx={{ fontWeight: 750 }}>Step 2</Typography>
                  <Typography variant="h6">Review the plan</Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>{plan ? `Previewing direct files in ${plan.root}` : planMessage}</Typography>
                </Box>
                <Stack spacing={0.5} sx={{ alignItems: { xs: "flex-start", sm: "flex-end" }, minWidth: 0 }}>
                  {lastRun.root && <Typography variant="caption" color="text.secondary" title={lastRun.root} sx={{ maxWidth: { sm: 330 }, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>Last run: {lastRun.root}</Typography>}
                  <Tooltip title={lastRun.root ? `Restores files in ${lastRun.root}` : "No recoverable run is available"}>
                    <span>
                      <Button variant="outlined" startIcon={<HistoryRoundedIcon />} disabled={!lastRun.canUndo || busy} onClick={() => setConfirmation("undo")}>
                        {lastRun.unresolved ? "Retry Undo" : "Undo last run"}{lastRun.canUndo && lastRun.moved ? ` (${countLabel(lastRun.moved, "move")})` : ""}
                      </Button>
                    </span>
                  </Tooltip>
                </Stack>
              </Stack>
            </Box>

            {!plan ? (
              <Box sx={{ px: 2.5, pb: 2.5 }}>
                <Stack direction="row" spacing={1.5} sx={{ alignItems: "center", bgcolor: 'background.default', p: 2, borderRadius: 1.5 }}>
                  <SafetyCheckOutlinedIcon color="primary" />
                  <Typography variant="body2" color="text.secondary">Your preview will appear here. Review the destinations before moving any files.</Typography>
                </Stack>
              </Box>
            ) : (
              <Box sx={{ px: { xs: 2.25, sm: 3 }, pb: 3 }}>
                <Stack direction={{ xs: "column", md: "row" }} spacing={1.25}>
                  <SummaryCard label="Ready to move" value={plan.summary.ready} helper={countLabel(plan.summary.ready, "file")} color="success.main" tint="success" />
                  <SummaryCard label="Left unchanged" value={plan.summary.skipped} helper="unknown, folders, or protected files" color="text.primary" tint="default" />
                  <SummaryCard label="Needs attention" value={plan.summary.collisions} helper="name collisions" color="warning.main" tint="warning" />
                </Stack>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>{planMessage}</Typography>
                <PlanPreviewTable plan={plan} />
              </Box>
            )}

            {!plan && recoveryEntries.length > 0 && (
              <Box sx={{ px: { xs: 2.25, sm: 3 }, pb: 3 }}>
                <RecoveryResultsTable entries={recoveryEntries} root={lastRun.root} onRetry={() => setConfirmation("undo")} retryAvailable={lastRun.canUndo && !busy} />
              </Box>
            )}

            {plan && <Divider />}
            {plan && (
            <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ p: { xs: 2.25, sm: 2.5 }, bgcolor: alpha(theme.palette.primary.main, 0.018), justifyContent: "space-between", alignItems: { xs: "stretch", sm: "center" } }}>
              <Box><Typography variant="body2" sx={{ fontWeight: 700 }}>{actionCopy.title}</Typography><Typography variant="caption" color="text.secondary">{actionCopy.detail}</Typography></Box>
              <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
                {busy && working === "organize" && <Button variant="outlined" color="inherit" startIcon={<StopCircleOutlinedIcon />} onClick={stopOrganizing} disabled={cancelRequested}>{cancelRequested ? "Stopping…" : "Stop after this file"}</Button>}
                <Button variant="contained" onClick={() => setConfirmation("organize")} disabled={!plan?.summary.ready || busy} startIcon={<CheckCircleOutlineRoundedIcon />}>Move {plan ? countLabel(plan.summary.ready, "file") : "0 files"}</Button>
              </Stack>
            </Stack>
            )}
          </Paper>
        </Container>
        </Box>
      </Box>

      <CategoriesDialog open={categoriesOpen} onClose={() => setCategoriesOpen(false)} onSaved={() => { void invalidatePlan('Category rules saved. Review the folder again to see the updated destinations.'); setNotice({ message: 'Folder and file type rules saved.', severity: 'success' }); }} />
      <Dialog open={busy} aria-labelledby="progress-title">
        <DialogTitle id="progress-title">{workingLabel}</DialogTitle>
        <DialogContent sx={{ minWidth: 340 }}>
          <Stack direction="row" spacing={2} sx={{ justifyContent: "space-between" }}><Typography variant="body2" color="text.secondary">{progress ? `${progress.current} of ${progress.total}` : "Preparing…"}</Typography><Typography variant="body2" color="text.secondary">{progress ? `${progressValue}%` : ""}</Typography></Stack>
          <LinearProgress aria-labelledby="progress-title" variant={progress ? "determinate" : "indeterminate"} value={progressValue} sx={{ mt: 1.25 }} />
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1.25, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cancelRequested ? "Stopping after the current file…" : progress?.filename ?? (working === "scan" ? "Reading loose files…" : "Preparing…")}</Typography>
        </DialogContent>
        {working === "organize" && <DialogActions><Button color="inherit" startIcon={<StopCircleOutlinedIcon />} onClick={stopOrganizing} disabled={cancelRequested}>{cancelRequested ? "Stopping…" : "Stop after this file"}</Button></DialogActions>}
      </Dialog>

      <Dialog open={confirmation !== null} onClose={() => setConfirmation(null)} aria-labelledby="confirm-title">
        <DialogTitle id="confirm-title">{confirmation === "organize" ? "Move these files?" : "Undo the last run?"}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {confirmation === "organize"
              ? `Move ${countLabel(plan?.summary.ready ?? 0, "file")} into category folders inside the selected folder? Nothing will be deleted or overwritten.`
              : `Move unchanged files from the last run${lastRun.root ? ` in ${lastRun.root}` : ""} back to their original locations? ${lastRun.unresolved ? `${countLabel(lastRun.unresolved, "file")} still needs recovery review. ` : ""}File Tidy skips anything that changed or now conflicts.`}
          </DialogContentText>
        </DialogContent>
        <DialogActions><Button onClick={() => setConfirmation(null)}>Cancel</Button><Button variant="contained" onClick={confirmation === "organize" ? runOrganize : runUndo}>{confirmation === "organize" ? "Move files" : "Undo run"}</Button></DialogActions>
      </Dialog>

      <Snackbar open={notice !== null} autoHideDuration={6500} onClose={() => setNotice(null)} anchorOrigin={{ vertical: "bottom", horizontal: "right" }}>
        <Alert severity={notice?.severity ?? "info"} variant="filled" onClose={() => setNotice(null)} sx={{ maxWidth: 460 }}>{notice?.message}</Alert>
      </Snackbar>
    </ThemeProvider>
  );
}

function SummaryCard({ label, value, helper, color, tint }: { label: string; value: number; helper: string; color: string; tint: "success" | "warning" | "default" }) {
  const background = tint === "success" ? alpha(theme.palette.success.main, 0.08) : tint === "warning" ? alpha(theme.palette.warning.main, 0.1) : alpha(theme.palette.primary.main, 0.035);
  const borderColor = tint === "success" ? alpha(theme.palette.success.main, 0.22) : tint === "warning" ? alpha(theme.palette.warning.main, 0.25) : "divider";
  return <Paper variant="outlined" sx={{ flex: 1, minHeight: 104, p: 1.75, bgcolor: background, borderColor }}>
    <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>{label}</Typography>
    <Typography variant="h4" sx={{ mt: 0.2, color, fontSize: 29 }}>{value}</Typography>
    <Typography variant="caption" color="text.secondary">{helper}</Typography>
  </Paper>;
}

const PlanPreviewTable = memo(function PlanPreviewTable({ plan }: { plan: OrganizationPlan }) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<PreviewStatusFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [sortKey, setSortKey] = useState<PreviewSortKey>("filename");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);

  const categories = useMemo(() => Array.from(new Set(
    plan.entries.map((entry) => entry.categoryName).filter((category): category is string => Boolean(category)),
  )).sort((left, right) => left.localeCompare(right)), [plan.entries]);

  const filteredEntries = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return plan.entries.filter((entry) => {
      const matchesQuery = !normalizedQuery || [
        entry.filename,
        entry.categoryName ?? "",
        entry.destination ?? "",
        entry.reason,
      ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
      const matchesStatus = statusFilter === "all" || previewStatus(entry) === statusFilter;
      const matchesCategory = categoryFilter === "all" || entry.categoryName === categoryFilter;
      return matchesQuery && matchesStatus && matchesCategory;
    });
  }, [categoryFilter, plan.entries, query, statusFilter]);

  const sortedEntries = useMemo(() => [...filteredEntries].sort((left, right) => {
    const valueFor = (entry: OrganizationPlan["entries"][number]): string => {
      switch (sortKey) {
        case "category": return entry.categoryName ?? "";
        case "destination": return relativePath(plan, entry.destination);
        case "status": return statusChip(entry).label;
        default: return entry.filename;
      }
    };
    const comparison = valueFor(left).localeCompare(valueFor(right), undefined, { numeric: true, sensitivity: "base" });
    return sortDirection === "asc" ? comparison : -comparison;
  }), [filteredEntries, plan, sortDirection, sortKey]);

  const currentPage = Math.min(page, Math.max(0, Math.ceil(sortedEntries.length / rowsPerPage) - 1));
  const visibleEntries = useMemo(() => sortedEntries.slice(currentPage * rowsPerPage, currentPage * rowsPerPage + rowsPerPage), [currentPage, rowsPerPage, sortedEntries]);

  useEffect(() => {
    setPage(0);
  }, [categoryFilter, plan.id, query, rowsPerPage, statusFilter]);

  const requestSort = (nextSortKey: PreviewSortKey) => {
    if (sortKey === nextSortKey) {
      setSortDirection((currentDirection) => currentDirection === "asc" ? "desc" : "asc");
    } else {
      setSortKey(nextSortKey);
      setSortDirection("asc");
    }
  };

  const sortLabel = (label: string, key: PreviewSortKey) => (
    <TableSortLabel
      active={sortKey === key}
      direction={sortKey === key ? sortDirection : "asc"}
      onClick={() => requestSort(key)}
    >
      {label}
    </TableSortLabel>
  );

  return <Box sx={{ mt: 1.5 }}>
    <Stack direction={{ xs: "column", lg: "row" }} spacing={1.25} sx={{ mb: 1.25 }}>
      <TextField
        label="Filter files"
        placeholder="Name, folder, or reason"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        size="small"
        fullWidth
        slotProps={{ htmlInput: { "aria-label": "Filter planned files" } }}
      />
      <FormControl size="small" sx={{ minWidth: { xs: "100%", sm: 170 } }}>
        <InputLabel id="preview-status-label">Status</InputLabel>
        <Select labelId="preview-status-label" label="Status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as PreviewStatusFilter)}>
          <MenuItem value="all">All statuses</MenuItem>
          <MenuItem value="ready">Ready to move</MenuItem>
          <MenuItem value="attention">Needs attention</MenuItem>
          <MenuItem value="unchanged">Left unchanged</MenuItem>
        </Select>
      </FormControl>
      <FormControl size="small" sx={{ minWidth: { xs: "100%", sm: 190 } }}>
        <InputLabel id="preview-category-label">Category</InputLabel>
        <Select labelId="preview-category-label" label="Category" value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}>
          <MenuItem value="all">All categories</MenuItem>
          {categories.map((category) => <MenuItem key={category} value={category}>{category}</MenuItem>)}
        </Select>
      </FormControl>
    </Stack>
    <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: 340 }}>
      <Table stickyHeader size="small" aria-label="Planned file moves">
        <TableHead>
          <TableRow>
            <TableCell sortDirection={sortKey === "filename" ? sortDirection : false} sx={{ width: "29%" }}>{sortLabel("File", "filename")}</TableCell>
            <TableCell sortDirection={sortKey === "category" ? sortDirection : false} sx={{ width: "17%" }}>{sortLabel("Category", "category")}</TableCell>
            <TableCell sortDirection={sortKey === "destination" ? sortDirection : false} sx={{ width: "30%" }}>{sortLabel("Destination", "destination")}</TableCell>
            <TableCell sortDirection={sortKey === "status" ? sortDirection : false} sx={{ width: "24%" }}>{sortLabel("Status", "status")}</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {visibleEntries.length === 0 ? (
            <TableRow>
              <TableCell colSpan={4} align="center" sx={{ py: 4, color: "text.secondary" }}>No planned files match these filters.</TableCell>
            </TableRow>
          ) : visibleEntries.map((entry) => {
            const status = statusChip(entry);
            return <TableRow key={entry.source} hover>
              <TableCell sx={{ fontWeight: 650, maxWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={entry.filename}>{entry.filename}</TableCell>
              <TableCell>{entry.categoryName ?? "—"}</TableCell>
              <TableCell sx={{ maxWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: '"Cascadia Mono", Consolas, monospace', fontSize: 12, color: "text.secondary" }} title={entry.destination ?? ""}>{relativePath(plan, entry.destination)}</TableCell>
              <TableCell><Tooltip title={status.label}><Chip size="small" color={status.color} label={status.label} sx={{ maxWidth: "100%", ".MuiChip-label": { overflow: "hidden", textOverflow: "ellipsis" } }} /></Tooltip></TableCell>
            </TableRow>;
          })}
        </TableBody>
      </Table>
    </TableContainer>
    <TablePagination
      component="div"
      count={filteredEntries.length}
      page={currentPage}
      onPageChange={(_event, nextPage) => setPage(nextPage)}
      rowsPerPage={rowsPerPage}
      onRowsPerPageChange={(event) => setRowsPerPage(Number(event.target.value))}
      rowsPerPageOptions={[10, 25, 50, 100]}
      labelRowsPerPage="Rows per page"
    />
  </Box>;
});

const RecoveryResultsTable = memo(function RecoveryResultsTable({
  entries,
  root,
  onRetry,
  retryAvailable,
}: {
  entries: NonNullable<LastRunState["results"]>;
  root?: string;
  onRetry: () => void;
  retryAvailable: boolean;
}) {
  const [page, setPage] = useState(0);
  const rowsPerPage = 10;
  const currentPage = Math.min(page, Math.max(0, Math.ceil(entries.length / rowsPerPage) - 1));
  const visibleEntries = entries.slice(currentPage * rowsPerPage, currentPage * rowsPerPage + rowsPerPage);

  useEffect(() => {
    setPage(0);
  }, [entries]);

  return <Box sx={{ mt: 0.5 }}>
    <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ justifyContent: "space-between", alignItems: { xs: "flex-start", sm: "center" }, mb: 1.25 }}>
      <Box>
        <Typography variant="subtitle1" sx={{ fontWeight: 750 }}>Recovery details</Typography>
        <Typography variant="body2" color="text.secondary">Review affected files{root ? ` from ${root}` : ""}. File Tidy will retry only when it can do so safely.</Typography>
      </Box>
      <Button variant="outlined" startIcon={<HistoryRoundedIcon />} onClick={onRetry} disabled={!retryAvailable}>Retry Undo</Button>
    </Stack>
    <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: 300 }}>
      <Table stickyHeader size="small" aria-label="Recovery details">
        <TableHead><TableRow><TableCell sx={{ width: "22%" }}>File</TableCell><TableCell sx={{ width: "31%" }}>Current / original path</TableCell><TableCell sx={{ width: "31%" }}>Reason</TableCell><TableCell sx={{ width: "16%" }}>State</TableCell></TableRow></TableHead>
        <TableBody>
          {visibleEntries.map((entry) => {
            const retryable = entry.undoStatus === "retryable";
            const label = retryable ? "Retry undo" : entry.undoStatus === "in_progress" || entry.status === "in_progress" ? "Needs review" : "Could not move";
            const color = retryable ? "warning" as const : "error" as const;
            const pathSummary = entry.destination
              ? `Current: ${entry.destination}\nOriginal: ${entry.source}`
              : `Original: ${entry.source}`;
            return <TableRow key={`${entry.source}-${entry.destination ?? ""}`} hover>
              <TableCell sx={{ fontWeight: 650, maxWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={entry.filename}>{entry.filename}</TableCell>
              <TableCell title={pathSummary}>
                {entry.destination && <Typography variant="caption" component="div" sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: '"Cascadia Mono", Consolas, monospace', color: "text.secondary" }}>Current: {entry.destination}</Typography>}
                <Typography variant="caption" component="div" sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: '"Cascadia Mono", Consolas, monospace', color: "text.secondary" }}>Original: {entry.source}</Typography>
              </TableCell>
              <TableCell sx={{ maxWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={recoveryReason(entry)}>{recoveryReason(entry)}</TableCell>
              <TableCell><Chip size="small" color={color} label={label} /></TableCell>
            </TableRow>;
          })}
        </TableBody>
      </Table>
    </TableContainer>
    {entries.length > rowsPerPage && <TablePagination
      component="div"
      count={entries.length}
      page={currentPage}
      onPageChange={(_event, nextPage) => setPage(nextPage)}
      rowsPerPage={rowsPerPage}
      rowsPerPageOptions={[rowsPerPage]}
      labelRowsPerPage="Rows per page"
    />}
  </Box>;
});
