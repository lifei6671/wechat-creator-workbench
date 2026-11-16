import type { AiAgent } from "../desktop";
import codex from "../assets/ai/codex.svg?no-inline";
import claudeCode from "../assets/ai/claude-code.svg?no-inline";

export const agentLabels: Record<AiAgent, string> = { codex: "Codex", claude_code: "Claude Code" };
const icons: Record<AiAgent, string> = { codex, claude_code: claudeCode };

export function AiAgentIcon({ agent }: { agent: AiAgent }) {
  return <img className="ai-agent-icon" data-agent={agent} src={icons[agent]} alt="" width={16} height={16} draggable={false} />;
}
