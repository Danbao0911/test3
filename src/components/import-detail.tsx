"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

const labels: Record<string, string> = { XIAOHONGSHU: "小红书", YOUTUBE: "YouTube", X: "X", DOUYIN: "抖音" };
type Batch = { id: string; totalRows: number; createdCount: number; duplicateCount: number; invalidCount: number; createdAt: string; source: { name: string; status: string; type: string }; rows: Array<{ id: string; rowNumber: number; status: string; account: { id: string; displayName: string; platform: string } | null; errorCode: string | null; errorMessage: string | null }> };

export function ImportDetail({ id }: { id: string }) {
  const [batch, setBatch] = useState<Batch | null>(null); const [error, setError] = useState("");
  useEffect(() => { fetch(`/api/imports/${id}`).then(async (response) => { const data = await response.json(); if (!response.ok) { setError(data.message ?? "导入批次加载失败"); return; } setBatch(data.item); }); }, [id]);
  if (error) return <main className="page"><div className="notice error">{error}</div><Link className="text-link" href="/imports">返回导入中心</Link></main>;
  if (!batch) return <main className="page"><div className="empty">正在加载导入结果…</div></main>;
  return <main className="page"><div className="page-header"><div><h1 className="page-title">导入结果</h1><p className="page-subtitle">{batch.source.name} · {new Date(batch.createdAt).toLocaleString("zh-CN")}</p></div><Link className="button secondary" href="/imports">返回导入中心</Link></div><div className="stats"><div className="stat"><div className="stat-label">数据行</div><div className="stat-value">{batch.totalRows}</div></div><div className="stat"><div className="stat-label">新增</div><div className="stat-value">{batch.createdCount}</div></div><div className="stat"><div className="stat-label">重复</div><div className="stat-value">{batch.duplicateCount}</div></div><div className="stat"><div className="stat-label">失败</div><div className="stat-value">{batch.invalidCount}</div></div></div><section className="card"><div className="table-wrap"><table><thead><tr><th>CSV 行</th><th>状态</th><th>平台</th><th>账号</th><th>错误</th></tr></thead><tbody>{batch.rows.map((row) => <tr key={row.id}><td>{row.rowNumber}</td><td><span className={`badge ${row.status === "CREATED" ? "success" : row.status === "DUPLICATE" ? "neutral" : "danger"}`}>{row.status}</span></td><td>{row.account ? labels[row.account.platform] : "—"}</td><td>{row.account ? <Link className="text-link" href={`/accounts/${row.account.id}`}>{row.account.displayName}</Link> : "—"}</td><td>{row.errorMessage ? `${row.errorCode ?? ""}：${row.errorMessage}` : "—"}</td></tr>)}</tbody></table></div></section></main>;
}
