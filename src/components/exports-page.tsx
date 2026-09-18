"use client";

import { FormEvent, useEffect, useState } from "react";

const fields = [
  ["DISPLAY_NAME", "账号名称"], ["PLATFORM", "平台"], ["ORGANIZATION", "机构"], ["SERVICE_TAGS", "服务标签"], ["REGION", "业务地区"],
  ["CONTACT_TYPE", "联系类型"], ["CONTACT_VALUE", "联系值"], ["SOURCE_URL", "证据地址"], ["CAPTURED_AT", "取得时间"], ["REVIEWED_AT", "核验时间"],
] as const;
type Job = { id: string; fieldSet: string[]; rowCount: number; excludedCount: number; status: string; expiresAt: string; downloadedAt: string | null; createdAt: string };

export default function ExportsClientPage() {
  const [selected, setSelected] = useState<string[]>(["DISPLAY_NAME", "PLATFORM", "ORGANIZATION", "CONTACT_TYPE", "CONTACT_VALUE", "SOURCE_URL", "REVIEWED_AT"]);
  const [q, setQ] = useState("");
  const [minutes, setMinutes] = useState(10);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [downloadUrl, setDownloadUrl] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const response = await fetch("/api/exports", { cache: "no-store" });
    if (response.ok) setJobs((await response.json()).items as Job[]);
  }
  useEffect(() => { queueMicrotask(() => { void load(); }); }, []);
  function toggle(field: string) { setSelected((current) => current.includes(field) ? current.filter((item) => item !== field) : [...current, field]); }
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setMessage(""); setDownloadUrl("");
    try {
      const response = await fetch("/api/exports", { method: "POST", headers: { "Content-Type": "application/json", Origin: window.location.origin }, body: JSON.stringify({ fields: selected, filters: q.trim() ? { q: q.trim() } : {}, expiresInMinutes: minutes }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "导出准备失败");
      setDownloadUrl(data.item.downloadUrl); setMessage(`已生成 ${data.item.rowCount} 行；${data.item.excludedCount} 个不满足当前策略的记录未导出。链接短期有效且只能下载一次。`); await load();
    } catch (err) { setError(err instanceof Error ? err.message : "导出失败，请重试"); }
    finally { setBusy(false); }
  }
  return <main className="page"><div className="page-header"><div><h1 className="page-title">受控导出</h1><p className="page-subtitle">仅管理员可用。导出前重新检查来源许可、当前策略、人工核验、有效期和“不再联系”状态。</p></div></div>
    {error ? <div className="notice error" role="alert">{error}</div> : null}{message ? <div className="notice success" role="status">{message}</div> : null}
    <section className="card"><form className="form-grid" onSubmit={submit}><div className="field wide"><label htmlFor="export-q">筛选已入库账号</label><input id="export-q" value={q} onChange={(event) => setQ(event.target.value)} maxLength={120} placeholder="账号名或机构，可留空" /></div><div className="field"><label htmlFor="export-minutes">链接有效分钟</label><input id="export-minutes" type="number" min={1} max={30} value={minutes} onChange={(event) => setMinutes(Number(event.target.value))} /></div><fieldset className="full" disabled={busy} style={{ border: 0, padding: 0 }}><legend>导出字段</legend><div className="inline-actions">{fields.map(([value, label]) => <label key={value}><input type="checkbox" checked={selected.includes(value)} onChange={() => toggle(value)} />{label}</label>)}</div></fieldset><div className="form-actions full"><button className="button" disabled={busy || selected.length === 0}>{busy ? "校验中…" : "生成一次性下载链接"}</button></div></form>{downloadUrl ? <p className="notice"><a className="text-link" href={downloadUrl}>下载 CSV（使用一次后失效）</a></p> : null}</section>
    <section className="card"><h2>最近导出记录</h2><div className="table-wrap"><table><thead><tr><th>时间</th><th>行数</th><th>排除</th><th>状态</th><th>到期</th></tr></thead><tbody>{jobs.map((job) => <tr key={job.id}><td>{new Date(job.createdAt).toLocaleString("zh-CN")}</td><td>{job.rowCount}</td><td>{job.excludedCount}</td><td>{job.status}</td><td>{new Date(job.expiresAt).toLocaleString("zh-CN")}</td></tr>)}</tbody></table></div>{!jobs.length ? <p className="muted">暂无导出记录。</p> : null}</section>
  </main>;
}
