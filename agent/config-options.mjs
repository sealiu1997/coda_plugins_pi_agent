// Model value encoding and the config options Coda shows for a session. Each select carries a
// `_meta.coda.default` choice (docs/agent-protocol.md 设置): Coda strips it from the visible list and
// switches back to it when the user picks「Pi 默认」, meaning "leave it to Pi's own default".

export function modelValue(model) {
  return `${model.provider}/${model.id}`;
}

export function parseModelValue(value) {
  const slash = value.indexOf('/');
  if (slash < 0) return { provider: value, modelId: value };
  return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

export const DEFAULT_OPTION = { value: 'default', name: 'Pi 默认', _meta: { coda: { default: true } } };
export const isDefaultSentinel = value => value === DEFAULT_OPTION.value;

export function buildConfigOptions(session) {
  const opts = [];
  // Model select
  if (session.models.length > 0 && session.currentModelValue) {
    opts.push({
      id: 'model',
      name: '模型',
      type: 'select',
      category: 'model',
      currentValue: session.currentModelValue,
      options: [
        { ...DEFAULT_OPTION },
        ...session.models.map(m => ({
          value: modelValue(m),
          name: m.name || m.id,
        })),
      ],
    });
  }
  // Thinking level select (only if model supports reasoning)
  if (session.thinkingLevels.length > 1 || (session.thinkingLevels.length === 1 && session.thinkingLevels[0] !== 'off')) {
    opts.push({
      id: 'thinking',
      name: '推理强度',
      type: 'select',
      category: 'thought_level',
      currentValue: session.currentThinkingLevel ?? 'medium',
      options: [
        { ...DEFAULT_OPTION },
        ...session.thinkingLevels.map(level => ({
          value: level,
          name: level,
        })),
      ],
    });
  }
  session.configOptions = opts;
  return opts;
}
