/**
 * PhishEye — Service Worker (后台脚本)
 * 职责：代理 Content Script 与 FastAPI 后端之间的通信，提供内存缓存
 */

// ============ 配置 ============
const PROVIDERS = {
  qwen: {
    url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    model: 'qwen-plus'
  },
  deepseek: {
    url: 'https://api.deepseek.com/v1/chat/completions',
    model: 'deepseek-chat'
  },
  moonshot: {
    url: 'https://api.moonshot.cn/v1/chat/completions',
    model: 'moonshot-v1-8k'
  },
  zhipu: {
    url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    model: 'glm-4'
  },
  siliconflow: {
    url: 'https://api.siliconflow.cn/v1/chat/completions',
    model: 'default'
  }
};
const CACHE_MAX_SIZE = 200;   // 最大缓存条目数
const CACHE_TTL_MS = 30 * 60 * 1000; // 缓存 30 分钟

// ============ 拦截字典 ============
const ABSOLUTE_BLACKLIST = [
  "办理资金退出", 
  "法院传票已被冻结", 
  "涉嫌洗黑钱及妨碍司法", 
  "你的私密视频已被我录下", 
  "需要验证您的恢复短语",
  "请输入您的助记词",
  "你的邮箱马上就要被封禁",
  "请立即转账到所谓的安全账户",
  "涉嫌洗钱及非法集资",
  "公安局要求配合调查并转账",
  "资金归集至中国人民银行安全账户"
];

// ============ System Prompt ============
const SYSTEM_PROMPT = `你是 PhishEye —— 一个专业的网络安全威胁分析助手，专注于识别钓鱼邮件。

## 你的任务
分析用户提供的邮件内容，判断其是否为钓鱼/诈骗邮件，并给出详细的风险评估。

## 分析维度
1. **发件人伪装**：是否冒充知名公司、政府机构、领导等
2. **紧急性诱导**：是否使用"紧急""立即""限时"等施压话术
3. **链接可疑性**：是否包含与正文描述不匹配的链接、缩短链接、IP 地址链接
4. **敏感信息索取**：是否要求提供密码、银行卡号、验证码等
5. **附件风险**：是否诱导下载不明附件
6. **语法/格式异常**：是否有明显的翻译痕迹或格式错误
7. **奖励/恐吓诱饵**：是否声称中奖、账号异常、法律威胁等

## 降低误报及安全判定原则（非常重要！）
- 许多合法邮件（如：产品注册确认、双因素认证、系统通知、账单推送、服务协议更新）本来就是**机器自动发送的模板邮件**。
- **绝对禁止**因为“内容简短”、“缺乏个性化称呼”、“缺少签名/公司地址”或“存在模板化特征”而判定为可疑 (suspicious)。这属于极度错误的误判！
- **绝对禁止盲目“打假”与版权核查**：大语言模型极易在影视剧版权、新产品发布等专业知识上产生幻觉！**绝对不允许**你去分析“某公司是否拥有某版权”、“HBO有没有拍哈利波特”。请单纯从网络安全特征（如要求索要密码、明显的黑客跳板域名）去评估。若只是一般的营销推广（即使你认为包含版权错误），只要是官方正常域名发出的，一律判定为 "safe"。
- 只要发件人域名（如 github.com, wbgames.com 等大厂域名）看起来是官方域名的子域，哪怕通过代发平台发送，请直接相信其源头的合法性，给出满分的 "safe" 判定，不要怀疑邮件中提到的剧集或产品是否存在。
- "危险 (dangerous)" 或 "可疑 (suspicious)" 必须且只能基于硬核的欺诈证据：例如发件人域名拼写伪造（githud.com）、邮件中包含毫不相干的跳板链接/短链接/IP地址、在没有用户前置操作的情况下突兀索要密码等。

## 输出要求
严格按以下 JSON 格式输出，不要包含任何其他文字。
注意：无论邮件正文是什么语言，JSON 中的 reason、indicators、suggestion、highlights 字段**必须使用中文 (Chinese)** 输出！
{
  "risk_level": "safe 或 suspicious 或 dangerous",
  "score": 0到100的整数,
  "reason": "一句话简要说明判断理由（必须用中文）",
  "indicators": ["具体的风险指标1（必须用中文）", "风险指标2"],
  "suggestion": "给用户的一句话安全建议（必须用中文）",
  "highlights": [
    {"text": "邮件正文中需要高亮标注的原始可疑片段（必须是正文中存在的原文）", "reason": "该片段可疑的具体原因（用中文）"},
    {"text": "另一个可疑片段原文", "reason": "原因"}
  ]
}

## highlights 字段的特殊规则（极其重要！）
- highlights 用于在邮件正文中高亮标注可疑的诱导性词句。
- 每个 highlight 的 text 字段**必须是邮件正文中能精确匹配到的原文片段**（不要自己编造或翻译）。
- 典型的高亮对象：施压话术（"紧急"、"立即"、"限时"）、可疑链接文本、索要密码/验证码的句子、虚假中奖信息、威胁恐吓语句等。
- 如果邮件是 safe 的，highlights 应为空数组 []。
- 每封邮件最多标注 8 个关键片段。片段长度建议在 4~40 个字符。

## 评分标准
- **0-30 (safe)**：正常邮件、通知、营销、注册确认等合法邮件
- **31-65 (suspicious)**：存在一些异常特征但证据不足，需要提醒用户注意
- **66-100 (dangerous)**：明显欺诈嫌疑，诱导敏感操作、伪装官方
`;

