"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

const labels: Record<string, string> = { XIAOHONGSHU: "小红书", YOUTUBE: "YouTube", X: "X", DOUYIN: "抖音" };
const followUpLabels: Record<string, string> = { NOT_CONTACTED: "未联系", CONTACTING: "人工联系中", REPLIED: "已回复", NOT_MATCH: "不匹配", DO_NOT_CONTACT: "不再联系" };
type Source = { id: string; name: string; status: string; type: string };
type Account = { id: string; platform: string; displayName: string; organization: string | null; serviceTags: string[]; region: string | null; profileUrl: string; source: Source; createdAt: string; isDemo: boolean; owner: { id: string; email: string; role: string } | null; favorite: boolean; followUp: { status: string; note: string | null; noteMasked: boolean }; reviewStatus: string | null; hasUsableContact: boolean };
type Filters = { q: string; platform: string; serviceTag: string; sourceId: string; reviewStatus: string; hasContact: string; followUpStatus: string; favorite: string };
const emptyFilters: Filters = { q: "", platform: "", serviceTag: "", sourceId: "", reviewStatus: "", hasContact: "", followUpStatus: "", favorite: "" };

async function responseData(response: Response): Promise<Record<string, unknown>> {
  try { return await response.json() as Record<string, unknown>; } catch { return {}; }
}

