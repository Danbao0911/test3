"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

type LinkItem = {
  id: string;
  status: "PENDING" | "CONFIRMED" | "REVOKED";
  basis: "MANUAL" | "SHARED_CONTACT_CANDIDATE";
  version: number;
  usable: boolean;
  createdAt: string;
  updatedAt: string;
  leftAccount: { id: string; platform: string; displayName: string; organization: string | null; isDemo: boolean };
  rightAccount: { id: string; platform: string; displayName: string; organization: string | null; isDemo: boolean };
  source: { id: string; name: string; status: string; allowRelate?: boolean; policyVersion?: number; expiresAt?: string | null };
  reason: string | null;
};

const statusLabels = { PENDING: "待人工核验", CONFIRMED: "已确认", REVOKED: "已撤销" };
const basisLabels = { MANUAL: "人工提出", SHARED_CONTACT_CANDIDATE: "共享联系候选" };

async function readResponse(response: Response) {
  try {
    const value: unknown = await response.json();
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

export default function AccountLinksPage({ canReview }: { canReview: boolean }) {
  const [status, setStatus] = useState("PENDING");
  const [items, setItems] = useState<LinkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const generation = useRef(0);

  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true); setError("");
    try {
      const response = await fetch(`/api/account-links?status=${encodeURIComponent(status)}`, { cache: "no-store" });
      const data = await readResponse(response);
      if (!response.ok) throw new Error(typeof data.message === "string" ? data.message : "账号关联加载失败");
      if (current === generation.current) setItems(Array.isArray(data.items) ? data.items as LinkItem[] : []);
    } catch (err) {
      if (current === generation.current) setError(err instanceof Error ? err.message : "网络异常，请重试");
    } finally { if (current === generation.current) setLoading(false); }
  }, [status]);

  useEffect(() => { queueMicrotask(() => { void load(); }); }, [load]);

  async function review(item: LinkItem, nextStatus: "CONFIRMED" | "REVOKED") {
    if (!canReview || busyId) return;
    const reason = reasons[item.id]?.trim() ?? "";
    if (!reason) { setError("审核关联必须填写不含联系原文的判断理由"); return; }
    setBusyId(item.id); setError("");
    try {
      const response = await fetch(`/api/account-links/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Origin: window.location.origin },
        body: JSON.stringify({ expectedVersion: item.version, status: nextStatus, reason }),
      });
      const data = await readResponse(response);
      if (!response.ok) throw new Error(response.status === 409 ? "关联已被其他审核操作更新，请刷新后重新核对" : typeof data.message === "string" ? data.message : "关联审核失败");
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : "网络异常，未确认操作结果"); }
    finally { setBusyId(""); }
  }

  return <main className="page">
    <div className="page-header"><div><h1 className="page-title">账号关联审核</h1><p className="page-subtitle">同平台身份由唯一键精确去重；跨账号关联只形成待核验候选，不会自动合并账号。</p></div><Link className="button secondary" href="/accounts">返回账号库</Link></div>
    <div className="notice">共享联系项只能作为候选证据；来源撤销、到期或关联许可关闭后，已确认关联立即标记为当前不可用。</div>
    <section className="card" style={{ marginTop: 20 }}>
      <div className="toolbar"><div className="field"><label htmlFor="link-status">关联状态</label><select id="link-status" value={status} disabled={loading} onChange={(event) => setStatus(event.target.value)}><option value="PENDING">待人工核验</option><option value="CONFIRMED">已确认</option><option value="REVOKED">已撤销</option></select></div><button className="button secondary" disabled={loading} onClick={() => void load()}>刷新</button></div>
      {error && <div className="notice error" role="alert">{error}</div>}
      {loading ? <p role="status">加载中…</p> : !items.length ? <div className="empty">没有符合条件的账号关联记录。</div> : items.map((item) => <article className="card" key={`${item.id}:${item.version}`} style={{ marginTop: 16 }} data-link-id={item.id}>
        <div className="page-header"><div><h2 style={{ margin: 0, fontSize: 18 }}>{item.leftAccount.displayName} ↔ {item.rightAccount.displayName}</h2><p className="muted small">{item.leftAccount.platform} · {item.rightAccount.platform} · {basisLabels[item.basis]} · 来源：{item.source.name}</p></div><div><span className="badge neutral">{statusLabels[item.status]}</span> <span className={`badge ${item.usable ? "success" : "warning"}`}>{item.usable ? "当前可用" : "当前不可用"}</span></div></div>
        <p className="small"><Link className="text-link" href={`/accounts/${item.leftAccount.id}`}>查看左侧账号</Link> · <Link className="text-link" href={`/accounts/${item.rightAccount.id}`}>查看右侧账号</Link> · 策略版本 {item.source.policyVersion ?? "受限"}</p>
        {item.reason && <p className="notice">审核理由：{item.reason}</p>}
        {canReview && item.status === "PENDING" && <fieldset disabled={busyId === item.id} style={{ border: 0, padding: 0 }}><div className="field"><label htmlFor={`link-reason-${item.id}`}>审核理由（不得复制联系值）</label><textarea id={`link-reason-${item.id}`} value={reasons[item.id] ?? ""} maxLength={500} onChange={(event) => setReasons((current) => ({ ...current, [item.id]: event.target.value }))} /></div><div className="inline-actions" style={{ marginTop: 12 }}><button className="button" onClick={() => void review(item, "CONFIRMED")}>{busyId === item.id ? "处理中…" : "确认关联"}</button><button className="button danger" onClick={() => void review(item, "REVOKED")}>撤销候选</button></div></fieldset>}
      </article>)}
    </section>
  </main>;
}