const EVALUATOR_PROMPT = `你是一个严厉的评审员（Critic）。用户会给你发送一封邮件的【原始文本】以及【上一个AI生成的结果 JSON】。
你的任务是检查该结果是否合格。
检查标准：
1. highlights 字段中的 text 必须是能从【原始文本】中完全精确匹配的原文。如果它不存在于原文，或者是被翻译/总结/删改过后的句子，就不合格。
2. 如果风险评分 (score) 给到了 65 分以上(dangerous)，但原文中根本没有任何强有力的欺诈证据（如带链接、要密码、要求汇款等），纯属夸大其词，则不合格。
3. 结果必须符合指定的 JSON 结构。

请严格仅输出以下 JSON：
{ "approved": true或false, "feedback": "如果不合格的详细理由，指出错在哪里。如果合格则留空。" }
`;

// ============ 内存缓存 ============
const analysisCache = new Map();

/**
 * 生成缓存键（对邮件文本取简单 hash）
 */
function hashText(text) {
  let hash = 0;
  const str = text.substring(0, 500); // 只取前 500 字符作为 key
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return hash.toString(36);
}

/**
 * 缓存查找
 */
function getCached(key) {
  const entry = analysisCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    analysisCache.delete(key);
    return null;
  }
  return entry.data;
}

/**
 * 写入缓存（自动淘汰旧条目）
 */
function setCache(key, data) {
  if (analysisCache.size >= CACHE_MAX_SIZE) {
    const oldest = analysisCache.keys().next().value;
    analysisCache.delete(oldest);
  }
  analysisCache.set(key, { data, timestamp: Date.now() });
}

// ============ 统计计数 ============
let stats = { total: 0, safe: 0, suspicious: 0, dangerous: 0 };

function updateStats(riskLevel) {
  stats.total++;
  if (stats[riskLevel] !== undefined) {
    stats[riskLevel]++;
  }
  // 持久化到 storage
  chrome.storage.local.set({ phisheyeStats: stats });
}

// 启动时加载统计
chrome.storage.local.get('phisheyeStats', (result) => {
  if (result.phisheyeStats) {
    stats = result.phisheyeStats;
  }
});

// ============ API 调用 ============

/**
 * 获取 API 认证信息和选定的服务商
 */
