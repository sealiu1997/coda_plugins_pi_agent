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

// Pi's own startup defaults (docs/settings.md): `defaultProvider` + `defaultModel` name the startup
// model, `defaultThinkingLevel` the startup thinking level, and `modelThinkingLevels` overrides the
// level per exact `provider/modelId`. Project settings override agent-directory settings; resources
// like these keys are plain values, so a project value replaces the user's.
export function piDefaults(userSettings, projectSettings = {}) {
  const settings = { ...userSettings, ...projectSettings };
  const model = settings.defaultProvider && settings.defaultModel
    ? `${settings.defaultProvider}/${settings.defaultModel}`
    : null;
  const thinkingLevel = settings.modelThinkingLevels?.[model] ?? settings.defaultThinkingLevel ?? null;
  return { model, thinkingLevel };
}

export function buildConfigOptions(session) {
  const opts = [];
  // Coda matches currentValue against the options it knows; keep it inside the list.
  const inside = (options, value) => options.some(o => o.value === value) ? value : options[0]?.value;
  // Model select
  if (session.models.length > 0 && session.currentModelValue) {
    const options = [
      ...(session.defaultModelValue ? [{ ...DEFAULT_OPTION }] : []),
      ...session.models.map(m => ({
        value: modelValue(m),
        name: m.name || m.id,
      })),
    ];
    opts.push({
      id: 'model',
      name: '模型',
      type: 'select',
      category: 'model',
      currentValue: inside(options, session.currentModelValue),
      options,
    });
  }
  // Thinking level select (only if model supports reasoning)
  if (session.thinkingLevels.length > 1 || (session.thinkingLevels.length === 1 && session.thinkingLevels[0] !== 'off')) {
    const options = [
      ...(session.defaultThinkingLevel ? [{ ...DEFAULT_OPTION }] : []),
      ...session.thinkingLevels.map(level => ({
        value: level,
        name: level,
      })),
    ];
    opts.push({
      id: 'thinking',
      name: '推理强度',
      type: 'select',
      category: 'thought_level',
      currentValue: inside(options, session.currentThinkingLevel ?? 'medium'),
      options,
    });
  }
  session.configOptions = opts;
  return opts;
}