export default function AccountsClientPage({ canManage }: { canManage: boolean }) {
  const router = useRouter();
  const [items, setItems] = useState<Account[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [draft, setDraft] = useState<Filters>(emptyFilters);
  const [applied, setApplied] = useState<Filters>(emptyFilters);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [favoriteBusy, setFavoriteBusy] = useState<Record<string, boolean>>({});
  const requestNumber = useRef(0);
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(async (filters: Filters, nextPage: number) => {
    controller.current?.abort();
    const requestId = ++requestNumber.current;
    const nextController = new AbortController();
    controller.current = nextController;
    setLoading(true); setError("");
    try {
      let requestedPage = nextPage;
      while (true) {
        const params = new URLSearchParams({ page: String(requestedPage), pageSize: String(pageSize) });
        if (filters.q.trim()) params.set("q", filters.q.trim());
        if (filters.platform) params.set("platform", filters.platform);
        if (filters.serviceTag.trim()) params.set("serviceTag", filters.serviceTag.trim());
        if (filters.sourceId) params.set("sourceId", filters.sourceId);
        if (filters.reviewStatus) params.set("contactStatus", filters.reviewStatus);
        if (filters.hasContact) params.set("hasContact", filters.hasContact);
        if (filters.followUpStatus) params.set("followUpStatus", filters.followUpStatus);
        if (filters.favorite) params.set("favorite", filters.favorite);
        const response = await fetch(`/api/accounts?${params}`, { signal: nextController.signal });
        if (response.status === 401) { router.push("/login"); return; }
        const data = await responseData(response);
        if (!response.ok) throw new Error(typeof data.message === "string" ? data.message : "账号列表加载失败");
        const responseItems = (data.items ?? []) as Account[];
        const responseTotal = typeof data.total === "number" ? data.total : 0;
        const lastPage = Math.max(1, Math.ceil(responseTotal / pageSize));
        if (requestId !== requestNumber.current) return;
        if (responseItems.length === 0 && responseTotal > 0 && requestedPage > lastPage) {
          requestedPage = lastPage;
          continue;
        }
        setItems(responseItems); setTotal(responseTotal); setPage(requestedPage);
        break;
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (requestId === requestNumber.current) setError(err instanceof Error ? err.message : "账号列表加载失败");
    } finally {
      if (requestId === requestNumber.current) setLoading(false);
    }
  }, [pageSize, router]);

  useEffect(() => { queueMicrotask(() => { void load(emptyFilters, 1); }); return () => controller.current?.abort(); }, [load]);
  useEffect(() => {
    void fetch("/api/sources").then(async (response) => {
      if (response.status === 401) { router.push("/login"); return; }
      if (response.ok) setSources(((await responseData(response)).items ?? []) as Source[]);
      else setError("来源列表加载失败，请稍后重试");
    }).catch(() => setError("来源列表加载失败，请检查网络连接"));
  }, [router]);

  function updateDraft(key: keyof Filters, value: string) { setDraft((current) => ({ ...current, [key]: value })); }
  function submit(event: FormEvent) { event.preventDefault(); const next = { ...draft }; setApplied(next); void load(next, 1); }

  async function toggleFavorite(account: Account) {
    if (favoriteBusy[account.id]) return;
    setFavoriteBusy((current) => ({ ...current, [account.id]: true })); setError("");
    try {
      const response = await fetch(`/api/accounts/${account.id}/favorite`, { method: account.favorite ? "DELETE" : "POST", headers: { Origin: window.location.origin } });
      const data = await responseData(response);
      if (!response.ok) { setError(typeof data.message === "string" ? data.message : "收藏状态更新失败"); return; }
      const nextFavorite = Boolean(data.favorite);
      if (applied.favorite === "YES" || applied.favorite === "NO") await load(applied, page);
      else setItems((current) => current.map((item) => item.id === account.id ? { ...item, favorite: nextFavorite } : item));
    } catch { setError("收藏状态更新失败，请检查网络连接"); }
    finally { setFavoriteBusy((current) => { const next = { ...current }; delete next[account.id]; return next; }); }
  }

  const pages = Math.max(1, Math.ceil(total / pageSize));
  return <main className="page">
    <div className="page-header"><div><h1 className="page-title">账号库</h1><p className="page-subtitle">搜索已入库账号；本页面不执行全平台搜索。跟进状态仅记录人工行为，不代表系统已发出邮件或私信。</p></div><Link className="button" href="/accounts/new">添加账号</Link></div>
    <form className="card toolbar" onSubmit={submit}>
      <div className="field wide"><label htmlFor="q">搜索已入库账号</label><input id="q" value={draft.q} onChange={(e) => updateDraft("q", e.target.value)} placeholder="账号名或机构" /></div>
      <div className="field"><label htmlFor="platform">平台</label><select id="platform" value={draft.platform} onChange={(e) => updateDraft("platform", e.target.value)}><option value="">全部平台</option>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
      <div className="field"><label htmlFor="tag">服务标签</label><input id="tag" value={draft.serviceTag} onChange={(e) => updateDraft("serviceTag", e.target.value)} placeholder="例如：财富规划" /></div>
      <div className="field"><label htmlFor="source">数据来源</label><select id="source" value={draft.sourceId} onChange={(e) => updateDraft("sourceId", e.target.value)}><option value="">全部来源</option>{sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}</select></div>
      <div className="field"><label htmlFor="reviewStatus">联系审核状态</label><select id="reviewStatus" value={draft.reviewStatus} onChange={(e) => updateDraft("reviewStatus", e.target.value)}><option value="">全部审核状态</option><option value="PENDING">待审核</option><option value="APPROVED">已通过</option><option value="REJECTED">已驳回</option><option value="INVALID">已失效</option></select></div>
      <div className="field"><label htmlFor="hasContact">有无可用联系方式</label><select id="hasContact" value={draft.hasContact} onChange={(e) => updateDraft("hasContact", e.target.value)}><option value="">全部</option><option value="YES">有可用联系方式</option><option value="NO">无可用联系方式</option></select></div>
      <div className="field"><label htmlFor="followUpStatus">跟进状态</label><select id="followUpStatus" value={draft.followUpStatus} onChange={(e) => updateDraft("followUpStatus", e.target.value)}><option value="">全部跟进状态</option>{Object.entries(followUpLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
      <div className="field"><label htmlFor="favorite">收藏</label><select id="favorite" value={draft.favorite} onChange={(e) => updateDraft("favorite", e.target.value)}><option value="">全部账号</option><option value="YES">我收藏的</option><option value="NO">未收藏</option></select></div>
      <button className="button secondary" type="submit" disabled={loading}>筛选</button>
    </form>
    {error ? <div className="notice error" role="alert">{error}</div> : null}
    <section className="card">
      {loading ? <div className="empty">正在加载账号…</div> : items.length === 0 ? <div className="empty">暂无符合条件的已入库账号。</div> : <div className="table-wrap"><table><thead><tr><th>平台</th><th>账号名</th><th>机构</th><th>服务标签</th><th>审核 / 联系</th><th>负责人</th><th>跟进</th><th>来源</th><th>操作</th></tr></thead><tbody>{items.map((account) => <tr key={account.id}><td>{labels[account.platform] ?? account.platform}</td><td><Link className="text-link" href={`/accounts/${account.id}`}>{account.displayName}</Link>{account.isDemo ? <span className="badge warning" style={{ marginLeft: 7 }}>演示数据</span> : null}</td><td>{account.organization || "—"}</td><td><div className="tag-list">{account.serviceTags.map((tag) => <span className="tag" key={tag}>{tag}</span>)}</div><div className="muted small" style={{ marginTop: 5 }}>{account.region || "未填写地区"}</div></td><td><div>{account.reviewStatus === "APPROVED" ? "已通过" : account.reviewStatus === "PENDING" ? "待审核" : account.reviewStatus === "REJECTED" ? "已驳回" : account.reviewStatus === "INVALID" ? "已失效" : "无联系项"}</div><span className={`badge ${account.hasUsableContact ? "success" : "neutral"}`}>{account.hasUsableContact ? "有可用联系方式" : "暂无可用"}</span></td><td>{account.owner?.email ?? "未分配"}</td><td><span className="badge neutral">{followUpLabels[account.followUp.status] ?? account.followUp.status}</span>{account.followUp.noteMasked ? <div className="muted small" style={{ marginTop: 5 }}>备注受权限限制</div> : account.followUp.note ? <div className="muted small pre-wrap" style={{ marginTop: 5 }}>{account.followUp.note}</div> : null}</td><td><span className={`badge ${account.source.status === "APPROVED" ? "success" : "warning"}`}>{account.source.name}</span></td><td>{canManage ? <button className="button secondary" type="button" disabled={Boolean(favoriteBusy[account.id])} onClick={() => void toggleFavorite(account)}>{favoriteBusy[account.id] ? "保存中…" : account.favorite ? "取消收藏" : "收藏"}</button> : <span className="muted small">{account.favorite ? "已收藏" : "未收藏"}</span>}</td></tr>)}</tbody></table></div>}
      {!loading && total > 0 ? <div className="pagination"><span>共 {total} 条，第 {page} / {pages} 页</span><div className="inline-actions"><button className="button secondary" type="button" disabled={page <= 1 || loading} onClick={() => void load(applied, page - 1)}>上一页</button><button className="button secondary" type="button" disabled={page >= pages || loading} onClick={() => void load(applied, page + 1)}>下一页</button></div></div> : null}
    </section>
  </main>;
}
