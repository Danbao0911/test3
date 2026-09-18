import type { Metadata } from "next";
import "./globals.css";
import { getCurrentUser } from "@/lib/auth";
import { Navigation } from "@/components/navigation";
import { currentRuntimeMode } from "@/lib/runtime-config";

export const metadata: Metadata = {
  title: "专业服务账号与商务线索工作台",
  description: "内部账号导入与来源核验工作台",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const user = await getCurrentUser();
  return (
    <html lang="zh-CN">
      <body>
        {user ? <Navigation email={user.email} mode={currentRuntimeMode()} role={user.role} /> : null}
        {children}
      </body>
    </html>
  );
}
