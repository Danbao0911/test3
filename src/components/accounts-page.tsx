"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const labels: Record<string, string> = { XIAOHONGSHU: "小红书", YOUTUBE: "YouTube", X: "X", DOUYIN: "抖音" };
const followUpLabels: Record<string, string> = { NOT_CONTACTED: "未联系", CONTACTING: "人工联系中", REPLIED: "已回复", NOT_MATCH: "不匹配", DO_NOT_CONTACT: "不再联系" };
type Source = { id: string; name: string; status: string; type: string };
type Account = { id: string; platform: string; displayName: string; organization: string | null; serviceTags: string[]; region: string | null; profileUrl: string; source: Source; createdAt: string; isDemo: boolean; owner: { id: string; email: string; role: string } | null; favorite: boolean; followUp: { status: string; note: string }; reviewStatus: string | null; hasUsableContact: boolean };

export default function AccountsClientPage({ canManage }: { canManage: boolean }) {
  const router = useRouter();
  const [items, setItems] = useState<Account[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [q, setQ] = useState(""); const [platform, setPlatform] = useState(""); const [serviceTag, setServiceTag] = useState(""); const [sourceId, setSourceId] = useState(""); const [reviewStatus, setReviewStatus] = useState(""); const [hasContact, setHasContact] = useState(""); const [followUpStatus, setFollowUpStatus] = useState(""); const [favorite, setFavorite] = useState("");
  const [page, setPage] = useState(1); const [pageSize] = useState(20); const [total, setTotal] = useState(0); const [error, setError] = useState(""); const [loading, setLoading] = useState(true);
  const load = useCallback(async (nextPage = page) => {
    setLoading(true); setError("");
    const params = new URLSearchParams({ page: String(nextPage), pageSize: String(pageSize) });
    if (q.trim()) params.set("q", q.trim()); if (platform) params.set("platform", platform); if (serviceTag.trim()) params.set("serviceTag", serviceTag.trim()); if (sourceId) params.set("sourceId", sourceId); if (reviewStatus) params.set("contactStatus", reviewStatus); if (hasContact) params.set("hasContact", hasContact); if (followUpStatus) params.set("followUpStatus", followUpStatus); if (favorite) params.set("favorite", favorite);
    try {
      const response = await fetch(`/api/accounts?${params}`);
      if (response.status === 401) { router.push("/login"); return; }
      const data = await response.json(); if (!response.ok) throw new Error(data.message ?? "账号列表加载失败");
      setItems(data.items); setTotal(data.total); setPage(data.page);
    } catch (err) { setError(err instanceof Error ? err.message : "账号列表加载失败"); } finally { setLoading(false); }
  }, [favorite, followUpStatus, hasContact, page, pageSize, platform, q, reviewStatus, router, serviceTag, sourceId]);
  useEffect(() => { queueMicrotask(() => { void load(1); }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { fetch("/api/sources").then(async (response) => { if (response.status === 401) { router.push("/login"); return; } if (response.ok) { const data = await response.json(); setSources(data.items); } else { setError("来源列表加载失败，请稍后重试"); } }).catch(() => setError("来源列表加载失败，请检查网络连接")); }, [router]);
  function submit(event: FormEvent) { event.preventDefault(); void load(1); }
  async function toggleFavorite(account: Account) {
    const response = await fetch(`/api/accounts/${account.id}/favorite`, { method: account.favorite ? "DELETE" : "POST", headers: { Origin: window.location.origin } });
    if (!response.ok) { const data = await response.json().catch(() => ({})); setError(data.message ?? "收藏状态更新失败"); return; }
    setItems((current) => current.map((item) => item.id === account.id ? { ...item, favorite: !account.favorite } : item));
  }
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <main className="page">
      <div className="page-header"><div><h1 className="page-title">账号库</h1><p className="page-subtitle">搜索已入库账号；本页面不执行全平台搜索。跟进状态仅记录人工行为，不代表系统已发出邮件或私信。</p></div><Link className="button" href="/accounts/new">添加账号</Link></div>
      <form className="card toolbar" onSubmit={submit}>
        <div className="field wide"><label htmlFor="q">搜索已入库账号</label><input id="q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="账号名或机构" /></div>
        <div className="field"><label htmlFor="platform">平台</label><select id="platform" value={platform} onChange={(e) => setPlatform(e.target.value)}><option value="">全部平台</option>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
        <div className="field"><label htmlFor="tag">服务标签</label><input id="tag" value={serviceTag} onChange={(e) => setServiceTag(e.target.value)} placeholder="例如：财富规划" /></div>
        <div className="field"><label htmlFor="source">数据来源</label><select id="source" value={sourceId} onChange={(e) => setSourceId(e.target.value)}><option value="">全部来源</option>{sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}</select></div>
        <div className="field"><label htmlFor="reviewStatus">联系审核状态</label><select id="reviewStatus" value={reviewStatus} onChange={(e) => setReviewStatus(e.target.value)}><option value="">全部审核状态</option><option value="PENDING">待审核</option><option value="APPROVED">已通过</option><option value="REJECTED">已驳回</option><option value="INVALID">已失效</option></select></div>
        <div className="field"><label htmlFor="hasContact">有无可用联系方式</label><select id="hasContact" value={hasContact} onChange={(e) => setHasContact(e.target.value)}><option value="">全部</option><option value="YES">有可用联系方式</option><option value="NO">无可用联系方式</option></select></div>
        <div className="field"><label htmlFor="followUpStatus">跟进状态</label><select id="followUpStatus" value={followUpStatus} onChange={(e) => setFollowUpStatus(e.target.value)}><option value="">全部跟进状态</option>{Object.entries(followUpLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
        <div className="field"><label htmlFor="favorite">收藏</label><select id="favorite" value={favorite} onChange={(e) => setFavorite(e.target.value)}><option value="">全部账号</option><option value="YES">我收藏的</option><option value="NO">未收藏</option></select></div>
        <button className="button secondary" type="submit">筛选</button>
      </form>
      {error ? <div className="notice error" role="alert">{error}</div> : null}
      <section className="card">
        {loading ? <div className="empty">正在加载账号…</div> : items.length === 0 ? <div className="empty">暂无符合条件的已入库账号。</div> : <div className="table-wrap"><table><thead><tr><th>平台</th><th>账号名</th><th>机构</th><th>服务标签</th><th>审核 / 联系</th><th>负责人</th><th>跟进</th><th>来源</th><th>操作</th></tr></thead><tbody>{items.map((account) => <tr key={account.id}><td>{labels[account.platform] ?? account.platform}</td><td><Link className="text-link" href={`/accounts/${account.id}`}>{account.displayName}</Link>{account.isDemo ? <span className="badge warning" style={{ marginLeft: 7 }}>演示数据</span> : null}</td><td>{account.organization || "—"}</td><td><div className="tag-list">{account.serviceTags.map((tag) => <span className="tag" key={tag}>{tag}</span>)}</div><div className="muted small" style={{ marginTop: 5 }}>{account.region || "未填写地区"}</div></td><td><div>{account.reviewStatus === "APPROVED" ? "已通过" : account.reviewStatus === "PENDING" ? "待审核" : account.reviewStatus === "REJECTED" ? "已驳回" : account.reviewStatus === "INVALID" ? "已失效" : "无联系项"}</div><span className={`badge ${account.hasUsableContact ? "success" : "neutral"}`}>{account.hasUsableContact ? "有可用联系方式" : "暂无可用"}</span></td><td>{account.owner?.email ?? "未分配"}</td><td><span className="badge neutral">{followUpLabels[account.followUp.status] ?? account.followUp.status}</span>{account.followUp.note ? <div className="muted small pre-wrap" style={{ marginTop: 5 }}>{account.followUp.note}</div> : null}</td><td><span className={`badge ${account.source.status === "APPROVED" ? "success" : "warning"}`}>{account.source.name}</span></td><td>{canManage ? <button className="button secondary" type="button" onClick={() => void toggleFavorite(account)}>{account.favorite ? "取消收藏" : "收藏"}</button> : <span className="muted small">{account.favorite ? "已收藏" : "未收藏"}</span>}</td></tr>)}</tbody></table></div>}
        {!loading && total > 0 ? <div className="pagination"><span>共 {total} 条，第 {page} / {pages} 页</span><div className="inline-actions"><button className="button secondary" disabled={page <= 1} onClick={() => void load(page - 1)}>上一页</button><button className="button secondary" disabled={page >= pages} onClick={() => void load(page + 1)}>下一页</button></div></div> : null}
      </section>
    </main>
  );
}
