import type { EntryStatus } from "../../../packages/shared-types";
export const statusLabels: Record<EntryStatus, string> = {
  inbox: "待整理", planned: "已计划", used: "已采用", archived: "已归档", unread: "未读",
  reviewed: "已整理", draft: "草稿", ready: "待发布", published: "已发布",
};
export const untitled = "无标题笔记";

export const dateLabel = (time: number) => new Intl.DateTimeFormat("zh-CN", {
  month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
}).format(time);

export const commandKey = /Mac/.test(navigator.platform) ? "⌘" : "Ctrl+";
