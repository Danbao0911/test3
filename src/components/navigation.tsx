"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { roleLabels, type Role } from "@/lib/permissions";

const links = [
  ["账号库", "/accounts"],
  ["导入中心", "/imports"],
  ["数据来源", "/sources"],
  ["平台接入", "/platforms"],
  ["联系审核", "/reviews"],
  ["账号关联审核", "/account-links"],
  ["受控导出", "/exports"],
] as const;

export function Navigation({ email, mode, role }: { email: string; mode: "demo" | "production" | "test"; role: Role }) {
  const pathname = usePathname();
  const router = useRouter();
  async function logout() {
    await fetch("/api/auth/logout", { method: "POST", headers: { Origin: window.location.origin } });
    router.push("/login");
    router.refresh();
  }
  return (
    <header className="topbar">
      <Link className="brand" href="/accounts">专业服务账号工作台</Link>
      <nav className="nav-links" aria-label="主导航">
        {links.filter(([, href]) => href !== "/exports" || role === "ADMIN").map(([label, href]) => <Link key={href} className={`nav-link ${pathname.startsWith(href) ? "active" : ""}`} href={href}>{label}</Link>)}
        <button className="nav-link" onClick={logout}>退出登录</button>
      </nav>
      <div className="user-menu"><span>{email} · {roleLabels[role]}</span><span className={`badge ${mode === "production" ? "success" : "warning"}`}>{mode === "production" ? "生产模式" : mode === "test" ? "测试模式 · 演示数据" : "演示模式 · 演示数据"}</span></div>
    </header>
  );
}
