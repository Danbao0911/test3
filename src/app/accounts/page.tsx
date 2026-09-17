"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const labels: Record<string, string> = { XIAOHONGSHU: "小红书", YOUTUBE: "YouTube", X: "X", DOUYIN: "抖音" };
type Source = { id: string; name: string; status: string; type: string };
type Account = { id: string; platform: string; displayName: string; organization: string | null; serviceTags: string[]; region: string | null; profileUrl: string; source: Source; createdAt: string; isDemo: boolean };

export default function AccountsPage() {
  const router = useRouter();
  const [items, setItems] = useState<Account[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [q, setQ] = useState(""); const [platform, setPlatform] = useState(""); const [serviceTag, setServiceTag] = useState(""); const [sourceId, setSourceId] = useState("");
  const [page, setPage] = useState(1); const [pageSize] = useState(20); const [total, setTotal] = useState(0); const [error, setError] = useState(""); const [loading, setLoading] = useState(true);
  const load = useCallback(async (nextPage = page) => {
    setLoading(true); setError("");
    const params = new URLSearchParams({ page: String(nextPage), pageSize: String(pageSize) });
    if (q.trim()) params.set("q", q.trim()); if (platform) params.set("platform", platform); if (serviceTag.trim()) params.set("serviceTag", serviceTag.trim()); if (sourceId) params.set("sourceId", sourceId);
    try {
      const response = await fetch(`/api/accounts?${params}`);
      if (response.status === 401) { router.push("/login"); return; }
      const data = await response.json(); if (!response.ok) throw new Error(data.message ?? "账号列表加载失败");
      setItems(data.items); setTotal(data.total); setPage(data.page);
    } catch (err) { setError(err instanceof Error ? err.message : "账号列表加载失败"); } finally { setLoading(false); }
  }, [page, pageSize, platform, q, router, serviceTag, sourceId]);
  useEffect(() => { queueMicrotask(() => { void load(1); }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { fetch("/api/sources").then(async (response) => { if (response.ok) { const data = await response.json(); setSources(data.items); } }); }, []);
  function submit(event: FormEvent) { event.preventDefault(); void load(1); }
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <main className="page">
      <div className="page-header"><div><h1 className="page-title">账号库</h1><p className="page-subtitle">搜索已入库账号；本页面不执行全平台搜索。</p></div><Link className="button" href="/accounts/new">添加账号</Link></div>
      <form className="card toolbar" onSubmit={submit}>
        <div className="field wide"><label htmlFor="q">搜索已入库账号</label><input id="q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="账号名或机构" /></div>
        <div className="field"><label htmlFor="platform">平台</label><select id="platform" value={platform} onChange={(e) => setPlatform(e.target.value)}><option value="">全部平台</option>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
        <div className="field"><label htmlFor="tag">服务标签</label><input id="tag" value={serviceTag} onChange={(e) => setServiceTag(e.target.value)} placeholder="例如：财富规划" /></div>
        <div className="field"><label htmlFor="source">数据来源</label><select id="source" value={sourceId} onChange={(e) => setSourceId(e.target.value)}><option value="">全部来源</option>{sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}</select></div>
        <button className="button secondary" type="submit">筛选</button>
      </form>
      {error ? <div className="notice error">{error}</div> : null}
      <section className="card">
        {loading ? <div className="empty">正在加载账号…</div> : items.length === 0 ? <div className="empty">暂无符合条件的已入库账号。</div> : <div className="table-wrap"><table><thead><tr><th>平台</th><th>账号名</th><th>机构</th><th>服务标签</th><th>服务地区</th><th>来源</th><th>录入时间</th></tr></thead><tbody>{items.map((account) => <tr key={account.id}><td>{labels[account.platform] ?? account.platform}</td><td><Link className="text-link" href={`/accounts/${account.id}`}>{account.displayName}</Link>{account.isDemo ? <span className="badge warning" style={{ marginLeft: 7 }}>演示数据</span> : null}</td><td>{account.organization || "—"}</td><td><div className="tag-list">{account.serviceTags.map((tag) => <span className="tag" key={tag}>{tag}</span>)}</div></td><td>{account.region || "—"}</td><td><span className={`badge ${account.source.status === "APPROVED" ? "success" : "warning"}`}>{account.source.name}</span></td><td className="muted">{new Date(account.createdAt).toLocaleString("zh-CN")}</td></tr>)}</tbody></table></div>}
        {!loading && total > 0 ? <div className="pagination"><span>共 {total} 条，第 {page} / {pages} 页</span><div className="inline-actions"><button className="button secondary" disabled={page <= 1} onClick={() => void load(page - 1)}>上一页</button><button className="button secondary" disabled={page >= pages} onClick={() => void load(page + 1)}>下一页</button></div></div> : null}
      </section>
    </main>
  );
}
