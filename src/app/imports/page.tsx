import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import ImportsClientPage from "@/components/imports-page";

export default async function ImportsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role === "VIEWER") return <main className="page"><div className="notice">只读成员无导入权限。</div></main>;
  return <ImportsClientPage />;
}
