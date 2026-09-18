"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const labels: Record<string, string> = { XIAOHONGSHU: "小红书", YOUTUBE: "YouTube", X: "X", DOUYIN: "抖音" };
const followUpLabels: Record<string, string> = { NOT_CONTACTED: "未联系", CONTACTING: "人工联系中", REPLIED: "已回复", NOT_MATCH: "不匹配", DO_NOT_CONTACT: "不再联系" };
type Account = {
  id: string;
  platform: string;
  nativeId: string | null;
  displayName: string;
  profileUrl: string;
  normalizedProfileUrl: string;
  organization: string | null;
  serviceTags: string[];
  region: string | null;
  sourceId: string;
  sourceUrl: string;
  capturedAt: string;
  createdAt: string;
  updatedAt: string;
  isDemo: boolean;
  workspaceVersion: number;
  favorite: boolean;
  owner: { id: string; email: string; role: string } | null;
  followUp: { status: string; note: string | null; noteMasked: boolean; updatedAt: string | null };
  reviewStatus: string | null;
  hasUsableContact: boolean;
  source: { id: string; name: string; type: string; status: string; allowImport: boolean; expiresAt: string | null };
};
type User = { id: string; email: string; role: string };

async function responseData(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

function messageOf(data: Record<string, unknown>, fallback: string) {
  return typeof data.message === "string" ? data.message : fallback;
}

export function AccountDetail({ id, canEdit }: { id: string; canEdit: boolean }) {
  const router = useRouter();
  const [account, setAccount] = useState<Account | null>(null);
  const [form, setForm] = useState({ displayName: "", organization: "", serviceTags: "", region: "" });
  const [workspaceForm, setWorkspaceForm] = useState({ ownerId: "", status: "NOT_CONTACTED", note: "", confirmReactivation: false });
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [workspaceSaved, setWorkspaceSaved] = useState(false);
  const [favoriteBusy, setFavoriteBusy] = useState(false);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);

  const loadAccount = useCallback(async () => {
    const response = await fetch(`/api/accounts/${id}`);
    if (response.status === 401) { router.push("/login"); return; }
    const data = await responseData(response);
    if (!response.ok) { setError(messageOf(data, "账号加载失败")); return; }
    const item = data.item as Account;
    setAccount(item);
    setForm({ displayName: item.displayName, organization: item.organization ?? "", serviceTags: item.serviceTags.join("|"), region: item.region ?? "" });
    setWorkspaceForm({ ownerId: item.owner?.id ?? "", status: item.followUp.status, note: item.followUp.note ?? "", confirmReactivation: false });
  }, [id, router]);

  useEffect(() => { queueMicrotask(() => { void loadAccount(); }); }, [loadAccount]);
  useEffect(() => {
    if (!canEdit) return;
    void fetch("/api/users").then(async (response) => {
      if (response.status === 401) { router.push("/login"); return; }
      if (response.ok) setUsers(((await responseData(response)).items ?? []) as User[]);
    });
  }, [canEdit, router]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setError(""); setSaved(false); setProfileBusy(true);
    try {
      const response = await fetch(`/api/accounts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Origin: window.location.origin },
        body: JSON.stringify({ displayName: form.displayName, organization: form.organization || null, serviceTags: form.serviceTags.split("|").map((tag) => tag.trim()).filter(Boolean), region: form.region || null }),
      });
      const data = await responseData(response);
      if (!response.ok) { setError(messageOf(data, "保存失败")); return; }
      setAccount(data.item as Account); setSaved(true);
    } catch { setError("保存失败，请检查网络连接"); }
    finally { setProfileBusy(false); }
  }

  async function toggleFavorite() {
    if (!account || favoriteBusy) return;
    setError(""); setFavoriteBusy(true);
    try {
      const response = await fetch(`/api/accounts/${id}/favorite`, { method: account.favorite ? "DELETE" : "POST", headers: { Origin: window.location.origin } });
      const data = await responseData(response);
      if (!response.ok) { setError(messageOf(data, "收藏状态更新失败")); return; }
      setAccount((current) => current ? { ...current, favorite: Boolean(data.favorite) } : current);
    } catch { setError("收藏状态更新失败，请检查网络连接"); }
    finally { setFavoriteBusy(false); }
  }

  function changeFollowUpStatus(status: string) {
    if (account?.followUp.status === "DO_NOT_CONTACT" && status !== "DO_NOT_CONTACT") {
      if (!window.confirm("从‘不再联系’恢复前，需要明确二次确认并填写恢复理由。继续吗？")) return;
      setWorkspaceForm((current) => ({ ...current, status, confirmReactivation: true }));
      return;
    }
    setWorkspaceForm((current) => ({ ...current, status, confirmReactivation: false }));
  }

  async function saveWorkspace(event: FormEvent) {
    event.preventDefault();
    if (!account || workspaceBusy) return;
    setError(""); setWorkspaceSaved(false); setWorkspaceBusy(true);
    try {
      const response = await fetch(`/api/accounts/${id}/workspace`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Origin: window.location.origin },
        body: JSON.stringify({
          expectedWorkspaceVersion: account.workspaceVersion,
          ownerId: workspaceForm.ownerId || null,
          followUp: { status: workspaceForm.status, note: workspaceForm.note, ...(workspaceForm.confirmReactivation ? { confirmReactivation: true } : {}) },
        }),
      });
      const data = await responseData(response);
      if (!response.ok) {
        setError(response.status === 409 ? "工作台已被其他用户更新，请刷新后重新核对；当前草稿已保留。" : messageOf(data, "工作台保存失败"));
        return;
      }
      const item = data.item as Account;
      setAccount(item);
      setWorkspaceForm({ ownerId: item.owner?.id ?? "", status: item.followUp.status, note: item.followUp.note ?? "", confirmReactivation: false });
      setWorkspaceSaved(true);
    } catch { setError("工作台保存失败，请检查网络连接；当前草稿已保留"); }
    finally { setWorkspaceBusy(false); }
  }

  if (error && !account) return <main className="page"><div className="notice error" role="alert">{error}</div><Link className="text-link" href="/accounts">返回账号库</Link></main>;
  if (!account) return <main className="page"><div className="empty">正在加载账号…</div></main>;

  return <main className="page">
    <div className="page-header"><div><h1 className="page-title">{account.displayName}</h1><p className="page-subtitle">账号详情 · {labels[account.platform] ?? account.platform}{account.isDemo ? " · 演示数据" : ""}</p></div><div className="inline-actions"><Link className="button" href={`/accounts/${id}/contacts`}>商务联系与证据</Link><Link className="button secondary" href="/accounts">返回账号库</Link></div></div>
    {error ? <div className="notice error" role="alert">{error}</div> : null}
    <section className="card" style={{ marginBottom: 18 }}><dl className="detail-grid">
      <div className="detail-item"><dt>平台账号 ID</dt><dd>{account.nativeId || "未提供"}</dd></div>
      <div className="detail-item"><dt>数据来源</dt><dd>{account.source.name} <span className={`badge ${account.source.status === "APPROVED" ? "success" : "warning"}`}>{account.source.status}</span></dd></div>
      <div className="detail-item"><dt>主页链接</dt><dd><a className="text-link" href={account.profileUrl} target="_blank" rel="noreferrer noopener">主动打开主页 ↗</a></dd></div>
      <div className="detail-item"><dt>来源证据链接</dt><dd><a className="text-link" href={account.sourceUrl} target="_blank" rel="noreferrer noopener">主动打开来源 ↗</a></dd></div>
      <div className="detail-item"><dt>服务标签</dt><dd><div className="tag-list">{account.serviceTags.length ? account.serviceTags.map((tag) => <span className="tag" key={tag}>{tag}</span>) : "未填写"}</div></dd></div>
      <div className="detail-item"><dt>公开服务地区</dt><dd>{account.region || "未填写"}</dd></div>
      <div className="detail-item"><dt>联系方式</dt><dd>{account.hasUsableContact ? <span className="badge success">有当前可用联系方式</span> : "暂无当前可用联系方式"}</dd></div>
      <div className="detail-item"><dt>录入时间</dt><dd>{new Date(account.createdAt).toLocaleString("zh-CN")}</dd></div>
      <div className="detail-item"><dt>捕获时间</dt><dd>{new Date(account.capturedAt).toLocaleString("zh-CN")}</dd></div>
    </dl></section>
    <section className="card" style={{ marginBottom: 18 }}><div className="page-header" style={{ marginBottom: 12 }}><div><h2 style={{ margin: 0, fontSize: 18 }}>收藏与人工跟进</h2><p className="muted small">跟进状态只记录人工行为，不代表系统已经发出邮件或私信。</p></div>{canEdit ? <button className="button secondary" type="button" disabled={favoriteBusy} onClick={() => void toggleFavorite()}>{favoriteBusy ? "保存中…" : account.favorite ? "取消收藏" : "收藏账号"}</button> : <span className="badge neutral">{account.favorite ? "已收藏" : "未收藏"}</span>}</div>
      <form className="form-grid" onSubmit={saveWorkspace}>
        <div className="field"><label htmlFor="owner">负责人</label>{canEdit ? <select id="owner" value={workspaceForm.ownerId} disabled={workspaceBusy} onChange={(e) => setWorkspaceForm({ ...workspaceForm, ownerId: e.target.value })}><option value="">未分配</option>{users.map((item) => <option key={item.id} value={item.id}>{item.email} · {item.role}</option>)}</select> : <div className="detail-item">{account.owner?.email ?? "未分配"}</div>}</div>
        <div className="field"><label htmlFor="followUpStatus">跟进状态</label>{canEdit ? <select id="followUpStatus" value={workspaceForm.status} disabled={workspaceBusy} onChange={(e) => changeFollowUpStatus(e.target.value)}>{Object.entries(followUpLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select> : <div className="detail-item">{followUpLabels[account.followUp.status] ?? account.followUp.status}</div>}</div>
        <div className="field full"><label htmlFor="followUpNote">跟进备注</label>{canEdit ? <textarea id="followUpNote" maxLength={1000} disabled={workspaceBusy} value={workspaceForm.note} onChange={(e) => setWorkspaceForm({ ...workspaceForm, note: e.target.value })} placeholder="仅记录人工跟进事实和下一步，不填写密码或完整联系人原文" /> : account.followUp.noteMasked ? <div className="detail-item muted">备注受权限限制</div> : <div className="detail-item pre-wrap">{account.followUp.note || "暂无备注"}</div>}</div>
        {canEdit && <><div className="muted small full">当前版本：{account.workspaceVersion} · 当前状态：{followUpLabels[workspaceForm.status] ?? workspaceForm.status}</div>{workspaceSaved ? <div className="notice success full">收藏、负责人和跟进状态已保存。</div> : null}<div className="form-actions full"><button className="button" disabled={workspaceBusy}>{workspaceBusy ? "保存中…" : "保存工作台状态"}</button></div></>}
      </form>
    </section>
    {canEdit ? <section className="card"><h2 style={{ marginTop: 0, fontSize: 18 }}>维护业务资料</h2><p className="muted small">本轮只允许修改展示资料，不允许通过编辑更换平台身份或数据来源。</p><form className="form-grid" onSubmit={save}><div className="field"><label htmlFor="displayName">账号名称</label><input id="displayName" value={form.displayName} disabled={profileBusy} onChange={(e) => setForm({ ...form, displayName: e.target.value })} required /></div><div className="field"><label htmlFor="organization">机构</label><input id="organization" value={form.organization} disabled={profileBusy} onChange={(e) => setForm({ ...form, organization: e.target.value })} /></div><div className="field"><label htmlFor="serviceTags">服务标签（用 | 分隔）</label><input id="serviceTags" value={form.serviceTags} disabled={profileBusy} onChange={(e) => setForm({ ...form, serviceTags: e.target.value })} /></div><div className="field"><label htmlFor="region">公开服务地区</label><input id="region" value={form.region} disabled={profileBusy} onChange={(e) => setForm({ ...form, region: e.target.value })} /></div>{saved ? <div className="notice success full">已保存。</div> : null}<div className="form-actions full"><button className="button" disabled={profileBusy}>{profileBusy ? "保存中…" : "保存资料"}</button></div></form></section> : <div className="notice">只读成员不能维护资料。</div>}
  </main>;
}
