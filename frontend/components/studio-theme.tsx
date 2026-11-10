"use client";

import CssBaseline from "@mui/material/CssBaseline";
import { createTheme, ThemeProvider } from "@mui/material/styles";
import type { ReactNode } from "react";

const theme = createTheme({
  palette: {
    mode: "dark",
    background: { default: "#0b0b0d", paper: "#131317" },
    primary: { main: "#c8f137", contrastText: "#11130a" },
    text: { primary: "#f6f5f8", secondary: "#b8b7c2" },
    divider: "#29292f",
    error: { main: "#ffb4b2" },
  },
  shape: { borderRadius: 10 },
  typography: {
    fontFamily: 'Inter, "Segoe UI", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif',
    fontSize: 13,
    button: { textTransform: "none", fontWeight: 600 },
  },
  components: {
    MuiButton: { defaultProps: { disableElevation: true } },
    MuiPaper: { styleOverrides: { root: { backgroundImage: "none" } } },
    MuiIconButton: { defaultProps: { size: "small" } },
  },
});

export function StudioTheme({ children }: { children: ReactNode }) {
  return <ThemeProvider theme={theme}><CssBaseline />{children}</ThemeProvider>;
}
