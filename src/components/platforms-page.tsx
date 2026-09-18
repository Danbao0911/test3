"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { platformOperations, type PlatformCapabilities, type PlatformId, type PlatformOperation } from "@/connectors/types";
import type { PlatformPreflight } from "@/lib/platform-service";

const operationLabels: Record<PlatformOperation, string> = {
  discoverAccounts: "关键词发现", fetchProfile: "账号资料读取", refreshRecord: "资料刷新", handleDeletion: "平台删除同步",
};
const statusLabels = { not_configured: "未配置 / 未验证", permission_required: "缺少许可", not_supported: "尚不支持" };
type SourceOption = { id: string; name: string; policyVersion: number; status: string };

async function jsonResponse(response: Response) {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(response.status === 401 ? "会话已过期，请重新登录" : response.status === 403 ? "当前账号没有核对权限" : response.status === 409 ? "来源策略已变化，请刷新来源并重新核对；所选平台和操作已保留。" : body?.message ?? "请求失败，请稍后重试");
  if (!body) throw new Error("服务返回了无法识别的结果，请重试");
  return body;
}

export default function PlatformsPage({ items, canCheck }: { items: PlatformCapabilities[]; canCheck: boolean }) {
  const router = useRouter();
  const [platform, setPlatform] = useState<PlatformId>("YOUTUBE");
  const [operation, setOperation] = useState<PlatformOperation>("fetchProfile");
  const [sources, setSources] = useState<SourceOption[]>([]);
  const [sourceId, setSourceId] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [previous, setPrevious] = useState<Array<string | null>>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(canCheck);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<PlatformPreflight | null>(null);

  useEffect(() => {
    if (!canCheck) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/platforms/sources${cursor ? `?after=${cursor}` : ""}`, { signal: controller.signal, cache: "no-store" });
        if (response.status === 401) router.push("/login");
        const data = await jsonResponse(response);
        if (!Array.isArray(data.items)) throw new Error("来源列表格式无效，请重试");
        if (!controller.signal.aborted) { setSources(data.items); setNextCursor(data.nextCursor); }
      } catch (err) {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "网络异常，请重试");
      } finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [canCheck, cursor, reload, router]);

  function changeSourcePage(next: string | null) {
    setLoading(true); setSources([]); setSourceId(""); setResult(null); setError(""); setNextCursor(null); setCursor(next); setReload(value => value + 1);
  }

  async function check(event: FormEvent) {
    event.preventDefault();
    const source = sources.find(item => item.id === sourceId);
    if (!source || busy) return;
    setBusy(true); setError(""); setResult(null);
    try {
      const response = await fetch("/api/platforms/preflight", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ platform, operation, sourceId, expectedPolicyVersion: source.policyVersion }) });
      if (response.status === 401) router.push("/login");
      const data = await jsonResponse(response);
      if (!data.item || !Array.isArray(data.item.blockers) || data.item.executed !== false) throw new Error("预检结果格式无效，请重试");
      setResult(data.item);
    } catch (err) { setError(err instanceof Error ? err.message : "网络异常，请重试"); }
    finally { setBusy(false); }
  }

  return <main className="page">
    <div className="page-header"><div><h1 className="page-title">平台接入</h1><p className="page-subtitle">查看本项目的真实能力状态。账号库中的平台标签不代表已接通官方 API。</p></div></div>
    <p className="notice warning">四个平台均未完成真实调用验证，外部搜索和自动采集暂不可用。当前只提供获准来源的人工录入与导入。</p>
    <section className="card"><h2>能力矩阵</h2><div className="table-wrap"><table>
      <thead><tr><th>平台</th>{platformOperations.map(key => <th key={key}>{operationLabels[key]}</th>)}<th>接入说明</th></tr></thead>
      <tbody>{items.map(item => <tr key={item.platform}>
        <td>{item.label}<p className="small muted">真实验证：未验证</p></td>
        {platformOperations.map(key => <td key={key}>{statusLabels[item.operations[key].status]}</td>)}
        <td style={{ maxWidth: 420 }}>{item.limitation}<p className="small muted">本项目允许的平台请求数：0；平台实际配额待验证。</p><button className="button secondary" disabled aria-label={`${item.label} 外部搜索不可用`}>外部搜索未开放</button></td>
      </tr>)}</tbody>
    </table></div></section>
    <p><Link className="text-link" href="/accounts">搜索已入库账号</Link> · <Link className="text-link" href="/imports">获准来源导入</Link> · <Link className="text-link" href="/sources">管理来源</Link></p>
    {canCheck ? <section className="card"><h2>接入条件核对</h2><p className="muted">按当前来源策略核对缺少的条件，仅检查本地记录，不调用平台、不保存账号资料。核对结果不授予后续调用权限。</p>
      {error && <div className="notice error" role="alert">{error}</div>}
      <form className="form-grid" onSubmit={check}>
        <div className="field"><label htmlFor="platform">平台</label><select id="platform" value={platform} disabled={busy} onChange={e => { setPlatform(e.target.value as PlatformId); setResult(null); }}>{items.map(item => <option key={item.platform} value={item.platform}>{item.label}</option>)}</select></div>
        <div className="field"><label htmlFor="platform-operation">需要的能力</label><select id="platform-operation" value={operation} disabled={busy} onChange={e => { setOperation(e.target.value as PlatformOperation); setResult(null); }}>{platformOperations.map(key => <option key={key} value={key}>{operationLabels[key]}</option>)}</select></div>
        <div className="field full"><label htmlFor="platform-source">已登记来源</label><select id="platform-source" value={sourceId} disabled={loading || busy} required onChange={e => { setSourceId(e.target.value); setResult(null); }}><option value="">{loading ? "正在加载来源…" : "请选择来源"}</option>{sources.map(source => <option key={source.id} value={source.id}>{source.name} · v{source.policyVersion} · {source.status}</option>)}</select></div>
        <div className="form-actions full">
          <button className="button" disabled={loading || busy || !sourceId}>{busy ? "正在核对…" : "核对接入条件"}</button>
          <button type="button" className="button secondary" disabled={busy || loading} onClick={() => changeSourcePage(cursor)}>刷新来源</button>
          <button type="button" className="button secondary" disabled={busy || loading || previous.length === 0} onClick={() => { changeSourcePage(previous[previous.length - 1]); setPrevious(value => value.slice(0, -1)); }}>上一页来源</button>
          <button type="button" className="button secondary" disabled={busy || loading || !nextCursor} onClick={() => { setPrevious(value => [...value, cursor]); changeSourcePage(nextCursor); }}>下一页来源</button>
        </div>
      </form>
      {!loading && sources.length === 0 && !error && <p className="empty">本页没有来源，请先登记获准来源。</p>}
      {result && <div className="notice warning" role="status"><strong>尚不能调用平台 · 未发起外部请求</strong><p>来源策略 v{result.source.policyVersion}；核对时间 {new Date(result.checkedAt).toLocaleString("zh-CN")}。</p><ul>{result.blockers.map(blocker => <li key={blocker.code}>{blocker.message}</li>)}</ul></div>}
    </section> : <p className="notice">仅管理员可核对来源接入条件；当前账号可查看平台能力状态。</p>}
  </main>;
}
