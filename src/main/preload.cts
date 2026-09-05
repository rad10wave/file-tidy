const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

contextBridge.exposeInMainWorld("fileTidy", {
  getCategories: () => ipcRenderer.invoke('organizer:categories'),
  saveCategories: (categories: unknown) => ipcRenderer.invoke('organizer:save-categories', categories),
  chooseFolder: () => ipcRenderer.invoke("organizer:choose-folder"),
  scan: (folder: string, options: { moveUnknownToOthers: boolean; keepBothOnCollision: boolean }) => (
    ipcRenderer.invoke("organizer:scan", { folder, options })
  ),
  discardPlans: () => ipcRenderer.invoke("organizer:discard-plans"),
  organize: (planId: string) => ipcRenderer.invoke("organizer:organize", planId),
  cancel: (planId: string) => ipcRenderer.send("organizer:cancel", planId),
  undo: () => ipcRenderer.invoke("organizer:undo"),
  getLastRun: () => ipcRenderer.invoke("organizer:last-run"),
  openFolder: () => ipcRenderer.invoke("organizer:open-folder"),
  onProgress: (handler: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => handler(payload);
    ipcRenderer.on("organizer:progress", listener);
    return () => ipcRenderer.removeListener("organizer:progress", listener);
  },
  onCloseBlocked: (handler: () => void) => {
    const listener = () => handler();
    ipcRenderer.on("organizer:close-blocked", listener);
    return () => ipcRenderer.removeListener("organizer:close-blocked", listener);
  },
});
