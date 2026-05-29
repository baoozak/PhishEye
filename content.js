/**
 * PhishEye — Content Script
 * 职责：在 QQ 邮箱页面中抓取邮件内容 + 注入安全提示 UI
 *
 * 三层可视化反馈：
 * 1. 悬浮指示器（右下角） — 始终可见，显示插件运行状态
 * 2. 顶部通知横幅 — 分析完成后弹出，显示风险等级
 * 3. 邮件旁 Badge — 在检测到的邮件内容区域旁标注（如果选择器匹配）
 */

(() => {
  'use strict';

  // 防止在子 frame 中重复初始化 UI（只在主 frame 或邮件正文 frame 中创建悬浮 UI）
  const IS_TOP_FRAME = (window === window.top);

  // ============ 常量 ============
  const PROCESSED_ATTR = 'data-phisheye-processed';
  const BADGE_CLASS = 'phisheye-badge';
  const MIN_TEXT_LENGTH = 20;
  const DEBOUNCE_MS = 1000;
  const MAX_CONTENT_LENGTH = 5000;
  const SCAN_INTERVAL_MS = 3000; // 定时扫描间隔

  // ============ 邮件阅读区选择器（多策略）============
  const READ_SELECTORS = [
    // 经典版 mail.qq.com
    '#mailContentContainer',
    '.readmailContent',
    'div[id^="mailContent"]',
    '#contentDiv',
    // 新版 wx.mail.qq.com
    'div[class*="mail-detail"]',
    'div[class*="read-mail"]',
    'div[class*="letter-content"]',
    'div[class*="readmail"]'
  ];

  // 邮件主题选择器
  const SUBJECT_SELECTORS = [
    '.mailTitle h2', '.mail-detail__subject', 'h2[class*="subject"]',
    '#subject_content', '.readmailSubject', 'td[id="subject"]',
    'h2.mail_title', 'span[class*="subject"]',
  ];

  // 发件人选择器
  const SENDER_SELECTORS = [
    '.senderName', '.mail-detail__sender', 'span[class*="sender"]',
    '#senderAddress', 'a[class*="addr"]', 'span[class*="from"]',
  ];

  // ============ SVG 图标 ============
  const ICONS = {
    shield: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
    check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>`,
    alert: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
    danger: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
    spinner: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 12a9 9 0 11-6.219-8.56"/></svg>`,
    eye: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`,
  };

  const RISK_CONFIG = {
    safe:       { icon: ICONS.check,  label: '安全', modifier: 'safe',       emoji: '✅' },
    suspicious: { icon: ICONS.alert,  label: '可疑', modifier: 'suspicious', emoji: '⚠️' },
    dangerous:  { icon: ICONS.danger, label: '危险', modifier: 'dangerous',  emoji: '🚨' },
  };

  // ============ 工具函数 ============

  function queryFirst(selectors, root = document) {
    for (const sel of selectors) {
      try {
        const el = root.querySelector(sel);
        if (el) return el;
      } catch { /* 忽略 */ }
    }
    return null;
  }

  function cleanText(text) {
    return text.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  }

  /**
   * 智能提取邮件正文（多级 fallback）
   */
  function extractEmailContent() {
    // 隐藏我们注入的 UI，防止鼠标悬浮改变 UI 展现时影响 innerText 提取，导致计算出的指纹变化不断重刷
    const injectedUIs = document.querySelectorAll('.phisheye-badge, .phisheye-banner, #phisheye-float');
    const originalStyles = [];
    injectedUIs.forEach(el => {
      originalStyles.push(el.style.display);
      el.style.display = 'none';
    });

    let resultText = null;

    // 策略 1：精确选择器匹配
    const contentEl = queryFirst(READ_SELECTORS);
    if (contentEl) {
      const text = cleanText(contentEl.innerText || '');
      if (text.length >= MIN_TEXT_LENGTH) {
        console.log('[PhishEye] 策略1命中:', contentEl.tagName, contentEl.className?.substring(0, 50));
        resultText = text.substring(0, MAX_CONTENT_LENGTH);
      }
    }

    // 策略 2：查找最大文本块（启发式）
    if (!resultText) {
      const candidates = document.querySelectorAll('div, td');
      let best = null;
      let bestLen = 0;
      for (const el of candidates) {
        if (el.offsetHeight < 100 || el.offsetWidth < 200) continue;
        const cls = (el.className || '').toLowerCase();
        const id = (el.id || '').toLowerCase();
        if (/nav|menu|sidebar|header|footer|toolbar|tab/.test(cls + id)) continue;

        const text = cleanText(el.innerText || '');
        if (text.length > bestLen && text.length >= 50) {
          bestLen = text.length;
          best = el;
        }
      }

      if (best) {
        const text = cleanText(best.innerText || '');
        if (text.length >= MIN_TEXT_LENGTH) {
          console.log('[PhishEye] 策略2(启发式)命中:', best.tagName, best.className?.substring(0, 50), '长度:', text.length);
          best.setAttribute('data-phisheye-content-root', 'true');
          resultText = text.substring(0, MAX_CONTENT_LENGTH);
        }
      }
    }

    // 恢复我们注入的 UI
    injectedUIs.forEach((el, index) => {
      el.style.display = originalStyles[index];
    });

    return resultText;
  }

  function extractSubject() {
    const el = queryFirst(SUBJECT_SELECTORS);
    return el ? cleanText(el.innerText || '') : '';
  }

  function extractSender() {
    const el = queryFirst(SENDER_SELECTORS);
    return el ? cleanText(el.innerText || el.title || '') : '';
  }

  // ============ [层1] 悬浮触发按钮 — 始终可见 ============

  let floatingIndicator = null;

  function createFloatingIndicator() {
    if (!IS_TOP_FRAME) return; // 只在顶层 frame 创建
    if (document.getElementById('phisheye-float')) return;

    const el = document.createElement('div');
    el.id = 'phisheye-float';
    el.innerHTML = `
      <div class="phisheye-float__icon">${ICONS.eye}</div>
      <div class="phisheye-float__text">PhishEye 手动护航</div>
    `;
    
    // 添加点击事件：点一下就开始检测
    el.addEventListener('click', () => {
      // 如果处于非空闲状态且非错误状态，禁止重复点击
      if (isAnalyzing) return;
      analyzeCurrentEmail(true); // 传入 true 代表是强制手动触发
    });

    document.body.appendChild(el);
    floatingIndicator = el;
    return el;
  }

  function updateFloatingStatus(status, text) {
    if (!floatingIndicator) return;
    floatingIndicator.className = ''; // reset
    floatingIndicator.id = 'phisheye-float';
    floatingIndicator.classList.add(`phisheye-float--${status}`);
    const textEl = floatingIndicator.querySelector('.phisheye-float__text');
    if (textEl) textEl.textContent = text;
    
    // 如果不是 analyzing 状态，过 5 秒后恢复回默认的手动触发文字
    if (status !== 'idle' && status !== 'analyzing') {
      setTimeout(() => {
        if (!isAnalyzing && floatingIndicator.classList.contains(`phisheye-float--${status}`)) {
           updateFloatingStatus('idle', '再次点击检测');
        }
      }, 5000);
    }
  }

  // ============ [层2] 顶部通知横幅 — 分析完毕弹出 ============

  function showNotificationBanner(result) {
    // 在所有 frame 中都尝试显示（确保用户能看到）
    // 移除旧横幅
    document.querySelectorAll('.phisheye-banner').forEach(el => el.remove());

    const config = RISK_CONFIG[result.risk_level] || RISK_CONFIG.safe;
    const banner = document.createElement('div');
    banner.className = `phisheye-banner phisheye-banner--${config.modifier}`;
    banner.innerHTML = `
      <div class="phisheye-banner__content">
        <div class="phisheye-banner__icon">${config.icon}</div>
        <div class="phisheye-banner__info">
          <strong>PhishEye ${config.emoji} ${config.label}</strong>
          <span class="phisheye-banner__score">风险评分: ${result.score}/100</span>
        </div>
        <div class="phisheye-banner__reason">${result.reason}</div>
        <button class="phisheye-banner__close" title="关闭">✕</button>
      </div>
      <div class="phisheye-banner__details" style="display:none">
        ${result.indicators && result.indicators.length > 0 ? `
          <div class="phisheye-banner__indicators">
            <strong>风险指标：</strong>
            ${result.indicators.map(i => `<span class="phisheye-banner__tag">${i}</span>`).join('')}
          </div>
        ` : ''}
        <div class="phisheye-banner__suggestion">
          <strong>建议：</strong>${result.suggestion}
        </div>
      </div>
    `;

    // 插入到页面最顶部
    document.body.insertBefore(banner, document.body.firstChild);

    // 点击展开/收起详情
    const content = banner.querySelector('.phisheye-banner__content');
    const details = banner.querySelector('.phisheye-banner__details');
    content.addEventListener('click', (e) => {
      if (e.target.closest('.phisheye-banner__close')) return;
      details.style.display = details.style.display === 'none' ? 'block' : 'none';
    });

    // 关闭按钮
    banner.querySelector('.phisheye-banner__close').addEventListener('click', (e) => {
      e.stopPropagation();
      banner.classList.add('phisheye-banner--hiding');
      setTimeout(() => banner.remove(), 300);
    });

    // 动画入场
    requestAnimationFrame(() => banner.classList.add('phisheye-banner--visible'));

    // 安全邮件 8 秒后自动消失
    if (result.risk_level === 'safe') {
      setTimeout(() => {
        if (banner.parentNode) {
          banner.classList.add('phisheye-banner--hiding');
          setTimeout(() => banner.remove(), 300);
        }
      }, 8000);
    }
  }

  // ============ [层3] 邮件旁 Badge — 再次回归 ============
  
  function createBadge(result) {
    const config = RISK_CONFIG[result.risk_level] || RISK_CONFIG.safe;
    const badge = document.createElement('div');
    badge.className = `${BADGE_CLASS} phisheye-badge--${config.modifier}`;
    badge.innerHTML = `
      <span class="phisheye-badge__icon">${config.icon}</span>
      <span>PhishEye: ${config.label}</span>
      <div class="phisheye-detail">
        <div class="phisheye-detail__title phisheye-detail__title--${config.modifier}">
          ${config.icon} 风险评估：${config.label}（${result.score}/100）
        </div>
        <div class="phisheye-detail__score-bar">
          <div class="phisheye-detail__score-fill phisheye-detail__score-fill--${config.modifier}" style="width: ${result.score}%"></div>
        </div>
        <div class="phisheye-detail__reason">${result.reason}</div>
        ${result.indicators && result.indicators.length > 0 ? `
          <ul class="phisheye-detail__indicators">
            ${result.indicators.map(i => `<li>${i}</li>`).join('')}
          </ul>
        ` : ''}
        <div class="phisheye-detail__suggestion">${result.suggestion}</div>
      </div>
    `;
    return badge;
  }

  /**
   * 找到邮件内容容器并注入 Badge
   */
  function injectBadge(result) {
    // 先尝试精确选择器
    let container = queryFirst(READ_SELECTORS);
    // 再尝试启发式标记的容器
    if (!container) {
      container = document.querySelector('[data-phisheye-content-root]');
    }
    if (!container) {
      console.log('[PhishEye] 未找到注入容器，仅显示横幅和悬浮指示器');
      return;
    }

    // 确保容器有定位上下文
    const pos = window.getComputedStyle(container).position;
    if (pos === 'static') container.style.position = 'relative';

    // 移除旧 Badge（清理全局范围可能残留在其他 DOM 的旧按钮）
    document.querySelectorAll(`.${BADGE_CLASS}`).forEach(el => el.remove());
    container.appendChild(createBadge(result));
    console.log(`[PhishEye] Badge 已注入: ${result.risk_level} (${result.score}/100)`);
  }

  // ============ [层4] 风险热力图 — 诱导词高亮标注 ============

  /**
   * 全局唯一浮动气泡（避免插入子元素被宿主 CSS 干扰）
   */
  let globalTooltip = null;

  function ensureGlobalTooltip() {
    if (globalTooltip) return globalTooltip;
    const tip = document.createElement('div');
    tip.id = 'phisheye-tooltip';
    tip.style.cssText = `
      display:none; position:fixed; z-index:2147483647;
      min-width:160px; max-width:300px; padding:10px 14px;
      background:rgba(15,23,42,0.95); backdrop-filter:blur(8px);
      color:#fbbf24; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;
      font-size:12px; font-weight:500; line-height:1.6;
      border-radius:8px; box-shadow:0 8px 24px rgba(0,0,0,0.35);
      white-space:normal; text-align:left; pointer-events:none;
    `;
    document.body.appendChild(tip);
    globalTooltip = tip;
    return tip;
  }

  function showTooltipAt(el) {
    const tip = ensureGlobalTooltip();
    const reason = el.getAttribute('data-pe-reason');
    if (!reason) return;
    tip.textContent = `⚠ ${reason}`;
    tip.style.display = 'block';
    // 定位到高亮文字正上方
    const rect = el.getBoundingClientRect();
    tip.style.left = `${Math.max(8, rect.left + rect.width / 2 - 120)}px`;
    tip.style.top = `${rect.top - tip.offsetHeight - 8}px`;
    // 如果顶部放不下就放底部
    if (rect.top - tip.offsetHeight - 8 < 0) {
      tip.style.top = `${rect.bottom + 8}px`;
    }
  }

  function hideTooltip() {
    if (globalTooltip) globalTooltip.style.display = 'none';
  }

  /**
   * 清除上一轮留下的高亮标注
   */
  function clearHighlights() {
    document.querySelectorAll('.phisheye-hl').forEach(el => {
      const parent = el.parentNode;
      if (!parent) return;
      parent.replaceChild(document.createTextNode(el.textContent), el);
      parent.normalize();
    });
  }

  /**
   * 在邮件正文 DOM 中搜索 AI 返回的可疑片段并用荧光笔高亮
   * @param {Array} highlights - [{text, reason}, ...]
   */
  function highlightRiskyText(highlights) {
    if (!highlights || highlights.length === 0) return;

    let container = queryFirst(READ_SELECTORS);
    if (!container) {
      container = document.querySelector('[data-phisheye-content-root]');
    }
    if (!container) {
      console.log('[PhishEye] 未找到正文容器，无法注入高亮');
      return;
    }

    clearHighlights();
    let totalMarked = 0;

    highlights.forEach(({ text, reason }) => {
      if (!text || text.length < 2) return;

      const walker = document.createTreeWalker(
        container, NodeFilter.SHOW_TEXT, null
      );

      const matchNodes = [];
      let node;
      while ((node = walker.nextNode())) {
        if (node.parentElement?.closest('.phisheye-hl')) continue;
        if (node.textContent.includes(text)) {
          matchNodes.push(node);
        }
      }

      matchNodes.forEach(textNode => {
        const idx = textNode.textContent.indexOf(text);
        if (idx < 0) return;

        const before = textNode.textContent.substring(0, idx);
        const after = textNode.textContent.substring(idx + text.length);

        const hlSpan = document.createElement('span');
        hlSpan.className = 'phisheye-hl';
        hlSpan.textContent = text;
        hlSpan.setAttribute('data-pe-reason', reason);

        // 鼠标事件：悬浮显示 / 离开隐藏
        hlSpan.addEventListener('mouseenter', () => showTooltipAt(hlSpan));
        hlSpan.addEventListener('mouseleave', hideTooltip);

        const parent = textNode.parentNode;
        const frag = document.createDocumentFragment();
        if (before) frag.appendChild(document.createTextNode(before));
        frag.appendChild(hlSpan);
        if (after) frag.appendChild(document.createTextNode(after));

        parent.replaceChild(frag, textNode);
        totalMarked++;
      });
    });

    if (totalMarked > 0) {
      console.log(`[PhishEye] 风险热力图：已标注 ${totalMarked} 处可疑片段`);
    }
  }

  // ============ [层5] 增量新邮件监控与持久化缓存缓存机制 ============
  
  const scannedMailIds = new Set();
  const autoCheckedMailIds = new Set(); // 存储已匹配的 "subject|sender" 键
  let isScanningList = false;
  let isBaselineEstablished = false;

  /**
   * 智能提取字符串中的邮件 ID (mailid) — 极其强悍的特征扫描引擎
   */
  function extractMailIdFromString(str) {
    if (!str || typeof str !== 'string') return null;
    
    // 匹配以 C 或 ZC 或 PE_SIMULATE 开头的符合 QQ 邮箱 ID 特征的子串 (例如 C1234567, ZC8283-abc等)
    const match = str.match(/\b(C|ZC|PE_SIMULATE)[a-zA-Z0-9_-]{3,30}\b/);
    if (match) {
      const id = match[0];
      // 过滤常见 CSS/JS 干扰词
      if (['CSS1Compat', 'Cancel', 'Clear', 'Compose'].includes(id)) return null;
      return id;
    }
    return null;
  }

  /**
   * 提取链接中的邮件 ID (mailid) — 兼容经典版与 SPA 路由版
   */
  function extractMailIdFromHref(href, onclick) {
    const text = href + '|' + onclick;
    return extractMailIdFromString(text);
  }

  /**
   * 智能提取当前正在阅读的邮件 ID (mailid) — 主要用于发送分析载荷
   */
  function getCurrentMailId() {
    // 1. 从当前 URL 提取
    const urlParams = new URLSearchParams(window.location.search);
    let mailid = urlParams.get('mailid');
    if (mailid) return mailid;

    // 2. 从 parent window URL 提取 (如果在 iframe 中)
    try {
      const topParams = new URLSearchParams(window.top.location.search);
      mailid = topParams.get('mailid');
      if (mailid) return mailid;
    } catch (e) {
      // 忽略跨域错误
    }

    // 3. 从 hash 路由提取
    const hash = window.location.hash || '';
    const mailidFromHash = extractMailIdFromHref(hash, '');
    if (mailidFromHash) return mailidFromHash;

    // 4. 从 DOM 节点尝试（启发式，针对各种 DOM 变体）
    const readerEl = queryFirst(READ_SELECTORS);
    if (readerEl) {
      const elWithId = document.querySelector('[data-mailid]');
      if (elWithId) return elWithId.getAttribute('data-mailid');
    }

    return null;
  }

  /**
   * 静默拉取新邮件详情并投递分析
   */
  async function triggerBackgroundPreCheck(mail) {
    const { mailid, subject, sender } = mail;
    try {
      let htmlText = '';
      if (mailid && mailid.startsWith('PE_SIMULATE')) {
        console.log(`[PhishEye] 检测到测试模拟 ID: ${mailid}，跳过网络拉取，直接使用高保真模拟报文。`);
        htmlText = `
          <div id="mailContentContainer">
            <p>尊敬的用户您好，</p>
            <p>安全清退核验团队发现您的账户涉嫌洗钱及非法集资，请立即办理资金退出核验手续！</p>
            <p>请点击安全通道办理【安全核销】以完成清退：<a href="http://wx-security-bypass.net/verify">点击此处进行资金清退核验</a></p>
            <p>如逾期未办理，我们将依法冻结您的全部资金并移交司法机关处理！</p>
          </div>
        `;
      } else {
        const domain = window.location.host;
        let readUrl = `https://${domain}/cgi-bin/readmail?mailid=${mailid}`;
        console.log(`[PhishEye] 发现动态新邮件，正在静默拉取详情 HTML: ${readUrl}`);
        let res = await fetch(readUrl);
        if (!res.ok && domain.includes('wx.mail.qq.com')) {
          const fallbackUrl = `https://mail.qq.com/cgi-bin/readmail?mailid=${mailid}`;
          console.log(`[PhishEye] wx.mail.qq.com 返回 ${res.status}，尝试 Fallback 到 mail.qq.com: ${fallbackUrl}`);
          res = await fetch(fallbackUrl);
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        htmlText = await res.text();
      }

      // 用 DOMParser 解析邮件正文
      const parser = new DOMParser();
      const doc = parser.parseFromString(htmlText, 'text/html');

      // 强力净化：移除所有 script 和 style 标签，防止提取到邮箱系统的底座 JS 配置代码或 CSS 干扰 AI 判定！
      doc.querySelectorAll('script, style').forEach(el => el.remove());

      // 使用 READ_SELECTORS 提取内容
      let contentText = '';
      for (const sel of READ_SELECTORS) {
        const el = doc.querySelector(sel);
        if (el) {
          contentText = cleanText(el.innerText || '');
          if (contentText.length >= MIN_TEXT_LENGTH) break;
        }
      }

      if (contentText.length < MIN_TEXT_LENGTH) {
        contentText = cleanText(doc.body.innerText || '');
      }

      contentText = contentText.substring(0, MAX_CONTENT_LENGTH);

      if (contentText.length < MIN_TEXT_LENGTH) {
        console.warn(`[PhishEye] 新邮件内容拉取成功但正文过短，跳过分析。ID: ${mailid}`);
        return;
      }

      console.log(`[PhishEye] 新邮件正文抓取完毕 (长度: ${contentText.length})，正在后台投递 AI 核验...`);
      
      const response = await chrome.runtime.sendMessage({
        type: 'ANALYZE_EMAIL',
        payload: {
          content: contentText,
          subject: subject || mail.subject,
          sender: sender || mail.sender,
          mailid: mailid
        }
      });

      if (response && response.success) {
        console.log(`[PhishEye] 后台静默检测完成并成功持久化缓存！ID: ${mailid}, 风险等级: ${response.data.risk_level}`);
      } else {
        console.warn(`[PhishEye] 后台静默检测 API 失败:`, response?.error);
      }
    } catch (e) {
      console.error(`[PhishEye] 静默拉取邮件详情发生异常:`, e.message);
    }
  }

  /**
   * 扫描邮件列表，建立 Baseline 并仅监控新进邮件
   */
  async function scanEmailList() {
    // 检查是否开启了后台自动检测
    const autoBgEnabled = await new Promise(resolve => {
      chrome.storage.local.get(['phisheyeAutoBgDetect'], res => {
        resolve(res.phisheyeAutoBgDetect !== false);
      });
    });
    if (!autoBgEnabled) return;

    if (isScanningList) return;
    isScanningList = true;

    try {
      const discoveredMails = [];
      const seenIdsInThisScan = new Set();

      // 定义统一的信息添加函数
      function addDiscovered(mailid, element) {
        if (!mailid || seenIdsInThisScan.has(mailid)) return;
        seenIdsInThisScan.add(mailid);

        if (scannedMailIds.has(mailid)) return;

        const row = element.closest('tr') || element.closest('li') || element.closest('div[class*="item"]') || element.closest('div[class*="row"]') || element.parentElement;
        let subject = '';
        let sender = '';
        
        if (row) {
          const titleEl = row.querySelector('.tt, .subject, [class*="subject"], [class*="title"], a[title]');
          subject = titleEl ? (titleEl.innerText || titleEl.getAttribute('title') || '') : '';
          const senderEl = row.querySelector('.to, .sender, [class*="sender"], [class*="name"], td[width="150"]');
          sender = senderEl ? (senderEl.innerText || senderEl.title || '') : '';
        }
        if (!subject) subject = element.innerText || '';

        discoveredMails.push({ mailid, subject: cleanText(subject), sender: cleanText(sender) });
      }

      // 全量扫描策略：扫描页面上所有的 input, a, div, span, tr, li 元素！
      // 这是一个极其强悍的主动探索特征抓取引擎
      const elements = document.querySelectorAll('input, a, div[data-id], div[data-mailid], li[data-id], tr[data-id], span[data-id]');
      elements.forEach(el => {
        const attrs = ['value', 'href', 'onclick', 'data-id', 'data-mailid', 'data-uid', 'id'];
        for (const attr of attrs) {
          const val = el.getAttribute(attr);
          if (val) {
            const mailid = extractMailIdFromString(val);
            if (mailid) {
              addDiscovered(mailid, el);
              break; 
            }
          }
        }
      });

      // 首次扫描且列表已渲染出来：建立 Baseline 基线，防止把已有未读邮件全扫一遍
      if (discoveredMails.length > 0 && !isBaselineEstablished) {
        discoveredMails.forEach(m => scannedMailIds.add(m.mailid));
        console.log(`[PhishEye] 已成功建立邮件列表基线，录入已有历史邮件: ${scannedMailIds.size} 封。这些历史邮件不会发起后台检测。`);
        isBaselineEstablished = true;
        isScanningList = false;
        return;
      }

      // 后续扫描：发现真正的增量新邮件并静默检测
      if (isBaselineEstablished && discoveredMails.length > 0) {
        discoveredMails.forEach(mail => {
          if (!scannedMailIds.has(mail.mailid)) {
            scannedMailIds.add(mail.mailid);
            console.log(`[PhishEye] 🚨 监控到增量新邮件！ID: ${mail.mailid}，启动静默检测管线...`);
            triggerBackgroundPreCheck(mail);
          }
        });
      }
    } catch (e) {
      console.warn('[PhishEye] 扫描邮件列表失败:', e);
    } finally {
      isScanningList = false;
    }
  }

  /**
   * 自动检测当前打开的邮件并优先匹配缓存（无感载入）
   * 升级：采用“主题 + 发件人”双重内容检索匹配，完美适配无 URL 变化的 SPA 架构
   */
  async function autoCheckOpenedEmail() {
    // 核心防护：确保当前页面上确实渲染了邮件阅读容器（防止在收件箱列表页误判触发）
    const readerEl = queryFirst(READ_SELECTORS);
    if (!readerEl) {
      // 处于列表页，立即清除可能残存的横幅和 Badge 状态并重置
      document.querySelectorAll('.phisheye-banner, .phisheye-badge').forEach(el => el.remove());
      if (IS_TOP_FRAME) {
        updateFloatingStatus('idle', '点击开始检测');
      }
      autoCheckedMailIds.clear(); // 退出详情页时释放已检测 Key，确保二次进入同一封邮件时能够重新匹配并渲染！
      return;
    }

    const subject = extractSubject();
    const sender = extractSender();

    if (!subject && !sender) return;

    // 用主题+发件人作为当前页面生命周期的排重 Key
    const openKey = `${subject}|${sender}`;
    if (autoCheckedMailIds.has(openKey)) return;
    autoCheckedMailIds.add(openKey);

    console.log('[PhishEye] 智能检测到当前打开邮件：', { subject, sender });

    // 从本地存储获取所有持久化缓存进行内容指纹扫描
    chrome.storage.local.get(null, (allData) => {
      let cachedData = null;

      for (const key in allData) {
        if (key.startsWith('phisheye_cache_')) {
          const item = allData[key];
          // 容错匹配：如果主题完全相同，且发件人互相包含
          if (item && item.subject === subject && (item.sender.includes(sender) || sender.includes(item.sender))) {
            cachedData = item;
            break;
          }
        }
      }

      if (cachedData) {
        console.log('[PhishEye] ⚡ 发现匹配的持久缓存，零延迟瞬间加载结果！主题:', subject);
        
        if (IS_TOP_FRAME) {
          updateFloatingStatus(cachedData.risk_level, `PhishEye: ${RISK_CONFIG[cachedData.risk_level]?.label || '完成'}`);
        }
        showNotificationBanner(cachedData);
        injectBadge(cachedData);
        highlightRiskyText(cachedData.highlights);
      } else {
        console.log('[PhishEye] 未发现匹配缓存，启动实时安全检测管线...');
        analyzeCurrentEmail(false);
      }
    });
  }

  /**
   * 启动实时列表监控器
   */
  function startListMonitor() {
    // 1. 定期轮询扫描作为坚固兜底
    setInterval(scanEmailList, SCAN_INTERVAL_MS);

    // 2. MutationObserver 实时捕捉增量 DOM 渲染
    const observer = new MutationObserver(() => {
      scanEmailList();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    // 3. 首次加载瞬间执行一次建立基线
    scanEmailList();
  }

  // ============ 核心分析流程 ============

  let lastFingerprint = '';
  let isAnalyzing = false;

  async function analyzeCurrentEmail(isManual = false) {
    if (isAnalyzing) return;

    const content = extractEmailContent();
    if (!content) {
      if (IS_TOP_FRAME) {
        updateFloatingStatus('error', '未找到邮件正文');
        setTimeout(() => updateFloatingStatus('idle', '点击开始检测'), 3000);
      }
      return;
    }

    const subject = extractSubject();
    const sender = extractSender();

    if (!subject && !sender) {
      if (IS_TOP_FRAME) {
        updateFloatingStatus('error', '找不到发件人, 无法检测');
        setTimeout(() => updateFloatingStatus('idle', '点击开始检测'), 3000);
      }
      return;
    }

    // 终极去重逻辑：如果是手动点击强制触发，直接无视历史指纹
    const currentFingerprint = `${location.href}|${subject}|${sender}`;
    if (!isManual && currentFingerprint === lastFingerprint) return;

    lastFingerprint = currentFingerprint;
    isAnalyzing = true;

    console.log('[PhishEye] 开始分析邮件:', {
      subject: subject.substring(0, 50) || '(无主题)',
      sender: sender || '(未知)',
      contentLength: content.length,
    });

    if (IS_TOP_FRAME) updateFloatingStatus('analyzing', 'PhishEye 分析中...');

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'ANALYZE_EMAIL',
        payload: { 
          content, 
          subject, 
          sender, 
          mailid: getCurrentMailId() 
        },
      });

      if (response && response.success) {
        const result = response.data;
        console.log('[PhishEye] 分析结果:', result);

        // 三层反馈全部触发
        if (IS_TOP_FRAME) {
          updateFloatingStatus(result.risk_level, `PhishEye: ${RISK_CONFIG[result.risk_level]?.label || '完成'}`);
        }
        showNotificationBanner(result);
        injectBadge(result);
        highlightRiskyText(result.highlights);
      } else {
        console.warn('[PhishEye] 后端返回失败:', response?.error);
        if (IS_TOP_FRAME) updateFloatingStatus('error', 'PhishEye: 分析失败');
        showNotificationBanner({
          risk_level: 'suspicious',
          score: 0,
          reason: `分析请求失败: ${response?.error || '未知错误'}。请检查后端是否启动。`,
          indicators: [],
          suggestion: '请确认后端服务运行在 http://localhost:8000',
        });
      }
    } catch (error) {
      console.error('[PhishEye] 通信异常:', error.message);
      if (IS_TOP_FRAME) updateFloatingStatus('error', 'PhishEye: 连接失败');
    } finally {
      isAnalyzing = false;
    }
  }

  // ============ 初始化 ============

  let lastOpenedMailKey = '';
  /**
   * 启动实时邮件打开监控器 (针对无 URL 变化的 SPA 架构)
   */
  function startOpenEmailMonitor() {
    const observer = new MutationObserver(() => {
      const readerEl = queryFirst(READ_SELECTORS);
      if (!readerEl) {
        // 处于列表页，清理并重置状态，防止在主页渲染详情数据
        document.querySelectorAll('.phisheye-banner, .phisheye-badge').forEach(el => el.remove());
        if (IS_TOP_FRAME && floatingIndicator && !floatingIndicator.classList.contains('phisheye-float--idle')) {
          updateFloatingStatus('idle', '点击开始检测');
        }
        lastOpenedMailKey = '';
        autoCheckedMailIds.clear(); // 退出详情页时彻底清空指纹排重集，解决二次进入不渲染的 SPA 顽疾！
        return;
      }

      const subject = extractSubject();
      const sender = extractSender();
      
      if (subject || sender) {
        const mailKey = `${subject}|${sender}`;
        if (mailKey !== lastOpenedMailKey) {
          lastOpenedMailKey = mailKey;
          console.log('[PhishEye] 侦听到邮件详情 DOM 渲染，自动触发安全检测。主题:', subject);
          autoCheckOpenedEmail();
        }
      } else {
        lastOpenedMailKey = '';
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function init() {
    console.log('[PhishEye] Content Script 已加载 (自动/手动混合模式)');
    
    // 仅在最顶层页面渲染检测按钮
    if (IS_TOP_FRAME) {
      createFloatingIndicator();
      updateFloatingStatus('idle', '点击此处开始检测');
    }

    // 智能分析当前打开的邮件（优先匹配缓存）
    autoCheckOpenedEmail();

    // 开启列表监控
    startListMonitor();

    // 开启打开邮件实时监控器 (解决微信邮箱等 SPA 架构无 URL 变化的痛点)
    startOpenEmailMonitor();

    // SPA 路由切换监听，保证路由切换时能瞬间分析
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        console.log('[PhishEye] 发现页面路由变化 (SPA)，清空历史扫描并重新匹配...');
        isBaselineEstablished = false;
        scannedMailIds.clear();
        autoCheckedMailIds.clear();
        autoCheckOpenedEmail();
      }
    }, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
