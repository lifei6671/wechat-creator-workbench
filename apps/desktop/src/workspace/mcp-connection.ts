import type { McpClient } from "../desktop";

export const mcpConfigHints: Record<McpClient, string> = {
  codex: "含令牌，仅粘贴到个人配置（默认 ~/.codex/config.toml）。保存后重启 Codex 即可。",
  claude: "含令牌，仅将此服务合并到个人 ~/.claude.json。保存后重启 Claude Code。",
  other: "含令牌，仅用于客户端的个人配置。按客户端要求填写地址和请求头。",
};
