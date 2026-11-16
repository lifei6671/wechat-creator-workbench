import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button, Select, Switch, Tabs, TextField } from "@radix-ui/themes";
import { desktop, errorMessage, type AiAgent, type AiModel, type AiModelKind, type AiSettings, type AiTarget } from "../desktop";
import { SettingRow } from "./Settings";

const agentLabels: Record<AiAgent, string> = { codex: "Codex", claude_code: "Claude Code" };
const localAgentIcons = import.meta.glob<string>("../assets/ai/*.png", { eager: true, import: "default", query: "?url" });
const agentIcons: Partial<Record<AiAgent, string>> = {
  codex: localAgentIcons["../assets/ai/codex.png"],
  claude_code: localAgentIcons["../assets/ai/claude-code.png"],
};
const groups = { agents: "本地代理", local: "本地模型", custom: "API 模型" } as const;
const presets = {
  local: [
    { label: "Ollama", endpoint: "http://127.0.0.1:11434/v1" },
    { label: "LM Studio", endpoint: "http://127.0.0.1:1234/v1" },
    { label: "自定义接口", endpoint: "" },
  ],
  custom: [
    { label: "OpenAI", endpoint: "https://api.openai.com/v1" },
    { label: "Gemini", endpoint: "https://generativelanguage.googleapis.com/v1beta/openai" },
    { label: "OpenRouter", endpoint: "https://openrouter.ai/api/v1" },
    { label: "自定义接口", endpoint: "" },
  ],
};
const labelModel = (model: AiModel) => model.name || model.model;
const targetValue = (target: AiTarget) => `${target.kind}:${target.id}`;

export function aiAvailability(settings: AiSettings) {
  if (!settings.preferences.enabled) return { hint: "AI 功能未启用" };
  const target = settings.preferences.defaultTarget;
  if (target?.kind === "agent") {
    const label = agentLabels[target.id];
    return settings.agents.find(agent => agent.id === target.id)?.installed
      ? { label }
      : { hint: `未找到 ${label}` };
  }
  const model = settings.models.find(model => model.id === target?.id);
  return model ? { label: labelModel(model) } : { hint: "请选择默认 AI 目标" };
}

type Group = AiModelKind | "preferences";
type Run = (group: Group, action: string, operation: () => Promise<void>, success?: string) => Promise<void>;

