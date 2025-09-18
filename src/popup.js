const STORAGE_DEFAULTS = {
  apiKey: '',
  apiModel: 'gpt-3.5-turbo',
  apiEndpoint: 'https://api.openai.com/v1/chat/completions',
  suggestionCount: 3,
};

const form = document.getElementById('settings-form');
const statusEl = document.getElementById('status');

initialize();

async function initialize() {
  const values = await storageGet(Object.keys(STORAGE_DEFAULTS));
  form.apiKey.value = values.apiKey;
  form.apiModel.value = values.apiModel;
  form.apiEndpoint.value = values.apiEndpoint;
  form.suggestionCount.value = values.suggestionCount;
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
