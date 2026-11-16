import type { AiAgent } from "../desktop";
import codex from "../assets/ai/codex.svg?no-inline";

export const agentLabels: Record<AiAgent, string> = { codex: "Codex", claude_code: "Claude Code" };
const localIcons = import.meta.glob<string>("../assets/ai/claude-code.svg", {
  eager: true, import: "default", query: "?url&no-inline",
});
const icons: Partial<Record<AiAgent, string>> = { codex, claude_code: localIcons["../assets/ai/claude-code.svg"] };

export function AiAgentIcon({ agent }: { agent: AiAgent }) {
  const src = icons[agent];
  return src ? <img className="ai-agent-icon" data-agent={agent} src={src} alt="" width={16} height={16} draggable={false} /> : null;
}
