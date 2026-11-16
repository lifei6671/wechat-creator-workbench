import { DropdownMenu } from "@radix-ui/themes";
import { ChevronDown } from "lucide-react";
import type { AiAgent, AiAgentModel, AiSelection, AiSettings } from "../desktop";
import { Tooltip } from "../ui";
import { AiAgentIcon, agentLabels } from "./AiAgentIcon";

const value = ({ target, agentModel }: AiSelection) => JSON.stringify([target.kind, target.id, agentModel]);

export function AiTargetPicker({ settings, catalog, selection, label, saving = false, onSelect }: {
  settings?: AiSettings;
  catalog?: Partial<Record<AiAgent, AiAgentModel[]>>;
  selection?: AiSelection;
  label: string;
  saving?: boolean;
  onSelect(selection: AiSelection): void;
}) {
  const agents = settings?.preferences.enabled ? settings.agents.filter(agent => agent.installed) : [];
  const models = settings?.preferences.enabled ? settings.models : [];
  const agent = selection?.target.kind === "agent" ? selection.target.id : undefined;
  const modelLabel = agent && (catalog?.[agent]?.find(model => model.id === selection?.agentModel)?.label ?? selection?.agentModel);
  const name = modelLabel ? `${label}（${modelLabel}）` : label;
  if (!agents.length && !models.length) return <span className="ai-composer-target" title={label}>{label}</span>;

  return <DropdownMenu.Root>
    <Tooltip content={name}><DropdownMenu.Trigger>
      <button type="button" className="ai-target-trigger" aria-label={`AI 目标：${name}`}>
        {agent && <AiAgentIcon agent={agent} />}
        <span className="ai-composer-target">{modelLabel || label}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
    </DropdownMenu.Trigger></Tooltip>
    <DropdownMenu.Content side="top" align="start" sideOffset={8} size="2" className="ai-target-menu">
      <DropdownMenu.RadioGroup value={selection ? value(selection) : ""}>
        {agents.map(({ id }, index) => <DropdownMenu.Group key={id}>
          {index > 0 && <DropdownMenu.Separator />}
          <DropdownMenu.Label className="ai-agent-menu-label"><AiAgentIcon agent={id} />{agentLabels[id]}</DropdownMenu.Label>
          {[{ id: undefined, label: "代理默认" }, ...(catalog?.[id] ?? [])].map(model => {
            const option: AiSelection = { target: { kind: "agent", id }, agentModel: model.id };
            return <DropdownMenu.RadioItem key={model.id ?? ""} value={value(option)} disabled={saving} aria-label={`${agentLabels[id]}，${model.label}`}
              onSelect={() => onSelect(option)}>{model.label}</DropdownMenu.RadioItem>;
          })}
        </DropdownMenu.Group>)}
        {models.length > 0 && <DropdownMenu.Group>
          {agents.length > 0 && <DropdownMenu.Separator />}
          <DropdownMenu.Label>已配置的模型</DropdownMenu.Label>
          {models.map(model => {
            const option: AiSelection = { target: { kind: "model", id: model.id } };
            return <DropdownMenu.RadioItem key={model.id} value={value(option)} disabled={saving} onSelect={() => onSelect(option)}>
              {model.name || model.model}
            </DropdownMenu.RadioItem>;
          })}
        </DropdownMenu.Group>}
      </DropdownMenu.RadioGroup>
    </DropdownMenu.Content>
  </DropdownMenu.Root>;
}