async function getApiConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get([
      'phisheyeApiKey', 
      'phisheyeProvider', 
      'phisheyeModel',
      'phisheyeCustomUrl',
      'phisheyeCustomModel'
    ], (result) => {
      resolve({
        apiKey: result.phisheyeApiKey || null,
        providerId: result.phisheyeProvider || 'qwen',
        modelId: result.phisheyeModel || null,
        customUrl: result.phisheyeCustomUrl || null,
        customModel: result.phisheyeCustomModel || null
      });
    });
  });
}

/**
 * 提取并解析大模型返回的 JSON
 */
function parseAiResponse(text) {
  let cleaned = text.trim();
  if (cleaned.startsWith('\`\`\`')) {
    const lines = cleaned.split('\\n');
    const jsonLines = [];
    let inside = false;
    for (const line of lines) {
      if (line.trim().startsWith('\`\`\`') && !inside) { inside = true; continue; }
      else if (line.trim().startsWith('\`\`\`') && inside) { break; }
      else if (inside) { jsonLines.push(line); }
    }
    cleaned = jsonLines.join('\\n');
  }
  return JSON.parse(cleaned);
}

/**
 * 直接调用大语言模型进行纯前端验证
 */
async function analyzeEmail(payload) {
  const cacheKey = hashText(payload.content);
  const cached = getCached(cacheKey);
  if (cached) {
    console.log('[PhishEye] 命中缓存:', cacheKey);
    return cached;
  }

  // 1. 本地绝对黑名单前置拦截
  const emailTextFull = `${payload.subject} ${payload.sender} ${payload.content}`;
  for (const phrase of ABSOLUTE_BLACKLIST) {
    if (emailTextFull.includes(phrase)) {
      console.log(`[PhishEye] 命中绝对黑名单: ${phrase}`);
      const hardcodedResult = {
        risk_level: "dangerous",
        score: 100,
        reason: "触发本地最高安全级别黑名单防御拦截。",
        indicators: [`由于包含了极其典型的诈骗诱导短语（“${phrase}”），系统已直接高危拦截。`],
        suggestion: "这绝对是一封欺诈/钓鱼邮件，请立刻彻底删除，绝对不要点击任何链接或回复！",
        highlights: []
      };
      setCache(cacheKey, hardcodedResult);
      updateStats('dangerous');
      return hardcodedResult;
    }
  }

  const config = await getApiConfig();
  if (!config.apiKey) {
    throw new Error('未配置 API Key。请点击右上角插件图标填写模型服务的 API Key。');
  }

  const providerConf = PROVIDERS[config.providerId] || { url: '', model: '' };
  
  // 确定最终使用的 URL 和 Model
  const finalUrl = config.providerId === 'custom' ? config.customUrl : providerConf.url;
  const finalModel = config.modelId === 'custom' ? config.customModel : (config.modelId || providerConf.model);

  if (!finalUrl) {
    throw new Error('未配置有效的 API 地址');
  }

  let userPrompt = '';
  if (payload.subject) userPrompt += `邮件主题：${payload.subject}\n`;
  if (payload.sender) userPrompt += `发件人：${payload.sender}\n`;
  userPrompt += `邮件正文：\n${payload.content}`;

  const MAX_RETRIES = 1; // 优化耗时：最高只允许重试 1 次，否则坚决阻断死循环
  let retryCount = 0;
  let result = null;
  let conversationHistory = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userPrompt }
  ];

  while (retryCount <= MAX_RETRIES) {
    const requestBody = {
      model: finalModel,
      messages: conversationHistory,
      temperature: 0.1
    };

    const response = await fetch(finalUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(`请求失败: ${response.status} - ${errData.message || response.statusText}`);
    }

    const resultData = await response.json();
    const aiText = resultData.choices[0].message.content;
    
    try {
      result = parseAiResponse(aiText);
    } catch (e) {
      console.warn('[PhishEye] JSON解析失败, 准备重试:', aiText);
      if (retryCount < MAX_RETRIES) {
        retryCount++;
        conversationHistory.push({ role: "assistant", content: aiText });
        conversationHistory.push({ role: "user", content: "返回格式错误，未符合 JSON 格式约束，请纠正后重新输出严格的 JSON。" });
        continue;
      } else {
        throw new Error('大模型未能返回有效的 JSON 格式结果。');
      }
    }

    // [优化1: 本地极速幻觉清除] 
    // 不需要劳驾大模型，用一行代码本地过滤掉在原文中找不到的高亮词（幻觉）
    if (result.highlights) {
      result.highlights = result.highlights.filter(hl => hl.text && emailTextFull.includes(hl.text));
    }

    // [优化2: 条件触发审查]
    // 如果大模型认为是安全(safe)或轻微可疑(suspicious)，没必要浪费时间自我审查，直接秒回结果
    if (result.risk_level !== 'dangerous') {
      console.log(`[PhishEye] 判定为非高危 (${result.risk_level})，跳过审查机制直接放行。`);
      break; 
    }

    // 2. 双重 AI 审查 (仅对 dangerous 的判定进行死磕复核，防误杀)
    const evalUserPrompt = `
【原始邮件全文】
${emailTextFull}

【上一个AI生成的结果 JSON】
${JSON.stringify(result, null, 2)}
    `;

    try {
      const evalResponse = await fetch(finalUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`
        },
        body: JSON.stringify({
          model: finalModel,
          messages: [
            { role: "system", content: EVALUATOR_PROMPT },
            { role: "user", content: evalUserPrompt }
          ],
          temperature: 0.1
        }),
      });

      if (evalResponse.ok) {
        const evalData = await evalResponse.json();
        const evalJSON = parseAiResponse(evalData.choices[0].message.content);
        
        if (evalJSON.approved) {
          console.log(`[PhishEye] AI结果审查通过 (尝试次数: ${retryCount + 1})`);
          break; // 合格，立刻退出循环
        } else {
          console.warn(`[PhishEye] 审判被驳回，理由：${evalJSON.feedback}`);
          if (retryCount < MAX_RETRIES) {
            retryCount++;
            conversationHistory.push({ role: "assistant", content: aiText });
            conversationHistory.push({ role: "user", content: `你的判定未通过内部审核。理由：${evalJSON.feedback}。请收敛你的分数，客观公正地重新评估。` });
            continue;
          } else {
            console.warn(`[PhishEye] 重试耗尽，降级使用原结果。`);
            // 即便耗尽，如果之前确实是误判，这里可以考虑做一次强行降分兜底，为了简单先原样放行
            break; 
          }
        }
      } else {
        // Evaluator API 调用出错，不阻断主流程，直接信任第一次的结果
        console.warn(`[PhishEye] 审核API出错，放行原结果。`);
        break;
      }
    } catch (e) {
      console.error(`[PhishEye] Eval执行异常，放行原结果:`, e);
      break;
    }
  }

  setCache(cacheKey, result);
  updateStats(result.risk_level);
  return result;
}

/**
 * 检查后端健康状态（此处改为检查 API Key 是否存在）
 */
async function checkHealth() {
  const config = await getApiConfig();
  return !!config.apiKey;
}

// ============ 消息监听 ============
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'ANALYZE_EMAIL') {
    analyzeEmail(message.payload)
      .then((result) => sendResponse({ success: true, data: result }))
      .catch((error) => {
        console.error('[PhishEye] 分析失败:', error.message);
        sendResponse({ success: false, error: error.message });
      });
    return true; // 保持消息通道开启（异步响应）
  }

  if (message.type === 'CHECK_HEALTH') {
    checkHealth()
      .then((ok) => sendResponse({ online: ok }))
      .catch(() => sendResponse({ online: false }));
    return true;
  }

  if (message.type === 'GET_STATS') {
    sendResponse({ stats });
    return false;
  }

  if (message.type === 'RESET_STATS') {
    stats = { total: 0, safe: 0, suspicious: 0, dangerous: 0 };
    chrome.storage.local.set({ phisheyeStats: stats });
    sendResponse({ stats });
    return false;
  }
});

console.log('[PhishEye] Service Worker 已启动');
