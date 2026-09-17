"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

const links = [
  ["账号库", "/accounts"],
  ["导入中心", "/imports"],
  ["数据来源", "/sources"],
] as const;

export function Navigation({ email, mode }: { email: string; mode: "demo" | "production" | "test" }) {
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
        {links.map(([label, href]) => <Link key={href} className={`nav-link ${pathname.startsWith(href) ? "active" : ""}`} href={href}>{label}</Link>)}
        <button className="nav-link" onClick={logout}>退出登录</button>
      </nav>
      <div className="user-menu"><span>{email}</span><span className={`badge ${mode === "production" ? "success" : "warning"}`}>{mode === "production" ? "生产模式" : mode === "test" ? "测试模式" : "演示模式"}</span></div>
    </header>
  );
}
