const MAX_PRESETS = 12;

const STORAGE_DEFAULTS = {
  apiKey: '',
  apiModel: 'gemini-2.5-flash',
  apiEndpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
  suggestionCount: 3,
  instructionPresets: createDefaultInstructionPresets(),
};

const form = document.getElementById('settings-form');
const statusEl = document.getElementById('status');

const uiState = {
  instructionPresets: createDefaultInstructionPresets(),
};

initialize();

async function initialize() {
  const values = await storageGet(Object.keys(STORAGE_DEFAULTS));
  form.apiKey.value = values.apiKey;
  form.apiModel.value = values.apiModel;
  form.apiEndpoint.value = values.apiEndpoint;
  form.suggestionCount.value = values.suggestionCount;

  uiState.instructionPresets = normalizeInstructionPresets(values.instructionPresets);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  setStatus('保存中…', '');
  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;

  const payload = {
    apiKey: form.apiKey.value.trim(),
    apiModel: form.apiModel.value.trim() || STORAGE_DEFAULTS.apiModel,
    apiEndpoint: form.apiEndpoint.value.trim() || STORAGE_DEFAULTS.apiEndpoint,
    suggestionCount: clampCount(form.suggestionCount.value),
  };

  try {
    await storageSet(payload);
    setStatus('保存しました。', 'success');
  } catch (error) {
    const message = error instanceof Error ? error.message : '保存に失敗しました。';
    setStatus(message, 'error');
  } finally {
    submitButton.disabled = false;
  }
});

function clampCount(value) {
  const numeric = Number(value);
  if (Number.isNaN(numeric)) {
    return STORAGE_DEFAULTS.suggestionCount;
  }
  return Math.min(5, Math.max(1, Math.round(numeric)));
}

function setStatus(message, variant) {
  statusEl.textContent = message;
  statusEl.classList.remove('status--success', 'status--error');
  if (variant === 'success') {
    statusEl.classList.add('status--success');
  } else if (variant === 'error') {
    statusEl.classList.add('status--error');
  }
}

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.get(keys, (result) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }
      resolve({ ...STORAGE_DEFAULTS, ...result });
    });
  });
}

function storageSet(values) {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.set(values, () => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }
      resolve();
    });
  });
}

function debounce(fn, delay) {
  let timer = null;
  return (...args) => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      fn(...args);
    }, delay);
  };
}

function normalizeInstructionPresets(input) {
  if (input && typeof input === 'object' && Array.isArray(input.entries)) {
    const entries = input.entries
      .map((entry) => normalizePreset(entry))
      .filter(Boolean)
      .slice(0, MAX_PRESETS);
    if (entries.length) {
      return { entries };
    }
  }

  return createDefaultInstructionPresets();
}

function normalizePreset(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : null;
  const content = typeof raw.content === 'string' ? raw.content.replace(/\s+$/u, '') : '';
  if (!name) {
    return null;
  }
  return {
    id: raw.id || crypto.randomUUID(),
    name,
    content,
    useInLightning: typeof raw.useInLightning === 'boolean' ? raw.useInLightning : false,
  };
}

function createDefaultInstructionPresets() {
  return {
    entries: [
      {
        id: 'preset-request',
        name: '取引先への依頼',
        content: '○○テレビ ○○ディレクター様\n\nいつも○○（タレント名）をご厚遇いただきありがとうございます。\n来週の情報番組出演にあたり、当日の進行台本と衣装のカラー指定を事前にご共有いただけますでしょうか。\nスタジオ入りは放送開始60分前を予定しておりますので、台本の最新版を前日19時までにいただけると助かります。\n\nお忙しいところ恐れ入りますが、どうぞよろしくお願いいたします。',
        useInLightning: true,
      },
    ],
  };
}
