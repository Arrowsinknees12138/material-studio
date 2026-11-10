"use client";

import Link from "next/link";
import { HistoryPanel, useHistory } from "../../components/history-panel";
import { AccountPrompt, useSession } from "../../components/studio-shell";

function MyHistory() {
  const history = useHistory();
  return <HistoryPanel history={history} full />;
}

export default function HistoryPage() {
  const { user, busy } = useSession();
  return (
    <div className="container workspace-page">
      <Link href="/templates" className="back-link">← 返回模板库</Link>
      <h1>我的制作<span>。</span></h1>
      <p className="intro-copy">查看制作进度，预览已经完成的图片。</p>
      {!busy && user ? <MyHistory key={user.username} /> : <AccountPrompt />}
    </div>
  );
}
