"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";

type Contact = { id: string; type: string; value: string; status: string; version: number; usable: boolean; masked: boolean; expiresAt: string; reviewedAt: string | null;
  account: { id: string; displayName: string; isDemo: boolean }; source: { name: string; policyVersion: number; currentVersion: number };
  evidence: null | { sourceUrl: string; capturedAt: string; fieldLocation: string; excerpt: string };
  reviews: Array<{ id: string; status: string; createdAt: string; reviewer: string | null; reason: string | null }> };
const statuses: Record<string, string> = { PENDING: "待审核", APPROVED: "已通过", REJECTED: "已驳回", INVALID: "已失效" };
const types: Record<string, string> = { EMAIL: "商务邮箱", WECHAT: "商务微信", PHONE: "企业电话", CONTACT_URL: "官网联系页", BOOKING_URL: "预约链接" };

export function ContactsPanel({ account, canReview, canDelete = false, canExtract = false }: { account?: { id: string; displayName: string; sourceId: string }; canReview: boolean; canDelete?: boolean; canExtract?: boolean }) {
  const [items, setItems] = useState<Contact[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true); setError("");
    try {
      const params = new URLSearchParams({ status, page: String(page), ...(account ? { accountId: account.id } : {}) });
      const response = await fetch(`/api/contacts?${params}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "联系项加载失败");
      if (current === generation.current) { setItems(data.items); setTotal(data.total); }
    } catch (err) { if (current === generation.current) { setItems([]); setError(err instanceof Error ? err.message : "网络异常，请重试"); } }
    finally { if (current === generation.current) setLoading(false); }
  }, [account, status, page]);
  useEffect(() => {
    let active = true;
    queueMicrotask(() => { if (active) void load(); });
    return () => { active = false; };
  }, [load]);
  return <>
    {account && canExtract && <ExtractForm account={account} reload={load} />}
    {!canReview && <div className="notice">只读成员：联系值已脱敏，证据正文和审核原因不返回浏览器。</div>}
    <section className="card" style={{ marginTop: 20 }}>
      <div className="toolbar"><div className="field"><label htmlFor="contact-status">审核状态</label><select id="contact-status" value={status} disabled={loading} onChange={e => { setStatus(e.target.value); setPage(1); }}><option value="">全部</option>{Object.entries(statuses).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select></div><button className="button secondary" disabled={loading} onClick={() => void load()}>刷新联系项</button></div>
      {error ? <div className="notice error" role="alert">{error}</div> : loading ? <p role="status">加载中…</p> : <>
        {!items.length && <div className="empty">没有符合条件的联系项。缺失联系方式是合法结果。</div>}
        {items.map(item => <ContactCard key={`${item.id}:${item.version}`} item={item} canReview={canReview} canDelete={canDelete} reload={load} />)}
        <div className="pagination"><span>共 {total} 条 · 第 {page} 页</span><div className="inline-actions"><button className="button secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>上一页</button><button className="button secondary" disabled={page * 20 >= total} onClick={() => setPage(page + 1)}>下一页</button></div></div>
      </>}
    </section>
  </>;
}

function ExtractForm({ account, reload }: { account: { id: string; sourceId: string }; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/contacts/extract", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId: account.id, sourceId: account.sourceId, sourceUrl: data.get("sourceUrl"), capturedAt: new Date(String(data.get("capturedAt"))).toISOString(), fieldLocation: data.get("fieldLocation"), context: data.get("context"), text: data.get("text") }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "提取失败");
      setMessage(`${result.message}；新增 ${result.createdCount} 条，重复 ${result.duplicateCount} 条。`);
      form.reset(); await reload();
    } catch (err) { setError(err instanceof Error ? err.message : "网络异常；可安全重试，不会重复创建同版本候选"); }
    finally { setBusy(false); }
  }
  return <section className="card" style={{ marginTop: 20 }}><h2>从获准文本提取候选</h2>
    <p className="notice">演示数据限定：example.com/net/org 邮箱和链接、demo_ 开头微信、+1 202 555 01xx 电话。真实数据尚未开放。</p>
    <form onSubmit={submit}><fieldset disabled={busy} className="form-grid" style={{ border: 0, padding: 0 }}>
      <div className="field"><label htmlFor="evidence-url">本字段证据 HTTPS 地址</label><input id="evidence-url" name="sourceUrl" type="url" required maxLength={2048} /></div>
      <div className="field"><label htmlFor="captured-at">取得时间</label><input id="captured-at" name="capturedAt" type="datetime-local" required /></div>
      <div className="field"><label htmlFor="field-location">字段位置</label><input id="field-location" name="fieldLocation" required maxLength={180} placeholder="例如：账号简介的商务合作栏" /></div>
      <div className="field"><label htmlFor="text-context">文本位置类型</label><select id="text-context" name="context"><option value="ACCOUNT_PROFILE">账号主体资料</option><option value="COMMENT">评论</option><option value="ADVERTISEMENT">第三方广告</option><option value="THIRD_PARTY">第三人资料</option></select></div>
      <div className="field full"><label htmlFor="contact-text">获准处理的最小文本</label><textarea id="contact-text" name="text" maxLength={5000} placeholder="商务邮箱：business@example.com" /></div>
      <p className="muted small full">每行一个带明确标签的字段：商务邮箱、商务微信、企业电话、官网联系页、商务预约。缺少上下文或第三方内容不会推断归属。完整输入不入库。</p>
      <div className="form-actions full"><button className="button">{busy ? "处理中…" : "提取待审核候选"}</button></div>
    </fieldset></form>
    {error && <p className="notice error" role="alert">{error}</p>}{message && <p className="notice success" role="status">{message}</p>}
  </section>;
}

function ContactCard({ item, canReview, canDelete, reload }: { item: Contact; canReview: boolean; canDelete: boolean; reload: () => Promise<void> }) {
  const [ownership, setOwnership] = useState(false);
  const [business, setBusiness] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [suggestBusy, setSuggestBusy] = useState(false);
  const [error, setError] = useState("");
  async function review(status: string) {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/contacts/${item.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: item.version, status, ownershipConfirmed: ownership, businessConfirmed: business, reason }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "审核失败");
      await reload();
    } catch (err) { setError(err instanceof Error ? err.message : "网络异常，请刷新确认操作结果"); }
    finally { setBusy(false); }
  }
  async function suggestLinks() {
    if (suggestBusy || item.status !== "APPROVED" || item.masked) return;
    setSuggestBusy(true); setError("");
    try {
      const response = await fetch("/api/account-links/suggest", { method: "POST", headers: { "Content-Type": "application/json", Origin: window.location.origin }, body: JSON.stringify({ contactId: item.id }) });
      let data: { message?: string } = {};
      try { data = await response.json(); } catch { /* handled below */ }
      if (!response.ok) throw new Error(data.message ?? "生成关联候选失败");
      await reload();
    } catch (err) { setError(err instanceof Error ? err.message : "网络异常，未确认候选生成结果"); }
    finally { setSuggestBusy(false); }
  }
  async function suppress() {
    if (!window.confirm("确认拒绝后续联系？系统会立即阻止导出，并只保存带期限的最小化指纹。")) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/contacts/${item.id}/suppression`, { method: "POST", headers: { "Content-Type": "application/json", Origin: window.location.origin }, body: JSON.stringify({ reasonCode: "DO_NOT_CONTACT", basis: "人工确认拒绝后续联系" }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "拒绝联系处理失败");
      await reload();
    } catch (err) { setError(err instanceof Error ? err.message : "网络异常，请刷新确认结果"); }
    finally { setBusy(false); }
  }
  async function deleteContact() {
    if (!window.confirm("确认物理删除该联系项及对应证据？系统会保留有期限的最小化抑制指纹。")) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/deletion-requests", { method: "POST", headers: { "Content-Type": "application/json", Origin: window.location.origin }, body: JSON.stringify({ contactId: item.id, reason: "管理员确认删除联系项及其证据", confirm: true }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "删除失败");
      await reload();
    } catch (err) { setError(err instanceof Error ? err.message : "网络异常，请刷新确认结果"); }
    finally { setBusy(false); }
  }
  return <article className="card contact-card" data-contact-id={item.id} style={{ marginBottom: 16 }}>
    <div className="page-header"><div><h3>{types[item.type]} · {item.value}</h3><Link className="text-link" href={`/accounts/${item.account.id}/contacts`}>{item.account.displayName}</Link>{item.account.isDemo && <span className="badge warning">演示数据</span>}</div><div><span className="badge neutral">{statuses[item.status]}</span> <span className={`badge ${item.usable ? "success" : "warning"}`}>{item.usable ? "核验可用" : "当前不可用"}</span></div></div>
    <p className="small">来源：{item.source.name} · 证据策略 v{item.source.policyVersion} / 当前 v{item.source.currentVersion} · 有效至 {new Date(item.expiresAt).toLocaleString("zh-CN")}</p>
    {item.evidence ? <div className="notice"><a className="text-link" href={item.evidence.sourceUrl} target="_blank" rel="noopener noreferrer">主动打开字段证据 ↗</a><p>{item.evidence.fieldLocation} · 取得于 {new Date(item.evidence.capturedAt).toLocaleString("zh-CN")}</p><blockquote className="pre-wrap">{item.evidence.excerpt}</blockquote></div> : <p className="muted">原值与证据受权限、有效期或来源策略限制，已隐藏。</p>}
    {canReview && <fieldset disabled={busy || suggestBusy} style={{ border: 0, padding: 0 }}>
      <div className="inline-actions"><label><input type="checkbox" checked={ownership} onChange={e => setOwnership(e.target.checked)} />已核对联系项归属本账号/机构</label><label><input type="checkbox" checked={business} onChange={e => setBusiness(e.target.checked)} />已核对明确商务用途</label></div>
      <div className="field" style={{ marginTop: 12 }}><label htmlFor={`reason-${item.id}`}>审核原因（不得复制联系值）</label><textarea id={`reason-${item.id}`} value={reason} maxLength={500} onChange={e => setReason(e.target.value)} /></div>
      <div className="inline-actions" style={{ marginTop: 12 }}><button className="button" disabled={!ownership || !business || !reason.trim() || item.masked || item.status !== "PENDING"} onClick={() => void review("APPROVED")}>确认通过</button><button className="button secondary" disabled={!reason.trim()} onClick={() => void review("REJECTED")}>驳回</button><button className="button danger" disabled={!reason.trim()} onClick={() => void review("INVALID")}>标记失效</button></div>
      {item.status === "APPROVED" && <div className="inline-actions" style={{ marginTop: 12 }}><button className="button secondary" disabled={item.masked} onClick={() => void suggestLinks()}>{suggestBusy ? "生成中…" : "生成账号关联候选"}</button><span className="muted small">仅生成待人工核验候选，不会自动合并账号。</span></div>}
      <div className="inline-actions" style={{ marginTop: 12 }}><button className="button danger" disabled={busy} onClick={() => void suppress()}>拒绝后续联系</button>{canDelete ? <button className="button danger" disabled={busy} onClick={() => void deleteContact()}>删除联系项</button> : null}</div>
    </fieldset>}
    {error && <p className="notice error" role="alert">{error}</p>}
    <details><summary>审核历史（最近 30 条）</summary>{item.reviews.length ? item.reviews.map(r => <p key={r.id}>{statuses[r.status]} · {r.reviewer ?? "审核成员"} · {new Date(r.createdAt).toLocaleString("zh-CN")} {r.reason ?? ""}</p>) : <p className="muted">尚无人工审核记录。</p>}</details>
  </article>;
}
