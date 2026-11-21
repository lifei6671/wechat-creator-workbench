import { useSettingsButtonFeedback } from "./settings-button-feedback";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button, Select, Switch, Tabs, TextField } from "@radix-ui/themes";
import { desktop, errorMessage, type AiAgent, type AiModel, type AiModelKind, type AiSettings, type AiTarget } from "../desktop";
import { AiAgentIcon, agentLabels } from "./AiAgentIcon";
import { SettingRow } from "./Settings";

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

export function aiAvailability(settings: AiSettings, target = settings.preferences.defaultTarget) {
  if (!settings.preferences.enabled) return { hint: "AI 功能未启用" };
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
type Run = (group: Group, action: string, operation: () => Promise<void>) => Promise<void>;
type SaveSettings = (operation: () => Promise<AiSettings>) => Promise<void>;

export function ModelSettings({ settings, loadError, saving = false, onSave }: {
  settings?: AiSettings;
  loadError: string;
  saving?: boolean;
  onSave: SaveSettings;
}) {
  const [working, setWorking] = useState("");
  const buttons = useSettingsButtonFeedback();
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

  const run: Run = async (group, action, operation) => {
    if (!buttons.start(action)) return;
    setWorking(action);
    setFeedback(undefined);
    try {
      await operation();
      buttons.finish(action, group === "preferences" ? undefined : true);
    } catch (error) {
      buttons.finish(action, group === "preferences" ? undefined : false);
      setFeedback({ group, error: true, text: errorMessage(error) });
    } finally {
      setWorking("");
    }
  };

  function message(group: Group) {
    return <div className="action-error-slot" tabIndex={(feedback?.error && feedback.group === group) ? 0 : -1}>{feedback?.error && feedback.group === group ? <p className={`settings-feedback ${feedback.error ? "inline-error" : "muted-text"}`}
      role={feedback.error ? "alert" : "status"}>{feedback.text}</p> : null}</div>;
  }

  if (!settings) return <div className="settings-card"><p className={`settings-feedback ${loadError ? "inline-error" : "muted-text"}`}
    role={loadError ? "alert" : "status"}>{loadError || "正在读取设置…"}</p></div>;

  const disabled = saving || Boolean(working);
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
  const unavailableHint = preferences.enabled && preferences.defaultTarget ? aiAvailability(settings).hint : undefined;

  return <div className="ai-settings">
    <div className="settings-card ai-settings-card">
      <SettingRow id="ai-enabled" label="启用 AI 功能" hint="启用 AI 聊天和文档修改建议。">
        {hintId => <Switch id="ai-enabled" aria-describedby={hintId} size="2" checked={preferences.enabled} disabled={disabled}
          onCheckedChange={enabled => void run("preferences", "enabled",
            () => onSave(() => desktop.saveAiPreferences({ ...preferences, enabled })))} />}
      </SettingRow>
    </div>
    <div className="settings-card ai-settings-card ai-default-card">
      <SettingRow id="ai-default" label="默认 AI 目标"
        hint={unavailableHint ?? (preferences.defaultAgentModel
          ? `新对话默认使用 ${preferences.defaultAgentModel}。` : "用于 AI 助手默认发起的对话和写作请求。")}>
        {hintId => <Select.Root value={preferences.defaultTarget ? targetValue(preferences.defaultTarget) : "none"} disabled={disabled}
          onValueChange={value => {
            const defaultTarget = targets.find(item => targetValue(item.target) === value)?.target ?? null;
            void run("preferences", "default", () => onSave(() =>
              desktop.saveAiPreferences({ ...preferences, defaultTarget, defaultAgentModel: undefined })));
          }}>
          <Select.Trigger id="ai-default" aria-describedby={hintId} />
          <Select.Content position="popper" className="ai-default-options">
            <Select.Item value="none">未选择</Select.Item>
            {targets.map(item => <Select.Item key={targetValue(item.target)} value={targetValue(item.target)}>
              {item.label}{item.missing && <> <span className="ai-target-missing">缺失</span></>}
            </Select.Item>)}
          </Select.Content>
        </Select.Root>}
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
                  <AiAgentIcon agent={agent.id} />
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
          buttons={buttons} working={working} disabled={disabled} onSave={onSave} run={run} feedback={message(kind)} />
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

function ModelPane({ kind, models, buttons, working, disabled, onSave, run, feedback }: {
  kind: AiModelKind;
  models: AiModel[];
  buttons: ReturnType<typeof useSettingsButtonFeedback>;
  working: string;
  disabled: boolean;
  onSave: SaveSettings;
  run: Run;
  feedback: ReactNode;
}) {
  const [draft, setDraft] = useState(() => emptyDraft(kind));
  const [keyEndpoint, setKeyEndpoint] = useState<string>();
  const form = useRef<HTMLFormElement>(null);
  const addLabel = kind === "local" ? "添加本地模型" : "添加 API 模型";
  const config = { endpoint: draft.endpoint, model: draft.model, timeoutSeconds: draft.timeoutSeconds };
  const key = draft.keyMode === "none" ? (draft.id ? "" : undefined) : draft.key.trim() || undefined;
  const update = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const reset = () => { setDraft(emptyDraft(kind)); setKeyEndpoint(undefined); };

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(kind, `save-${kind}`, async () => {
      await onSave(() => desktop.saveAiModel(draft.id, kind, draft.name, config, key));
      reset();
    });
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
            <Button type="button" size="1" variant="soft" color="gray"
              aria-label={`编辑 ${labelModel(model)}`} onClick={() => void run(kind, `edit-${model.id}`, async () => {
                const hasKey = await desktop.aiModelHasKey(model.id);
                setKeyEndpoint(hasKey ? model.endpoint : undefined);
                setDraft({ ...model, preset: "", key: "", keyMode: hasKey ? "system" : "none" });
                requestAnimationFrame(() => form.current?.querySelector<HTMLInputElement>('[name="model-name"]')?.focus());
              })} {...buttons.props(`edit-${model.id}`, disabled || draft.id === model.id)}>{buttons.label(`edit-${model.id}`, "编辑", "已打开")}</Button>
            <Button type="button" size="1" variant="soft" color="gray"  loading={working === targetValue(target)}
              aria-label={`测试 ${labelModel(model)}`} onClick={() => void run(kind, targetValue(target),
                () => desktop.testAiTarget(target))} {...buttons.props(targetValue(target), disabled)}>{buttons.label(targetValue(target), "测试连接", "连接成功", "连接失败")}</Button>
            <Button type="button" size="1" variant="soft" color="red"  loading={working === `remove-${model.id}`}
              aria-label={`移除 ${labelModel(model)}`} onClick={() => void run(kind, `remove-${model.id}`, async () => {
                await onSave(() => desktop.deleteAiModel(model.id));
                if (draft.id === model.id) reset();
              })} {...buttons.props(`remove-${model.id}`, disabled)}>{buttons.label(`remove-${model.id}`, "移除", "已移除")}</Button>
          </div>
        </div>;
      })}
    </div>
    <form ref={form} className="ai-model-form" onSubmit={save} aria-label={draft.id ? "编辑模型" : addLabel}>
      <div className="ai-model-fields">
        {draft.id === null && <div className="ai-form-field">
          <label htmlFor={`ai-provider-${kind}`}>供应商</label>
          <span id={`ai-provider-${kind}-hint`} className="setting-hint">选择服务预设以填入对应的接口地址。</span>
          <Select.Root value={draft.preset} disabled={disabled} onValueChange={value => {
            const preset = presets[kind].find(preset => preset.label === value)!;
            update({ preset: value, endpoint: preset.endpoint, name: value === "自定义接口" ? "" : value, key: "" });
          }}>
            <Select.Trigger id={`ai-provider-${kind}`} aria-describedby={`ai-provider-${kind}-hint`} />
            <Select.Content position="popper">
              {presets[kind].map(preset => <Select.Item key={preset.label} value={preset.label}>{preset.label}</Select.Item>)}
            </Select.Content>
          </Select.Root>
        </div>}
        <div className="ai-form-field">
          <label htmlFor={`ai-name-${kind}`}>显示名称</label>
          <span id={`ai-name-${kind}-hint`} className="setting-hint">用于在工作台的模型列表中识别这个模型。</span>
          <TextField.Root id={`ai-name-${kind}`} aria-describedby={`ai-name-${kind}-hint`} name="model-name" placeholder="选填" maxLength={80} disabled={disabled} value={draft.name}
            onChange={event => update({ name: event.target.value })} />
        </div>
        <div className="ai-form-field">
          <label htmlFor={`ai-endpoint-${kind}`}>接口地址</label>
          <span id={`ai-endpoint-${kind}-hint`} className="setting-hint">工作台向此地址发送模型请求。</span>
          <TextField.Root id={`ai-endpoint-${kind}`} aria-describedby={`ai-endpoint-${kind}-hint`} type="url" required disabled={disabled} value={draft.endpoint}
            placeholder="https://api.example.com/v1" onChange={event => update({ endpoint: event.target.value, key: "" })} />
        </div>
        <div className="ai-form-field">
          <label htmlFor={`ai-model-${kind}`}>模型 ID</label>
          <span id={`ai-model-${kind}-hint`} className="setting-hint">指定服务端实际调用的模型。</span>
          <TextField.Root id={`ai-model-${kind}`} aria-describedby={`ai-model-${kind}-hint`} placeholder={kind === "local" ? "例如 llama3.2" : "填写供应商提供的模型 ID"}
            required disabled={disabled} value={draft.model} onChange={event => update({ model: event.target.value })} />
        </div>
        <div className="ai-form-field">
          <label htmlFor={`ai-key-mode-${kind}`}>API 密钥存储</label>
          <span id={`ai-key-mode-${kind}-hint`} className="setting-hint">使用系统凭据存储保存密钥。{draft.id && <> <span className="setting-warning">选择「无密钥」并保存会移除已保存的密钥。</span></>}</span>
          <Select.Root value={draft.keyMode} disabled={disabled} onValueChange={(keyMode: Draft["keyMode"]) => update({ keyMode, key: "" })}>
            <Select.Trigger id={`ai-key-mode-${kind}`} aria-describedby={`ai-key-mode-${kind}-hint`} />
            <Select.Content position="popper">
              <Select.Item value="none">无密钥</Select.Item>
              <Select.Item value="system">保存在本机</Select.Item>
            </Select.Content>
          </Select.Root>
        </div>
        {draft.keyMode === "system" && <div className="ai-form-field">
          <label htmlFor={`ai-key-${kind}`}>API 密钥</label>
          <span id={`ai-key-${kind}-hint`} className="setting-hint">用于验证发给模型服务的请求。</span>
          <TextField.Root id={`ai-key-${kind}`} aria-describedby={`ai-key-${kind}-hint`} type="password" autoComplete="off" disabled={disabled} value={draft.key}
            placeholder={keyEndpoint === draft.endpoint.trim() ? "已保存，不会显示" : "按供应商要求填写"}
            onChange={event => update({ key: event.target.value })} />
        </div>}
        <div className="ai-form-field ai-timeout">
          <label htmlFor={`ai-timeout-${kind}`}>超时（秒）</label>
          <span id={`ai-timeout-${kind}-hint`} className="setting-hint">等待模型响应的最长时间，超时后请求会结束。</span>
          <TextField.Root id={`ai-timeout-${kind}`} aria-describedby={`ai-timeout-${kind}-hint`} size="1" type="number" min="1" max="180" required disabled={disabled}
            value={draft.timeoutSeconds || ""} onChange={event => update({ timeoutSeconds: Number(event.target.value) })} />
        </div>
      </div>
      <div className="settings-footer ai-model-actions">
        <Button type="submit"
          loading={working === `save-${kind}`} {...buttons.props(`save-${kind}`, disabled || !draft.model.trim() || !draft.endpoint.trim())}>{buttons.label(`save-${kind}`, draft.id ? "保存模型" : addLabel, "已保存", "保存失败")}</Button>
        <Button type="button" variant="soft" color="gray" loading={working === `test-${kind}`}
           onClick={() => {
            if (form.current?.reportValidity()) void run(kind, `test-${kind}`,
              () => desktop.testAiModel(kind, draft.id, config, key));
          }} {...buttons.props(`test-${kind}`, disabled || !draft.model.trim() || !draft.endpoint.trim())}>{buttons.label(`test-${kind}`, "测试模型", "连接成功", "连接失败")}</Button>
        {draft.id && <Button type="button" variant="soft" color="gray" disabled={disabled} onClick={reset}>取消编辑</Button>}
      </div>
    </form>
    {feedback}
  </>;
}
