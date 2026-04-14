/**
 * PhishEye — Popup 弹出面板逻辑
 * 状态检查 + 统计展示 + 配置管理
 */

document.addEventListener('DOMContentLoaded', () => {
  const $ = (id) => document.getElementById(id);

  const statusDot = $('statusDot');
  const statusText = $('statusText');
  const statTotal = $('statTotal');
  const statSafe = $('statSafe');
  const statSuspicious = $('statSuspicious');
  const statDangerous = $('statDangerous');
  const providerSelect = $('aiProvider');
  const modelSelect = $('aiModel');
  const apiKeyInput = $('apiKey');
  const customUrlInput = $('customUrl');
  const customModelInput = $('customModel');
  const customUrlRow = $('customUrlRow');
  const customModelRow = $('customModelRow');
  const btnSave = $('btnSave');

  // ============ 模型型号配置库 ============
  const MODEL_MAP = {
    qwen: [
      { id: 'qwen3.6-plus', name: 'Qwen-3.6-Plus' },
      { id: 'qwen3.5-plus', name: 'Qwen-3.5-Plus' },
      { id: 'qwen3.5-flash', name: 'Qwen-3.5-Flash' },
      { id: 'custom', name: '自定义模型...' }
    ],
    deepseek: [
      { id: 'deepseek-chat', name: 'DeepSeek-V3' },
      { id: 'deepseek-reasoner', name: 'DeepSeek-R1' },
      { id: 'custom', name: '自定义模型...' }
    ],
    moonshot: [
      { id: 'moonshot-v1-128k', name: 'Kimi-128k' },
      { id: 'moonshot-v1-32k', name: 'Kimi-32k' },
      { id: 'moonshot-v1-8k', name: 'Kimi-8k' },
      { id: 'custom', name: '自定义模型...' }
    ],
    zhipu: [
      { id: 'glm-4-plus', name: 'GLM-4-Plus' },
      { id: 'glm-4-0520', name: 'GLM-4-Universal' },
      { id: 'glm-4-flash', name: 'GLM-4-Flash' },
      { id: 'custom', name: '自定义模型...' }
    ],
    siliconflow: [
      { id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek-V3' },
      { id: 'deepseek-ai/DeepSeek-R1', name: 'DeepSeek-R1' },
      { id: 'Qwen/Qwen2.5-72B-Instruct', name: 'Qwen 2.5 72B' },
      { id: 'custom', name: '自定义模型...' }
    ],
    custom: [
      { id: 'custom', name: '自定义模型...' }
    ]
  };

  function updateModelOptions(providerId, selectedModel) {
    const models = MODEL_MAP[providerId] || [];
    modelSelect.innerHTML = models.map(m => `<option value="${m.id}">${m.name}</option>`).join('');
    if (selectedModel && models.some(m => m.id === selectedModel)) {
      modelSelect.value = selectedModel;
    }
    toggleCustomInputs();
  }

  function toggleCustomInputs() {
    customUrlRow.style.display = providerSelect.value === 'custom' ? 'flex' : 'none';
    customModelRow.style.display = modelSelect.value === 'custom' ? 'flex' : 'none';
  }

  providerSelect.addEventListener('change', () => {
    updateModelOptions(providerSelect.value);
  });

  modelSelect.addEventListener('change', () => {
    toggleCustomInputs();
  });

  // ============ 加载配置 ============
  chrome.storage.local.get([
    'phisheyeApiKey', 
    'phisheyeProvider', 
    'phisheyeModel',
    'phisheyeCustomUrl',
    'phisheyeCustomModel'
  ], (result) => {
    apiKeyInput.value = result.phisheyeApiKey || '';
    providerSelect.value = result.phisheyeProvider || 'qwen';
    customUrlInput.value = result.phisheyeCustomUrl || '';
    customModelInput.value = result.phisheyeCustomModel || '';
    updateModelOptions(providerSelect.value, result.phisheyeModel);
  });

  // ============ 健康检查 ============
  function checkHealth() {
    chrome.runtime.sendMessage({ type: 'CHECK_HEALTH' }, (response) => {
      if (chrome.runtime.lastError) {
        setStatus(false, 'Service Worker 未响应');
        return;
      }
      setStatus(response?.online, response?.online ? '服务已连接' : '服务未连接');
    });
  }

  function setStatus(online, text) {
    statusDot.className = `status-dot ${online ? 'online' : 'offline'}`;
    statusText.textContent = text;
  }

  // ============ 加载统计 ============
  function loadStats() {
    chrome.runtime.sendMessage({ type: 'GET_STATS' }, (response) => {
      if (chrome.runtime.lastError || !response) return;
      const s = response.stats;
      animateNumber(statTotal, s.total);
      animateNumber(statSafe, s.safe);
      animateNumber(statSuspicious, s.suspicious);
      animateNumber(statDangerous, s.dangerous);
    });
  }

  /**
   * 数字滚动动画
   */
  function animateNumber(el, target) {
    const current = parseInt(el.textContent) || 0;
    if (current === target) return;

    const duration = 400;
    const startTime = performance.now();

    function update(now) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // easeOutQuart
      const eased = 1 - Math.pow(1 - progress, 4);
      el.textContent = Math.round(current + (target - current) * eased);
      if (progress < 1) requestAnimationFrame(update);
    }
    requestAnimationFrame(update);
  }

  // ============ 保存配置 ============
  btnSave.addEventListener('click', () => {
    const key = apiKeyInput.value.trim();
    const provider = providerSelect.value;
    const model = modelSelect.value;
    const customUrl = customUrlInput.value.trim();
    const customModel = customModelInput.value.trim();

    if (!key) {
      showToast('请输入 API Key', 'error');
      return;
    }
    if (provider === 'custom' && !customUrl) {
      showToast('请输入自定义 API 地址', 'error');
      return;
    }
    if (model === 'custom' && !customModel) {
      showToast('请输入自定义模型 ID', 'error');
      return;
    }

    chrome.storage.local.set({ 
      phisheyeApiKey: key, 
      phisheyeProvider: provider,
      phisheyeModel: model,
      phisheyeCustomUrl: customUrl,
      phisheyeCustomModel: customModel
    }, () => {
      showToast('配置已保存 (即刻生效)');
      setTimeout(checkHealth, 500);
    });
  });

  // ============ 重置统计 ============
  btnReset.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'RESET_STATS' }, () => {
      loadStats();
      showToast('统计已重置');
    });
  });

  // ============ 初始化 ============
  checkHealth();
  loadStats();
});
