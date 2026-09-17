import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import NewAccountPage from "@/components/new-account-page";

export default async function Page() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role === "VIEWER") return <main className="page"><div className="notice">只读成员无录入权限。</div></main>;
  return <NewAccountPage />;
}
