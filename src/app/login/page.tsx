"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("admin@example.test");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setBusy(true);
    try {
      const response = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: window.location.origin }, body: JSON.stringify({ email, password }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message ?? "登录失败");
      router.push("/accounts"); router.refresh();
    } catch (err) { setError(err instanceof Error ? err.message : "登录失败"); } finally { setBusy(false); }
  }
  return (
    <main className="login-page">
      <section className="card login-card">
        <h1>专业服务账号工作台</h1>
        <p>内部账号导入与来源核验。请使用管理员初始化脚本生成的本地凭据登录。</p>
        <form onSubmit={submit} className="form-grid">
          <div className="field full"><label htmlFor="email">管理员邮箱</label><input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
          <div className="field full"><label htmlFor="password">密码</label><input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></div>
          {error ? <div className="notice error full" role="alert">{error}</div> : null}
          <div className="form-actions full"><button className="button" disabled={busy}>{busy ? "登录中…" : "登录"}</button></div>
        </form>
      </section>
    </main>
  );
}
