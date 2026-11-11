"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AccountCircleOutlined, AutoAwesome, ChevronRight, Close, History, Logout, SwitchAccountOutlined } from "@mui/icons-material";
import { Alert, AppBar, Avatar, Box, Button, Dialog, DialogContent, DialogTitle, Divider, IconButton, Paper, Stack, Tab, Tabs, TextField, Toolbar, Typography } from "@mui/material";
import { createContext, type FormEvent, type ReactNode, useContext, useEffect, useId, useRef, useState } from "react";
import { api, errorMessage, jsonBody, sessionCheckEvent, type User } from "../lib/api";

const sessionChangeKey = "studio:session-changed";
const demos = [{ username: "lin", displayName: "林夏" }, { username: "zhou", displayName: "周野" }];
type Credentials = { username: string; password: string; displayName?: string };

interface Session {
  user: User | null;
  busy: boolean;
  sessionReady: boolean;
  sessionError: string | null;
  actionError: string | null;
  authenticate: (credentials: Credentials) => void;
  refresh: () => void;
}

const SessionContext = createContext<Session | null>(null);

export function useSession() {
  const session = useContext(SessionContext);
  if (!session) throw new Error("Session context is missing");
  return session;
}

export function StudioShell({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [busy, setBusy] = useState(true);
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [accountOpen, setAccountOpen] = useState(false);
  const [showAccess, setShowAccess] = useState(false);
  const accessId = useId();
  const action = useRef<AbortController | null>(null);
  const checking = useRef<AbortController | null>(null);
  const checkAfterAction = useRef(false);
  const main = useRef<HTMLElement>(null);
  const focusAfterLogin = useRef(false);
  const pathname = usePathname();

  useEffect(() => {
    function check() {
      if (action.current) return;
      checking.current?.abort();
      const controller = new AbortController();
      checking.current = controller;
      void api<{ user: User | null }>("/session", { signal: controller.signal })
        .then((response) => {
          if (!controller.signal.aborted) {
            setUser(response.user);
            setSessionReady(true);
            setSessionError(null);
          }
        })
        .catch((problem) => { if (!controller.signal.aborted) setSessionError(errorMessage(problem)); })
        .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    }

    function synchronize() {
      if (action.current) {
        checkAfterAction.current = true;
        return;
      }
      setUser(null);
      setSessionReady(false);
      setSessionError(null);
      setActionError(null);
      setBusy(true);
      check();
    }

    function onStorage(event: StorageEvent) {
      if (event.key === sessionChangeKey) synchronize();
    }

    check();
    window.addEventListener("focus", check);
    window.addEventListener("storage", onStorage);
    window.addEventListener(sessionCheckEvent, synchronize);
    return () => {
      checking.current?.abort();
      window.removeEventListener("focus", check);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(sessionCheckEvent, synchronize);
    };
  }, [refreshKey]);

  useEffect(() => () => action.current?.abort(), []);

  useEffect(() => {
    if (busy || !focusAfterLogin.current) return;
    focusAfterLogin.current = false;
    if (user) (main.current?.querySelector<HTMLElement>("[data-focus-after-login]") ?? main.current)?.focus();
  }, [busy, user]);

  function refresh() {
    if (!user) setSessionReady(false);
    setSessionError(null);
    setBusy(true);
    setRefreshKey((key) => key + 1);
  }

  function closeAccount() {
    setAccountOpen(false);
    setActionError(null);
  }

  async function changeSession(credentials?: Credentials, focusWorkspace = false) {
    if (busy || action.current) return;
    focusAfterLogin.current = focusWorkspace;
    const controller = new AbortController();
    checking.current?.abort();
    action.current = controller;
    setBusy(true);
    setActionError(null);
    try {
      if (credentials) {
        const path = credentials.displayName === undefined ? "/session" : "/session/register";
        const response = await api<{ user: User }>(path, jsonBody(credentials, controller.signal));
        if (!controller.signal.aborted) setUser(response.user);
      } else {
        await api("/session/logout", { method: "POST", signal: controller.signal });
        if (!controller.signal.aborted) setUser(null);
      }
      if (!controller.signal.aborted) {
        setSessionReady(true);
        setSessionError(null);
        setAccountOpen(false);
        try {
          localStorage.setItem(sessionChangeKey, crypto.getRandomValues(new Uint32Array(2)).join("-"));
        } catch {
          // Focus rechecks the session when storage is unavailable.
        }
      }
    } catch (problem) {
      if (!controller.signal.aborted) setActionError(errorMessage(problem));
    } finally {
      action.current = null;
      if (!controller.signal.aborted && checkAfterAction.current) {
        checkAfterAction.current = false;
        setUser(null);
        setSessionReady(false);
        refresh();
      } else if (!controller.signal.aborted) {
        setBusy(false);
      }
    }
  }

  return (
    <SessionContext.Provider value={{ user, busy, sessionReady, sessionError, actionError,
      authenticate: (credentials) => void changeSession(credentials, true), refresh }}>
      <a href="#main" className="skip-link">跳转到主要内容</a>
      <AppBar position="static" elevation={0} color="transparent" className="site-header">
        <Toolbar disableGutters className="header-inner">
          <IconButton component={Link} href="/templates" aria-label="素材工场首页" className="brand-mark">
            <AutoAwesome fontSize="small" />
          </IconButton>
          <Button color="inherit" aria-label="当前账号与切换" aria-haspopup="dialog" onClick={() => {
            setActionError(null);
            setShowAccess(false);
            setAccountOpen(true);
          }}>
            <Avatar className="avatar" sx={{ width: 25, height: 25, mr: { xs: 0, sm: 1 }, fontSize: 12 }}>
              {user ? Array.from(user.displayName)[0] : <AccountCircleOutlined fontSize="small" />}
            </Avatar>
            <Box component="span" sx={{ ml: { xs: 0.5, sm: 0 }, maxWidth: { xs: "7ch", sm: "16ch" },
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {busy ? "连接中" : user?.displayName ?? (sessionError ? "账号待确认" : "登录 / 注册")}
            </Box>
          </Button>
        </Toolbar>
      </AppBar>
      {!accountOpen && (user || pathname === "/templates") && (
        sessionError ? <Box className="shell-error"><SessionCheckNotice /></Box>
          : actionError && <Alert severity="error" className="shell-error">{actionError}</Alert>
      )}
      <main id="main" tabIndex={-1} ref={main}>{children}</main>
      <Dialog open={accountOpen} onClose={closeAccount} fullWidth maxWidth="sm"
        aria-labelledby="account-dialog-title" slotProps={{ paper: { className: "account-dialog" } }}>
        <DialogTitle id="account-dialog-title" className="dialog-heading">
          {user ? "账户设置" : !sessionReady || sessionError ? "检查账号" : "登录 / 注册"}
          <IconButton aria-label="关闭账户设置" onClick={closeAccount}><Close /></IconButton>
        </DialogTitle>
        <DialogContent>
          {user ? (
            <Stack spacing={2}>
              <Paper className="account-profile" elevation={0}>
                <Stack direction="row" spacing={2} sx={{ alignItems: "center" }}>
                  <Avatar sx={{ width: 60, height: 60, bgcolor: "#698700" }}>{Array.from(user.displayName)[0]}</Avatar>
                  <Box sx={{ minWidth: 0, overflowWrap: "anywhere" }}>
                    <Typography variant="h6">{user.displayName}</Typography>
                    <Typography color="text.secondary">@{user.username}</Typography>
                  </Box>
                </Stack>
                <Divider sx={{ my: 2 }} />
                <Typography color="text.secondary" variant="body2">个人历史随账号保存，只有登录该账号才可查看任务和结果。</Typography>
              </Paper>
              <Paper variant="outlined" className="account-actions">
                <Button component={Link} href="/history" color="inherit" startIcon={<History />}
                  onClick={closeAccount}>
                  我的制作<ChevronRight className="account-arrow" fontSize="small" />
                </Button>
                <Divider />
                <Button color="inherit" startIcon={<SwitchAccountOutlined />} disabled={busy}
                  aria-expanded={showAccess} aria-controls={accessId}
                  onClick={() => { setActionError(null); setShowAccess((open) => !open); }}>
                  切换账号<ChevronRight className="account-arrow" fontSize="small" />
                </Button>
                <Divider />
                <Button color="inherit" startIcon={<Logout />} disabled={busy}
                  onClick={() => void changeSession()}>退出登录</Button>
              </Paper>
              <Box id={accessId} hidden={!showAccess}>
                {showAccess && <AccountAccess busy={busy} error={actionError} current={user.username}
                  submit={(credentials) => void changeSession(credentials)} />}
              </Box>
              {actionError && !showAccess && <Alert severity="error">{actionError}</Alert>}
              {sessionError && <SessionCheckNotice />}
            </Stack>
          ) : !sessionReady || sessionError ? <SessionCheckNotice />
            : <AccountAccess busy={busy} error={actionError} submit={(credentials) => void changeSession(credentials)} />}
        </DialogContent>
      </Dialog>
    </SessionContext.Provider>
  );
}

function AccountAccess({ busy, error, current, submit }: {
  busy: boolean;
  error: string | null;
  current?: string;
  submit: (credentials: Credentials) => void;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const formId = useId();
  const registering = mode === "register";
  function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const credentials: Credentials = {
      username: String(form.get("username") ?? ""), password: String(form.get("password") ?? ""),
    };
    if (registering) credentials.displayName = String(form.get("displayName") ?? "");
    submit(credentials);
  }
  return (
    <Stack spacing={1.5}>
      <Tabs value={mode} onChange={(_event, value) => setMode(value)} aria-label="账号操作" variant="fullWidth">
        <Tab value="login" label={current ? "切换账号" : "账号登录"} disabled={busy} id={formId + "-login"} aria-controls={formId} />
        <Tab value="register" label="注册账号" disabled={busy} id={formId + "-register"} aria-controls={formId} />
      </Tabs>
      <Box role="tabpanel" id={formId} aria-labelledby={formId + "-" + mode}>
        <Stack component="form" key={mode} onSubmit={send} spacing={1.5}>
          <TextField name="username" label="用户名" required size="small" autoComplete="username" disabled={busy}
            helperText={registering ? "3–40 位英文字母、数字、下划线或连字符，以字母或数字开头" : undefined} />
          {registering && <TextField name="displayName" label="显示名称" required size="small" autoComplete="nickname" disabled={busy} />}
          <TextField name="password" label="密码" required size="small" type="password" disabled={busy}
            autoComplete={registering ? "new-password" : "current-password"}
            helperText={registering ? "至少 8 个字符，UTF-8 编码最多 72 字节" : undefined} />
          {error && <Alert severity="error">{error}</Alert>}
          <Button variant="contained" type="submit" disabled={busy}>
            {busy ? "正在处理…" : registering ? "注册并登录" : "登录"}
          </Button>
        </Stack>
      </Box>
      <Divider>演示账号</Divider>
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
        {demos.filter((demo) => demo.username !== current).map((demo) => (
          <Button variant="outlined" color="inherit" disabled={busy} key={demo.username}
            onClick={() => submit({ username: demo.username, password: "studio-demo" })}>
            {current ? "切换到 " : "使用"}{demo.displayName}
          </Button>
        ))}
      </Stack>
    </Stack>
  );
}

function SessionCheckNotice() {
  const { sessionError, refresh } = useSession();
  return sessionError ? (
    <Alert severity="warning" action={<Button color="inherit" onClick={refresh}>重新检查账号</Button>}>
      <Typography sx={{ fontWeight: 600 }}>暂时无法确认登录状态</Typography>
      {sessionError}
    </Alert>
  ) : <Typography role="status">正在检查账号…</Typography>;
}

export function AccountPrompt() {
  const { busy, sessionReady, sessionError, actionError, authenticate } = useSession();
  if (!sessionReady || sessionError) {
    return <Paper className="account-prompt panel" variant="outlined"><SessionCheckNotice /></Paper>;
  }
  return (
    <Paper className="account-prompt panel" variant="outlined">
      <Typography variant="h6" component="h2">登录后开始制作</Typography>
      <Typography color="text.secondary" variant="body2" sx={{ mb: 1.5 }}>素材和制作记录保存在你的账号下。</Typography>
      <AccountAccess busy={busy} error={actionError} submit={authenticate} />
    </Paper>
  );
}
