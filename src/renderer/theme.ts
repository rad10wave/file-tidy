import { createTheme } from "@mui/material/styles";

export const theme = createTheme({
  palette: {
    mode: "light",
    primary: { main: "#0f6cbd", dark: "#075da7", light: "#e8f3ff" },
    success: { main: "#16753e" },
    warning: { main: "#8a5700" },
    error: { main: "#b3261e" },
    background: { default: "#f5f7fa", paper: "#ffffff" },
    text: { primary: "#172537", secondary: "#5b6b7d" },
    divider: "#e2e7ee",
  },
  shape: { borderRadius: 12 },
  typography: {
    fontFamily: '"Segoe UI Variable", "Segoe UI", system-ui, sans-serif',
    h4: { fontWeight: 720, letterSpacing: "-0.025em" },
    h6: { fontWeight: 700, letterSpacing: "-0.015em" },
    button: { fontWeight: 650, textTransform: "none" },
  },
  components: {
    MuiCssBaseline: { styleOverrides: { 'html, body, #root': { height: '100%', overflow: 'hidden' }, '*': { scrollbarWidth: 'auto', scrollbarColor: '#aab5c2 #f5f7fa' } } },
    MuiButton: { defaultProps: { disableElevation: true }, styleOverrides: { root: { borderRadius: 8, padding: '8px 16px', minHeight: 40, flexShrink: 0 }, startIcon: { marginLeft: 0, marginRight: 8 }, endIcon: { marginLeft: 8, marginRight: 0 }, outlined: { borderColor: '#d3dce7', backgroundColor: '#ffffff' } } },
    MuiPaper: { styleOverrides: { outlined: { borderColor: "#e2e7ee" } } },
    MuiTableCell: { styleOverrides: { root: { padding: '12px 16px', borderColor: '#edf0f4' }, head: { fontWeight: 650, color: "#51677a", backgroundColor: '#f8fafc', fontSize: 12 } } },
    MuiChip: { styleOverrides: { root: { fontWeight: 600, borderRadius: 6 }, sizeSmall: { height: 25, fontSize: 11 } } },
    MuiDialog: { styleOverrides: { paper: { margin: '44px 32px', maxHeight: 'calc(100% - 88px)', borderRadius: 16, boxShadow: '0 24px 80px #17253726' } } },
    MuiDialogTitle: { styleOverrides: { root: { padding: '24px', fontWeight: 700 } } },
    MuiDialogActions: { styleOverrides: { root: { padding: '16px 24px', gap: 8 } } },
    MuiOutlinedInput: { styleOverrides: { root: { backgroundColor: '#ffffff', borderRadius: 8 }, notchedOutline: { borderColor: '#cdd6e1' } } },
  },
});
