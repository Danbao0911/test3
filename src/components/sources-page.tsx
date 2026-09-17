"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Source = { id: string; name: string; type: string; status: string; permissionNote: string; allowImport: boolean; allowExtract: boolean; allowEvidenceText: boolean; retentionDays: number; policyVersion: number; expiresAt: string | null };

export default function SourcesClientPage({ canManage, synthetic }: { canManage: boolean; synthetic: boolean }) {
  const router = useRouter();
  const [items, setItems] = useState<Source[]>([]);
  const [name, setName] = useState("");
  const [permissionNote, setPermissionNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const type = synthetic ? "DEMO" : "AUTHORIZED_MANUAL";
  const load = useCallback(async () => {
    const response = await fetch("/api/sources");
    if (response.status === 401) { router.push("/login"); return; }
    if (!response.ok) throw new Error("来源列表加载失败");
    setItems((await response.json()).items);
  }, [router]);
  useEffect(() => { queueMicrotask(() => { void load().catch(() => setError("来源列表加载失败，请重试")); }); }, [load]);
  async function write(url: string, method: string, body: unknown) {
    setError(""); setBusy(true);
    try {
      const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "来源更新失败");
      await load();
      return true;
    } catch (err) { setError(err instanceof Error ? err.message : "网络异常，请重试"); return false; }
    finally { setBusy(false); }
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    if (await write("/api/sources", "POST", { name, type, permissionNote })) { setName(""); setPermissionNote(""); }
  }
  return <main className="page">
    <div className="page-header"><div><h1 className="page-title">数据来源</h1><p className="page-subtitle">录入、联系提取、证据保留分别授权；策略变更后需按新证据重新核验。管理员登记不代表平台认证。</p></div></div>
    {error && <div className="notice error" role="alert">{error}</div>}
    {canManage ? <section className="card" style={{ marginBottom: 18 }}><h2>登记新来源</h2><form className="form-grid" onSubmit={create}>
      <div className="field"><label htmlFor="name">来源名称</label><input id="name" value={name} onChange={e => setName(e.target.value)} maxLength={160} required disabled={busy} /></div>
      <div className="field"><label htmlFor="type">来源类型</label><select id="type" value={type} disabled><option value={type}>{synthetic ? "演示来源" : "经授权人工来源"}</option></select></div>
      <div className="field full"><label htmlFor="permissionNote">允许录入依据说明</label><textarea id="permissionNote" value={permissionNote} onChange={e => setPermissionNote(e.target.value)} maxLength={2000} disabled={busy} /></div>
      <div className="form-actions full"><button className="button" disabled={busy}>创建 DRAFT 来源</button></div>
    </form></section> : <p className="notice">当前角色可查看来源；仅管理员可修改策略。</p>}
    <section className="card"><div className="table-wrap"><table><thead><tr><th>名称 / 版本</th><th>状态 / 到期</th><th>依据</th><th>允许能力</th><th>操作</th></tr></thead><tbody>
      {items.map(source => <SourceRow key={source.id} source={source} canManage={canManage} busy={busy} save={patch => write(`/api/sources/${source.id}`, "PATCH", patch)} />)}
      {!items.length && <tr><td colSpan={5} className="empty">暂无来源。</td></tr>}
    </tbody></table></div></section>
  </main>;
}

function SourceRow({ source, canManage, busy, save }: { source: Source; canManage: boolean; busy: boolean; save: (patch: unknown) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(source.permissionNote);
  const [expiry, setExpiry] = useState(source.expiresAt ?? "");
  const [extract, setExtract] = useState(source.allowExtract);
  const [evidence, setEvidence] = useState(source.allowEvidenceText);
  const [days, setDays] = useState(source.retentionDays);
  const expired = source.expiresAt && new Date(source.expiresAt) <= new Date();
  return <tr data-source-id={source.id}>
    <td>{source.name}<p className="muted small">策略 v{source.policyVersion}</p></td>
    <td>{source.status}{expired ? " · 已到期" : ""}<p className="small">{source.expiresAt ?? "来源未设到期时间"}</p></td>
    <td className="pre-wrap" style={{ maxWidth: 360 }}>{source.permissionNote || "未填写"}</td>
    <td>录入：{source.allowImport ? "允许" : "关闭"}<br />联系提取：{source.allowExtract ? "允许" : "关闭"}<br />证据文本：{source.allowEvidenceText ? "允许" : "关闭"}<br />联系有效期：{source.retentionDays} 天</td>
    <td>{canManage && <div className="inline-actions">
      {source.status !== "APPROVED" && <button className="button" disabled={busy} onClick={() => void save({ status: "APPROVED", allowImport: true })}>批准录入</button>}
      <button className="button secondary" disabled={busy} onClick={() => { setNote(source.permissionNote); setExpiry(source.expiresAt ?? ""); setExtract(source.allowExtract); setEvidence(source.allowEvidenceText); setDays(source.retentionDays); setEditing(!editing); }}>编辑策略</button>
      {source.status === "APPROVED" && <button className="button danger" disabled={busy} onClick={() => void save({ status: "REVOKED" })}>撤销</button>}
      {editing && <form className="field" onSubmit={async e => { e.preventDefault(); if (await save({ permissionNote: note, expiresAt: expiry || null, allowExtract: extract, allowEvidenceText: evidence, retentionDays: days })) setEditing(false); }}>
        <label>处理依据<textarea aria-label="处理依据" value={note} onChange={e => setNote(e.target.value)} required maxLength={2000} disabled={busy} /></label>
        <label>到期时间（ISO 格式）<input aria-label="到期时间" value={expiry} onChange={e => setExpiry(e.target.value)} placeholder="2026-12-31T00:00:00Z" disabled={busy} /></label>
        <label><input type="checkbox" checked={extract} onChange={e => setExtract(e.target.checked)} disabled={busy} />允许联系提取</label>
        <label><input type="checkbox" checked={evidence} onChange={e => setEvidence(e.target.checked)} disabled={busy} />允许保留最小证据文本</label>
        <label>联系有效天数<input type="number" min={1} max={365} value={days} onChange={e => setDays(Number(e.target.value))} disabled={busy} /></label>
        <p className="small muted">保存会使旧版本联系项暂不可用，需重新提取和审核。尚无物理到期清理任务，请勿上线真实数据。</p>
        <button className="button" disabled={busy}>保存策略</button>
      </form>}
    </div>}</td>
  </tr>;
}