export function ModelSettings({ settings, loadError, onChange }: {
  settings?: AiSettings;
  loadError: string;
  onChange(settings: AiSettings): void;
}) {
  const [working, setWorking] = useState("");
  const [feedback, setFeedback] = useState<{ group: Group; error: boolean; text: string }>();
  const [versions, setVersions] = useState<Partial<Record<AiAgent, string | null>>>();
  useEffect(() => {
    let current = true;
    void desktop.aiAgentVersions().then(entries => {
      if (current) setVersions(Object.fromEntries(entries));
    }, () => {
      if (current) setVersions({});
    });
    return () => { current = false; };
  }, []);

  const run: Run = async (group, action, operation, success) => {
    setWorking(action);
    setFeedback(undefined);
    try {
      await operation();
      if (success) setFeedback({ group, error: false, text: success });
    } catch (error) {
      setFeedback({ group, error: true, text: errorMessage(error) });
    } finally {
      setWorking("");
    }
  };

  function message(group: Group) {
    return feedback?.group === group && <p className={`settings-feedback ${feedback.error ? "inline-error" : "muted-text"}`}
      role={feedback.error ? "alert" : "status"}>{feedback.text}</p>;
  }

  if (!settings) return <div className="settings-card"><p className={`settings-feedback ${loadError ? "inline-error" : "muted-text"}`}
    role={loadError ? "alert" : "status"}>{loadError || "正在读取设置…"}</p></div>;

  const disabled = Boolean(working);
  const { preferences } = settings;
  const targets: { target: AiTarget; label: string; missing?: boolean }[] = [
    ...settings.agents.map(agent => ({
      target: { kind: "agent", id: agent.id } as const,
      label: `${groups.agents}：${agentLabels[agent.id]}`,
      missing: !agent.installed,
    })),
    ...(["local", "custom"] as const).flatMap(kind =>
      settings.models.filter(model => model.kind === kind).map(model => ({
        target: { kind: "model", id: model.id } as const,
        label: `${groups[kind]}：${labelModel(model)}`,
      })),
    ),
  ];
  const availability = aiAvailability(settings);
  const unavailable = preferences.enabled && preferences.defaultTarget && !availability.label;

  return <div className="ai-settings">
    <div className="settings-card ai-settings-card">
      <SettingRow id="ai-enabled" label="启用 AI 功能" hint="控制 AI 助手能否生成摘要、标题和改写建议。">
        <Switch id="ai-enabled" size="2" checked={preferences.enabled} disabled={disabled}
          onCheckedChange={enabled => void run("preferences", "enabled", async () => {
            onChange(await desktop.saveAiPreferences({ ...preferences, enabled }));
          })} />
      </SettingRow>
    </div>
    <div className="settings-card ai-settings-card ai-default-card">
      <SettingRow id="ai-default" label="默认 AI 目标" hint={unavailable ? availability.hint : "AI 助手将使用这个目标。"}>
        <Select.Root value={preferences.defaultTarget ? targetValue(preferences.defaultTarget) : "none"} disabled={disabled}
          onValueChange={value => {
            const defaultTarget = targets.find(item => targetValue(item.target) === value)?.target ?? null;
            void run("preferences", "default", async () => {
              onChange(await desktop.saveAiPreferences({ ...preferences, defaultTarget }));
            });
          }}>
          <Select.Trigger id="ai-default" />
          <Select.Content position="popper" className="ai-default-options">
            <Select.Item value="none">未选择</Select.Item>
            {targets.map(item => <Select.Item key={targetValue(item.target)} value={targetValue(item.target)}>
              {item.label}{item.missing && <> <span className="ai-target-missing">缺失</span></>}
            </Select.Item>)}
          </Select.Content>
        </Select.Root>
      </SettingRow>
      {message("preferences")}
    </div>
    <Tabs.Root defaultValue="agents" className="ai-settings-tabs">
      <Tabs.List size="1" aria-label="AI 目标类型">
        {Object.entries(groups).map(([id, label]) => <Tabs.Trigger key={id} value={id}>{label}</Tabs.Trigger>)}
      </Tabs.List>
      <Tabs.Content value="agents" className="settings-card ai-settings-card ai-target-pane">
        <h3>已识别的本地代理</h3>
        <p className="ai-settings-hint">在本机安装并登录代理后，即可用它生成写作建议。</p>
        <div className="ai-agent-grid">
          {settings.agents.map(agent =>
            <div key={agent.id} className="ai-agent-card">
              <div className="ai-agent-heading">
                <strong>
                  {agentIcons[agent.id] && <img src={agentIcons[agent.id]} width={16} height={16} alt="" draggable={false} />}
                  {agentLabels[agent.id]}
                </strong>
                <span className="settings-state" data-running={agent.installed}>{agent.installed ? "已安装" : "未找到"}</span>
              </div>
              <span className="ai-agent-version">
                {versions?.[agent.id] ?? (agent.installed && !versions ? "正在读取版本…" : "未检测到版本")}
              </span>
            </div>
          )}
        </div>
      </Tabs.Content>
      {(["local", "custom"] as const).map(kind => <Tabs.Content key={kind} value={kind} forceMount
        className="settings-card ai-settings-card ai-target-pane">
        <ModelPane kind={kind} models={settings.models.filter(model => model.kind === kind)}
          working={working} onChange={onChange} run={run} feedback={message(kind)} />
      </Tabs.Content>)}
    </Tabs.Root>
  </div>;
}

