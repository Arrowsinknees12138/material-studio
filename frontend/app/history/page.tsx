"use client";

import Link from "next/link";
import ChevronLeft from "@mui/icons-material/ChevronLeft";
import { Box, IconButton, Stack, Typography } from "@mui/material";
import { HistoryPanel, useHistory } from "../../components/history-panel";
import { AccountPrompt, useSession } from "../../components/studio-shell";

function MyHistory() {
  const history = useHistory();
  return <HistoryPanel history={history} full />;
}

export default function HistoryPage() {
  const { user } = useSession();
  return (
    <Box className="workspace-page">
      <Stack direction="row" spacing={0.5} sx={{ alignItems: "center", mb: 1.5 }}>
        <IconButton component={Link} href="/templates" aria-label="返回模板库"><ChevronLeft /></IconButton>
        <Typography component="h1" variant="h6">我的制作</Typography>
      </Stack>
      {user ? <MyHistory key={user.username} /> : <AccountPrompt />}
    </Box>
  );
}
