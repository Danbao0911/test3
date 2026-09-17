export type Role = "ADMIN" | "REVIEWER" | "VIEWER";
export const canMaintain = (role: Role) => role === "ADMIN" || role === "REVIEWER";
export const canManageSources = (role: Role) => role === "ADMIN";
export const roleLabels: Record<Role, string> = { ADMIN: "管理员", REVIEWER: "审核员", VIEWER: "只读成员" };
