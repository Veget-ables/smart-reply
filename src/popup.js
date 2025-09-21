const MAX_CATEGORIES = 12;

const STORAGE_DEFAULTS = {
  apiKey: '',
  apiModel: 'gemini-2.5-flash',
  apiEndpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
  suggestionCount: 3,
  styleExamples: createDefaultStyleExamples(),
};

const tabs = Array.from(document.querySelectorAll('.tab-button'));
const panels = Array.from(document.querySelectorAll('.tab-panel'));

const form = document.getElementById('settings-form');
const statusEl = document.getElementById('status');
const categoryList = document.getElementById('categoryList');
const addCategoryBtn = document.getElementById('addCategory');
const styleStatus = document.getElementById('styleStatus');

const uiState = {
  styleExamples: createDefaultStyleExamples(),
};

const debouncedPersist = debounce(() => {
  persistStyleExamples();
}, 600);

tabs.forEach((tab) => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

initialize();

async function initialize() {
  const values = await storageGet(Object.keys(STORAGE_DEFAULTS));
  form.apiKey.value = values.apiKey;
  form.apiModel.value = values.apiModel;
  form.apiEndpoint.value = values.apiEndpoint;
  form.suggestionCount.value = values.suggestionCount;

  uiState.styleExamples = normalizeStyleExamples(values.styleExamples);
  renderCategories();
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

addCategoryBtn.addEventListener('click', () => {
  if (uiState.styleExamples.categories.length >= MAX_CATEGORIES) {
    setStyleStatus(`カテゴリは最大${MAX_CATEGORIES}件まで登録できます。`, 'error');
    return;
  }
  const name = prompt('追加するスタイルカテゴリ名を入力してください。');
  if (!name || !name.trim()) {
    return;
  }
  const category = {
    id: crypto.randomUUID(),
    name: name.trim(),
    content: '',
    useInLightning: false,
  };
  uiState.styleExamples.categories.push(category);
  renderCategories();
  persistStyleExamples('カテゴリを追加しました。');
});

function switchTab(tabName) {
  tabs.forEach((tab) => {
    tab.classList.toggle('is-active', tab.dataset.tab === tabName);
  });
  panels.forEach((panel) => {
    panel.classList.toggle('is-active', panel.dataset.panel === tabName);
  });
}

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

function setStyleStatus(message, variant) {
  styleStatus.textContent = message || '';
  styleStatus.classList.remove('status--success', 'status--error');
  if (variant === 'success') {
    styleStatus.classList.add('status--success');
  } else if (variant === 'error') {
    styleStatus.classList.add('status--error');
  }
}

function renderCategories() {
  categoryList.innerHTML = '';
  const categories = uiState.styleExamples.categories;
  if (!categories.length) {
    const empty = document.createElement('p');
    empty.className = 'helper-text';
    empty.textContent = 'まだカテゴリが登録されていません。上のボタンから追加してください。';
    categoryList.appendChild(empty);
    return;
  }

  categories.forEach((category) => {
    const item = document.createElement('div');
    item.className = 'category-item';
    item.dataset.id = category.id;

    const header = document.createElement('div');
    header.className = 'category-header';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'category-name';
    nameSpan.textContent = category.name;
    header.appendChild(nameSpan);

    const actions = document.createElement('div');
    actions.className = 'category-actions';

    const renameButton = document.createElement('button');
    renameButton.type = 'button';
    renameButton.textContent = '名称変更';
    renameButton.addEventListener('click', () => renameCategory(category.id));
    actions.appendChild(renameButton);

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.textContent = '削除';
    removeButton.addEventListener('click', () => removeCategory(category.id));
    actions.appendChild(removeButton);

    header.appendChild(actions);
    item.appendChild(header);

    const textarea = document.createElement('textarea');
    textarea.rows = 8;
    textarea.placeholder = '挨拶・本文・結びをそのまま記入してください。';
    textarea.value = category.content;
    textarea.addEventListener('input', (event) => {
      category.content = event.target.value;
      debouncedPersist();
    });
    item.appendChild(textarea);

    const lightningToggle = document.createElement('label');
    lightningToggle.className = 'category-lightning-toggle';
    const lightningCheckbox = document.createElement('input');
    lightningCheckbox.type = 'checkbox';
    lightningCheckbox.checked = Boolean(category.useInLightning);
    lightningCheckbox.addEventListener('change', () => {
      category.useInLightning = lightningCheckbox.checked;
      debouncedPersist();
    });
    lightningToggle.appendChild(lightningCheckbox);
    const toggleText = document.createElement('span');
    toggleText.textContent = 'Lightning Reply にも使用する';
    lightningToggle.appendChild(toggleText);
    item.appendChild(lightningToggle);

    categoryList.appendChild(item);
  });
}

function renameCategory(categoryId) {
  const category = findCategory(categoryId);
  if (!category) {
    return;
  }
  const name = prompt('カテゴリ名を編集してください。', category.name);
  if (!name || !name.trim()) {
    return;
  }
  category.name = name.trim();
  renderCategories();
  persistStyleExamples('カテゴリ名を更新しました。');
}

function removeCategory(categoryId) {
  const index = uiState.styleExamples.categories.findIndex((category) => category.id === categoryId);
  if (index === -1) {
    return;
  }
  const confirmation = confirm('このカテゴリと内容を削除しますか？');
  if (!confirmation) {
    return;
  }
  uiState.styleExamples.categories.splice(index, 1);
  renderCategories();
  persistStyleExamples('カテゴリを削除しました。');
}

function findCategory(id) {
  return uiState.styleExamples.categories.find((category) => category.id === id) || null;
}

function persistStyleExamples(message) {
  storageSet({ styleExamples: uiState.styleExamples }).then(() => {
    if (message) {
      setStyleStatus(message, 'success');
    } else {
      setStyleStatus('', '');
    }
  }).catch((error) => {
    const text = error instanceof Error ? error.message : '保存に失敗しました。';
    setStyleStatus(text, 'error');
  });
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

function normalizeStyleExamples(input) {
  if (input && typeof input === 'object') {
    if (Array.isArray(input.categories)) {
      const categories = input.categories
        .map((category) => normalizeCategory(category))
        .filter(Boolean)
        .slice(0, MAX_CATEGORIES);
      if (categories.length) {
        return { categories };
      }
    } else if (Array.isArray(input.audiences)) {
      const migrated = convertLegacyStyleExamples(input);
      if (migrated.categories.length) {
        return migrated;
      }
    }
  }
  return createDefaultStyleExamples();
}

function normalizeCategory(raw) {
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

function convertLegacyStyleExamples(legacy) {
  const categories = [];

  legacy.audiences.forEach((audience) => {
    (audience.scenes || []).forEach((scene) => {
      const name = typeof scene.name === 'string' && scene.name.trim()
        ? scene.name.trim()
        : typeof audience.name === 'string'
          ? audience.name.trim()
          : '';
      if (!name) {
        return;
      }
      const existing = categories.find((category) => category.name === name);
      const target = existing || {
        id: crypto.randomUUID(),
        name,
        content: '',
        useInLightning: false,
      };
      const examples = Array.isArray(scene.examples) ? scene.examples : [];
      const combined = examples
        .map((example) => {
          const parts = [];
          if (example.greeting && example.greeting.trim()) {
            parts.push(example.greeting.trim());
          }
          if (example.body && example.body.trim()) {
            parts.push(example.body.trim());
          }
          if (example.closing && example.closing.trim()) {
            parts.push(example.closing.trim());
          }
          const text = parts.join('\n\n');
          return text ? text : null;
        })
        .filter(Boolean);
      if (combined.length) {
        const block = combined.join('\n\n---\n\n');
        target.content = target.content ? `${target.content}\n\n---\n\n${block}` : block;
      }
      if (!existing) {
        categories.push(target);
      }
    });
  });

  return { categories };
}

function createDefaultStyleExamples() {
  return {
    categories: [
      {
        id: 'cat-request',
        name: '取引先への依頼',
        content: '○○テレビ ○○ディレクター様\n\nいつも○○（タレント名）をご厚遇いただきありがとうございます。\n来週の情報番組出演にあたり、当日の進行台本と衣装のカラー指定を事前にご共有いただけますでしょうか。\nスタジオ入りは放送開始60分前を予定しておりますので、台本の最新版を前日19時までにいただけると助かります。\n\nお忙しいところ恐れ入りますが、どうぞよろしくお願いいたします。',
        useInLightning: true,
      },
    ],
  };
}
