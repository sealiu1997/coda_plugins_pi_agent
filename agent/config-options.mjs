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

// Pi has no approval modes, but Coda keeps a session's agent, model and effort as a shortcut for the next new session
// only when it has a mode; without one every new Pi session starts with its effort unchosen. One fixed mode gives it one.
export const PI_MODE = 'pi';
export const MODE_OPTION = { id: 'mode', name: '工作模式', type: 'select', category: 'mode', currentValue: PI_MODE,
  options: [{ value: PI_MODE, name: '默认' }] };

export function buildConfigOptions(session) {
  const opts = [{ ...MODE_OPTION, options: MODE_OPTION.options.map(o => ({ ...o })) }];
  // Model select
  if (session.models.length > 0 && session.currentModelValue) {
    const options = [
      ...(session.defaultModelValue ? [{ ...DEFAULT_OPTION }] : []),
      ...session.models.map(m => ({
        value: modelValue(m),
        name: m.name || m.id,
      })),
    ];
    // Coda matches currentValue against the options it knows; if Pi is on a model no longer listed,
    // append it under its own name rather than misreporting it as a listed choice.
    if (!options.some(o => o.value === session.currentModelValue)) {
      options.push({ value: session.currentModelValue, name: session.currentModelValue });
    }
    opts.push({
      id: 'model',
      name: '模型',
      type: 'select',
      category: 'model',
      currentValue: session.currentModelValue,
      options,
    });
  }
  // Thinking level select (only if model supports reasoning)
  if (session.thinkingLevels.length > 1 || (session.thinkingLevels.length === 1 && session.thinkingLevels[0] !== 'off')) {
    // The stored thinking level belongs to the baseline model; another model has its own default.
    const onBaselineModel = !session.defaultModelValue || session.currentModelValue === session.defaultModelValue;
    const options = [
      ...(session.defaultThinkingLevel && onBaselineModel ? [{ ...DEFAULT_OPTION }] : []),
      ...session.thinkingLevels.map(level => ({
        value: level,
        name: level,
      })),
    ];
    const current = session.currentThinkingLevel ?? 'medium';
    if (!options.some(o => o.value === current)) {
      options.push({ value: current, name: current });
    }
    opts.push({
      id: 'thinking',
      name: '推理强度',
      type: 'select',
      category: 'thought_level',
      currentValue: current,
      options,
    });
  }
  session.configOptions = opts;
  return opts;
}
