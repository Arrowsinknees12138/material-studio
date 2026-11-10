import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppRouterCacheProvider } from "@mui/material-nextjs/v15-appRouter";
import { StudioShell } from "../components/studio-shell";
import { StudioTheme } from "../components/studio-theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "素材工场 · Material Studio",
  description: "挑选模板，上传图片，在后台制作并查看个人结果。",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <AppRouterCacheProvider>
          <StudioTheme><StudioShell>{children}</StudioShell></StudioTheme>
        </AppRouterCacheProvider>
      </body>
    </html>
  );
}