type Draft = Omit<AiModel, "id" | "kind"> & {
  id: string | null;
  preset: string;
  key: string;
  keyMode: "system" | "none";
};

function emptyDraft(kind: AiModelKind): Draft {
  const { label, endpoint } = presets[kind][0];
  return { id: null, preset: label, endpoint, name: label, model: "", timeoutSeconds: 60, key: "",
    keyMode: kind === "local" ? "none" : "system" };
}

function ModelPane({ kind, models, working, onChange, run, feedback }: {
  kind: AiModelKind;
  models: AiModel[];
  working: string;
  onChange(settings: AiSettings): void;
  run: Run;
  feedback: ReactNode;
}) {
  const [draft, setDraft] = useState(() => emptyDraft(kind));
  const [keyEndpoint, setKeyEndpoint] = useState<string>();
  const form = useRef<HTMLFormElement>(null);
  const disabled = Boolean(working);
  const addLabel = kind === "local" ? "添加本地模型" : "添加 API 模型";
  const config = { endpoint: draft.endpoint, model: draft.model, timeoutSeconds: draft.timeoutSeconds };
  const key = draft.keyMode === "none" ? (draft.id ? "" : undefined) : draft.key.trim() || undefined;
  const update = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const reset = () => { setDraft(emptyDraft(kind)); setKeyEndpoint(undefined); };

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(kind, `save-${kind}`, async () => {
      onChange(await desktop.saveAiModel(draft.id, kind, draft.name, config, key));
      reset();
    }, "模型已保存");
  }

  return <>
    <h3>{groups[kind]}</h3>
    <p className="ai-settings-hint">{kind === "local" ? "连接本机运行的 Ollama、LM Studio 或其他兼容服务。" : "连接 OpenAI、Gemini、OpenRouter 或其他兼容 Chat Completions 的接口。"}</p>
    <div className="ai-model-list">
      {models.length === 0 && <p className="ai-model-empty">尚未配置{groups[kind]}。</p>}
      {models.map(model => {
        const target = { kind: "model", id: model.id } as const;
        return <div className="ai-model-row" key={model.id}>
          <div className="ai-model-details">
            <strong>{labelModel(model)}</strong>
            <span title={model.endpoint}>{model.endpoint}</span>
          </div>
          <div className="button-strip setting-actions">
            <Button type="button" size="1" variant="soft" color="gray" disabled={disabled || draft.id === model.id}
              aria-label={`编辑 ${labelModel(model)}`} onClick={() => void run(kind, `edit-${kind}`, async () => {
                const hasKey = await desktop.aiModelHasKey(model.id);
                setKeyEndpoint(hasKey ? model.endpoint : undefined);
                setDraft({ ...model, preset: "", key: "", keyMode: hasKey ? "system" : "none" });
                requestAnimationFrame(() => form.current?.querySelector<HTMLInputElement>('[name="model-name"]')?.focus());
              })}>编辑</Button>
            <Button type="button" size="1" variant="soft" color="gray" disabled={disabled} loading={working === targetValue(target)}
              aria-label={`测试 ${labelModel(model)}`} onClick={() => void run(kind, targetValue(target),
                () => desktop.testAiTarget(target), "连接成功")}>测试连接</Button>
            <Button type="button" size="1" variant="soft" color="red" disabled={disabled} loading={working === `remove-${model.id}`}
              aria-label={`移除 ${labelModel(model)}`} onClick={() => void run(kind, `remove-${model.id}`, async () => {
                onChange(await desktop.deleteAiModel(model.id));
                if (draft.id === model.id) reset();
              }, "模型已移除")}>移除</Button>
          </div>
        </div>;
      })}
    </div>
    <form ref={form} className="ai-model-form" onSubmit={save} aria-label={draft.id ? "编辑模型" : addLabel}>
      <div className="ai-model-fields">
        {draft.id === null && <div className="ai-form-field">
          <label htmlFor={`ai-provider-${kind}`}>供应商</label>
          <Select.Root value={draft.preset} disabled={disabled} onValueChange={value => {
            const preset = presets[kind].find(preset => preset.label === value)!;
            update({ preset: value, endpoint: preset.endpoint, name: value === "自定义接口" ? "" : value, key: "" });
          }}>
            <Select.Trigger id={`ai-provider-${kind}`} />
            <Select.Content position="popper">
              {presets[kind].map(preset => <Select.Item key={preset.label} value={preset.label}>{preset.label}</Select.Item>)}
            </Select.Content>
          </Select.Root>
        </div>}
        <div className="ai-form-field">
          <label htmlFor={`ai-name-${kind}`}>显示名称</label>
          <TextField.Root id={`ai-name-${kind}`} name="model-name" placeholder="选填" maxLength={80} disabled={disabled} value={draft.name}
            onChange={event => update({ name: event.target.value })} />
        </div>
        <div className="ai-form-field">
          <label htmlFor={`ai-endpoint-${kind}`}>接口地址</label>
          <TextField.Root id={`ai-endpoint-${kind}`} type="url" required disabled={disabled} value={draft.endpoint}
            placeholder="https://api.example.com/v1" onChange={event => update({ endpoint: event.target.value, key: "" })} />
        </div>
        <div className="ai-form-field">
          <label htmlFor={`ai-model-${kind}`}>模型 ID</label>
          <TextField.Root id={`ai-model-${kind}`} placeholder={kind === "local" ? "例如 llama3.2" : "填写供应商提供的模型 ID"}
            required disabled={disabled} value={draft.model} onChange={event => update({ model: event.target.value })} />
        </div>
        <div className="ai-form-field">
          <label htmlFor={`ai-key-mode-${kind}`}>API 密钥存储</label>
          <Select.Root value={draft.keyMode} disabled={disabled} onValueChange={(keyMode: Draft["keyMode"]) => update({ keyMode, key: "" })}>
            <Select.Trigger id={`ai-key-mode-${kind}`} />
            <Select.Content position="popper">
              <Select.Item value="none">无密钥</Select.Item>
              <Select.Item value="system">保存在本机</Select.Item>
            </Select.Content>
          </Select.Root>
        </div>
        {draft.keyMode === "system" && <div className="ai-form-field">
          <label htmlFor={`ai-key-${kind}`}>API 密钥</label>
          <TextField.Root id={`ai-key-${kind}`} type="password" autoComplete="off" disabled={disabled} value={draft.key}
            placeholder={keyEndpoint === draft.endpoint.trim() ? "已保存，不会显示" : "按供应商要求填写"}
            onChange={event => update({ key: event.target.value })} />
        </div>}
      </div>
      <div className="settings-footer ai-model-actions">
        <Button type="submit" disabled={disabled || !draft.model.trim() || !draft.endpoint.trim()}
          loading={working === `save-${kind}`}>{draft.id ? "保存模型" : addLabel}</Button>
        <Button type="button" variant="soft" color="gray" loading={working === `test-${kind}`}
          disabled={disabled || !draft.model.trim() || !draft.endpoint.trim()} onClick={() => {
            if (form.current?.reportValidity()) void run(kind, `test-${kind}`,
              () => desktop.testAiModel(kind, draft.id, config, key), "连接成功");
          }}>测试模型</Button>
        {draft.id && <Button type="button" variant="soft" color="gray" disabled={disabled} onClick={reset}>取消编辑</Button>}
        <div className="ai-timeout">
          <label htmlFor={`ai-timeout-${kind}`}>超时（秒）</label>
          <TextField.Root id={`ai-timeout-${kind}`} size="1" type="number" min="1" max="180" required disabled={disabled}
            value={draft.timeoutSeconds || ""} onChange={event => update({ timeoutSeconds: Number(event.target.value) })} />
        </div>
      </div>
    </form>
    {feedback}
  </>;
}
