"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { api, errorMessage, jsonBody, type User } from "../lib/api";

const demos = [{ username: "lin", displayName: "林夏" }, { username: "zhou", displayName: "周野" }];

interface Session {
  user: User | null;
  busy: boolean;
  error: string | null;
  login: (username: string) => void;
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
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const action = useRef<AbortController | null>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  const pathname = usePathname();

  useEffect(() => {
    const controller = new AbortController();
    void api<{ user: User | null }>("/session", { signal: controller.signal })
      .then((response) => { if (!controller.signal.aborted) setUser(response.user); })
      .catch((problem) => { if (!controller.signal.aborted) setError(errorMessage(problem)); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [refreshKey]);

  useEffect(() => () => action.current?.abort(), []);

  function refresh() {
    setError(null);
    setBusy(true);
    setRefreshKey((key) => key + 1);
  }

  async function changeSession(username?: string) {
    if (busy || action.current) return;
    if (menu.current) menu.current.open = false;
    const controller = new AbortController();
    action.current = controller;
    setBusy(true);
    setError(null);
    try {
      if (username) {
        const response = await api<{ user: User }>("/session",
          jsonBody({ username, password: "studio-demo" }, controller.signal));
        if (!controller.signal.aborted) setUser(response.user);
      } else {
        await api("/session/logout", { method: "POST", signal: controller.signal });
        if (!controller.signal.aborted) setUser(null);
      }
    } catch (problem) {
      if (!controller.signal.aborted) setError(errorMessage(problem));
    } finally {
      action.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return (
    <SessionContext.Provider value={{ user, busy, error, login: (id) => void changeSession(id), refresh }}>
      <a href="#main" className="skip-link">跳转到主要内容</a>
      <header className="site-header">
        <div className="header-inner">
          <Link href="/templates" className="brand">
            <span className="brand-mark" aria-hidden="true">✳</span>
            <span>素材工场 <small>MAT.STUDIO</small></span>
          </Link>
          <nav aria-label="主导航">
            <Link href="/templates" aria-current={pathname.startsWith("/templates") ? "page" : undefined}>模板库</Link>
            <Link href="/history" aria-current={pathname === "/history" ? "page" : undefined}>我的制作</Link>
          </nav>
          <details className="account-menu" ref={menu}>
            <summary aria-label="当前账号与切换">
              <span className="avatar" aria-hidden="true">{user?.displayName[0] ?? "人"}</span>
              <span className="account-name">{busy ? "连接中" : user?.displayName ?? "演示账号"}</span>
              <span aria-hidden="true" className="chevron">⌄</span>
            </summary>
            <div className="account-popover">
              <p>演示账号</p>
              {demos.filter((demo) => demo.username !== user?.username).map((demo) => (
                <button key={demo.username} disabled={busy} onClick={() => void changeSession(demo.username)}>
                  {user ? "切换到" : "以此账号进入"} {demo.displayName}
                </button>
              ))}
              {user && <button disabled={busy} onClick={() => void changeSession()}>退出登录</button>}
            </div>
          </details>
        </div>
      </header>
      {error && <div className="shell-error notice" role="alert">
        {error} <button className="text-button" onClick={refresh}>重新检查账号</button>
      </div>}
      <main id="main" tabIndex={-1}>{children}</main>
    </SessionContext.Provider>
  );
}

export function AccountPrompt() {
  const { busy, login } = useSession();
  return (
    <div className="empty-box">
      <span className="empty-mark" aria-hidden="true">◈</span>
      <h2>{busy ? "正在确认账号…" : "选择一个演示账号"}</h2>
      <p>登录后可以上传图片，制作记录会保存在该账号下。</p>
      <div className="button-row">
        {demos.map((demo) => (
          <button className="secondary-button" disabled={busy} key={demo.username}
            onClick={() => login(demo.username)}>使用{demo.displayName}</button>
        ))}
      </div>
    </div>
  );
}
