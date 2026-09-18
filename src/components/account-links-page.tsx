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
  source: { id: string; name: string; status: string; allowRelate?: boolean; policyVersion?: number; recordedPolicyVersion?: number; currentPolicyVersion?: number; expiresAt?: string | null };
  reason: string | null;
  unusableReason: string | null;
  evidence: Array<{ id: string; sourceId: string; policyVersion: number; sourceUrl: string; capturedAt: string; fieldLocation: string; summary: string; leftAccountVerified: boolean; rightAccountVerified: boolean }>;
  history: Array<{ round: number; fromStatus: string; toStatus: string; version: number; reason?: string; createdAt: string }>;
};

type EvidenceDraft = { sourceId: string; sourceUrl: string; capturedAt: string; fieldLocation: string; summary: string; leftAccountVerified: boolean; rightAccountVerified: boolean };

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
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [items, setItems] = useState<LinkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [evidenceDrafts, setEvidenceDrafts] = useState<Record<string, EvidenceDraft>>({});
  const generation = useRef(0);

  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true); setError("");
    try {
      const response = await fetch(`/api/account-links?status=${encodeURIComponent(status)}&page=${page}&pageSize=50`, { cache: "no-store" });
      const data = await readResponse(response);
      if (!response.ok) throw new Error(typeof data.message === "string" ? data.message : "账号关联加载失败");
      if (current === generation.current) {
        const nextTotal = typeof data.total === "number" ? data.total : 0;
        const validPage = nextTotal ? Math.min(page, Math.max(1, Math.ceil(nextTotal / 50))) : 1;
        setTotal(nextTotal);
        if (validPage !== page) setPage(validPage);
        else setItems(Array.isArray(data.items) ? data.items as LinkItem[] : []);
      }
    } catch (err) {
      if (current === generation.current) setError(err instanceof Error ? err.message : "网络异常，请重试");
    } finally { if (current === generation.current) setLoading(false); }
  }, [page, status]);

  useEffect(() => { queueMicrotask(() => { void load(); }); }, [load]);

  function draftFor(item: LinkItem): EvidenceDraft {
    return evidenceDrafts[item.id] ?? { sourceId: item.source.id, sourceUrl: "", capturedAt: new Date().toISOString(), fieldLocation: "账号主体资料", summary: "人工核对两侧账号主体资料并确认关系", leftAccountVerified: true, rightAccountVerified: true };
  }

  async function review(item: LinkItem, nextStatus: "CONFIRMED" | "REVOKED") {
    if (!canReview || busyId) return;
    const reason = reasons[item.id]?.trim() ?? "";
    if (!reason) { setError("审核关联必须填写不含联系原文的判断理由"); return; }
    const evidence = draftFor(item);
    if (nextStatus === "CONFIRMED" && (!evidence.sourceUrl.trim() || !evidence.summary.trim())) { setError("确认关联必须填写来源地址和最小说明"); return; }
    setBusyId(item.id); setError("");
    try {
      const response = await fetch(`/api/account-links/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Origin: window.location.origin },
        body: JSON.stringify({ expectedVersion: item.version, status: nextStatus, reason, ...(nextStatus === "CONFIRMED" ? { evidence: [{ ...evidence, leftAccountId: item.leftAccount.id, rightAccountId: item.rightAccount.id }] } : {}) }),
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
      <div className="toolbar"><div className="field"><label htmlFor="link-status">关联状态</label><select id="link-status" value={status} disabled={loading} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="PENDING">待人工核验</option><option value="CONFIRMED">已确认</option><option value="REVOKED">已撤销</option></select></div><button className="button secondary" disabled={loading} onClick={() => void load()}>刷新</button></div>
      {error && <div className="notice error" role="alert">{error}</div>}
      {loading ? <p role="status">加载中…</p> : !items.length ? <div className="empty">没有符合条件的账号关联记录。</div> : items.map((item) => <article className="card" key={`${item.id}:${item.version}`} style={{ marginTop: 16 }} data-link-id={item.id}>
        <div className="page-header"><div><h2 style={{ margin: 0, fontSize: 18 }}>{item.leftAccount.displayName} ↔ {item.rightAccount.displayName}</h2><p className="muted small">{item.leftAccount.platform} · {item.rightAccount.platform} · {basisLabels[item.basis]} · 来源：{item.source.name}</p></div><div><span className="badge neutral">{statusLabels[item.status]}</span> <span className={`badge ${item.usable ? "success" : "warning"}`}>{item.usable ? "当前可用" : "当前不可用"}</span></div></div>
        <p className="small"><Link className="text-link" href={`/accounts/${item.leftAccount.id}`}>查看左侧账号</Link> · <Link className="text-link" href={`/accounts/${item.rightAccount.id}`}>查看右侧账号</Link> · 策略版本 {item.source.policyVersion ?? "受限"}</p>
        {item.reason && <p className="notice">当前审核理由：{item.reason}</p>}
        {item.unusableReason && item.status === "CONFIRMED" && <p className="muted small">当前不可用原因：{item.unusableReason}；记录策略版本 {item.source.recordedPolicyVersion ?? item.source.policyVersion}，当前来源版本 {item.source.currentPolicyVersion ?? item.source.policyVersion}。</p>}
        {canReview && (item.status === "PENDING" || item.status === "CONFIRMED") && <fieldset disabled={busyId === item.id} style={{ border: 0, padding: 0 }}>
          <div className="field"><label htmlFor={`link-reason-${item.id}`}>{item.status === "CONFIRMED" ? "撤销理由（不得复制联系值）" : "审核理由（不得复制联系值）"}</label><textarea id={`link-reason-${item.id}`} value={reasons[item.id] ?? ""} maxLength={500} onChange={(event) => setReasons((current) => ({ ...current, [item.id]: event.target.value }))} /></div>
          {item.status === "PENDING" && <div className="form-grid" style={{ marginTop: 12 }}>
            <div className="field"><label htmlFor={`link-evidence-url-${item.id}`}>关系证据来源地址</label><input id={`link-evidence-url-${item.id}`} value={draftFor(item).sourceUrl} onChange={(event) => setEvidenceDrafts((current) => ({ ...current, [item.id]: { ...draftFor(item), sourceUrl: event.target.value } }))} placeholder="https://example.com/…" /></div>
            <div className="field"><label htmlFor={`link-evidence-time-${item.id}`}>取得时间</label><input id={`link-evidence-time-${item.id}`} type="datetime-local" value={draftFor(item).capturedAt.slice(0, 16)} onChange={(event) => setEvidenceDrafts((current) => ({ ...current, [item.id]: { ...draftFor(item), capturedAt: new Date(event.target.value).toISOString() } }))} /></div>
            <div className="field"><label htmlFor={`link-evidence-location-${item.id}`}>证据定位</label><input id={`link-evidence-location-${item.id}`} value={draftFor(item).fieldLocation} onChange={(event) => setEvidenceDrafts((current) => ({ ...current, [item.id]: { ...draftFor(item), fieldLocation: event.target.value } }))} /></div>
            <div className="field"><label htmlFor={`link-evidence-summary-${item.id}`}>最小说明</label><input id={`link-evidence-summary-${item.id}`} value={draftFor(item).summary} maxLength={500} onChange={(event) => setEvidenceDrafts((current) => ({ ...current, [item.id]: { ...draftFor(item), summary: event.target.value } }))} /></div>
            <p className="muted small full">确认表示已分别核对两侧账号；共享联系方式只能作为候选依据，不能代替此处关系证据。</p>
          </div>}
          <div className="inline-actions" style={{ marginTop: 12 }}>{item.status === "PENDING" ? <><button className="button" onClick={() => void review(item, "CONFIRMED")}>{busyId === item.id ? "处理中…" : "确认关联"}</button><button className="button danger" onClick={() => void review(item, "REVOKED")}>撤销候选</button></> : <button className="button danger" onClick={() => void review(item, "REVOKED")}>{busyId === item.id ? "处理中…" : "撤销关联"}</button>}</div>
        </fieldset>}
        {canReview && item.evidence.length > 0 && <div className="notice" style={{ marginTop: 12 }}><strong>关系证据</strong>{item.evidence.map((evidence) => <div className="small" key={evidence.id}>{evidence.sourceUrl} · {evidence.fieldLocation} · 策略版本 {evidence.policyVersion} · {evidence.summary}</div>)}</div>}
        {item.history.length > 0 && <div className="small muted" style={{ marginTop: 12 }}>审核历史：{item.history.map((decision) => `${decision.fromStatus}→${decision.toStatus} (v${decision.version})`).join("；")}</div>}
      </article>)}
      {!loading && total > 0 && <div className="toolbar" style={{ marginTop: 16 }}><span className="muted small">第 {page} 页，共 {total} 条</span><div className="inline-actions"><button className="button secondary" disabled={page <= 1 || loading} onClick={() => setPage((value) => Math.max(value - 1, 1))}>上一页</button><button className="button secondary" disabled={page * 50 >= total || loading} onClick={() => setPage((value) => value + 1)}>下一页</button></div></div>}
    </section>
  </main>;
}
