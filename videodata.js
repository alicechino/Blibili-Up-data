// ==UserScript==
// @name         B站视频播放量和互动量数据
// @version      3.3.1
// @description  辅助查看B站视频播放量、互动量，仅保留右下角浮窗
// @author       alicechino
// @namespace    https://github.com/alicechino/Blibili-Up-data/
// @match        *://www.bilibili.com/video/*
// @include      *://www.bilibili.com/video/*
// @icon         https://static.hdslb.com/images/favicon.ico
// @grant        GM_setClipboard
// @run-at       document-end
// @license      MPL-2.0
// ==/UserScript==

(function () {
  'use strict';

  const API = {
    view: 'https://api.bilibili.com/x/web-interface/view',
    archiveStat: 'https://api.bilibili.com/x/web-interface/archive/stat',
    relation: 'https://api.bilibili.com/x/relation/stat',
    tags: 'https://api.bilibili.com/x/tag/archive/tags',
  };

  const CONFIG = {
    autoRefreshSeconds: 0,
    showInlineInVideoInfo: false,
  };

  let lastVideoKey = '';
  let currentData = null;
  let running = false;

  injectStyle();
  createPanel();
  watchUrlChange();
  start();

  if (CONFIG.autoRefreshSeconds > 0) {
    setInterval(() => {
      const id = getVideoIdFromUrl();
      if (id) loadVideoData(true);
    }, CONFIG.autoRefreshSeconds * 1000);
  }

  function start() {
    loadVideoData(false);
  }

  async function loadVideoData(silent = false) {
    if (running) return;

    const id = getVideoIdFromUrl();
    if (!id) {
      renderError('没有识别到 BV 号或 AV 号。');
      return;
    }

    const videoKey = id.bvid ? id.bvid : `av${id.aid}`;

    if (silent && videoKey === lastVideoKey && currentData) return;

    running = true;
    lastVideoKey = videoKey;

    if (!silent) renderLoading('正在读取当前视频数据...');

    try {
      const viewRes = await getVideoData(id);

      if (!viewRes || viewRes.code !== 0 || !viewRes.data) {
        throw new Error(`视频接口返回异常：${viewRes?.message || viewRes?.msg || '未知错误'}，code=${viewRes?.code}`);
      }

      const video = viewRes.data;

      let stat = video.stat || {};
      const statRes = await safeGetArchiveStat(video);
      if (statRes?.code === 0 && statRes.data) {
        stat = { ...stat, ...statRes.data };
      }

      const tagList = await safeGetTags(video);
      const relation = await safeGetRelation(video.owner?.mid);

      currentData = buildData(video, stat, tagList, relation);

      renderPanel(currentData);
      renderInline(currentData);

      console.log('[B站视频播放量和互动量] 当前视频数据：', currentData);
    } catch (err) {
      console.error('[B站视频播放量和互动量] 读取失败：', err);
      renderError(err.message || String(err));
    } finally {
      running = false;
    }
  }

  function buildData(video, stat, tagList, relation) {
    const bvid = video.bvid || '';
    const aid = video.aid || '';
    const url = bvid
      ? `https://www.bilibili.com/video/${bvid}`
      : `${window.location.origin}${window.location.pathname}`;

    const title = video.title || getDomTitle() || '';
    const upName = video.owner?.name || getDomUpName() || '';
    const mid = video.owner?.mid || 0;

    const view = toNumber(stat.view);
    const danmaku = toNumber(stat.danmaku);
    const reply = toNumber(stat.reply);
    const like = toNumber(stat.like);
    const coin = toNumber(stat.coin);
    const favorite = toNumber(stat.favorite);
    const share = toNumber(stat.share);

    const engage = danmaku + reply + like + coin + favorite + share;

    const publishTime = video.pubdate
      ? formatTime(video.pubdate * 1000)
      : getDomPubTime();

    const tags = Array.isArray(tagList)
      ? tagList.map(item => item.tag_name || item.tagName || item.name || '').filter(Boolean)
      : [];

    if (video.tname && !tags.includes(video.tname)) {
      tags.unshift(video.tname);
    }

    const matchedKeywordIndexes = getMatchedKeywordIndexes(tags);
    const follower = toNumber(relation?.data?.follower);

    return {
      aid,
      bvid,
      mid,
      url,
      title,
      upName,
      publishTime,
      view,
      danmaku,
      reply,
      like,
      coin,
      favorite,
      share,
      engage,
      tags,
      matchedKeywordIndexes,
      follower,
      rawVideo: video,
      rawStat: stat,
      updateTime: new Date(),
    };
  }

  async function getVideoData(id) {
    if (id.bvid) return fetchJson(API.view, { bvid: id.bvid });
    return fetchJson(API.view, { aid: id.aid });
  }

  async function safeGetArchiveStat(video) {
    try {
      if (video.bvid) {
        const res = await fetchJson(API.archiveStat, { bvid: video.bvid });
        if (res?.code === 0) return res;
      }

      if (video.aid) {
        const res = await fetchJson(API.archiveStat, { aid: video.aid });
        if (res?.code === 0) return res;
      }
    } catch (err) {
      console.warn('[B站视频播放量和互动量] archive/stat 读取失败：', err);
    }

    return null;
  }

  async function safeGetTags(video) {
    try {
      const params = {};
      if (video.bvid) params.bvid = video.bvid;
      if (video.aid) params.aid = video.aid;

      const res = await fetchJson(API.tags, params);
      if (res?.code === 0 && Array.isArray(res.data)) return res.data;
    } catch (err) {
      console.warn('[B站视频播放量和互动量] 标签读取失败：', err);
    }

    return [];
  }

  async function safeGetRelation(mid) {
    if (!mid) return null;

    try {
      const res = await fetchJson(API.relation, { vmid: mid });
      if (res?.code === 0) return res;
    } catch (err) {
      console.warn('[B站视频播放量和互动量] 粉丝数读取失败：', err);
    }

    return null;
  }

  async function fetchJson(url, params = {}) {
    const u = new URL(url);

    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        u.searchParams.set(key, value);
      }
    });

    const resp = await fetch(u.toString(), {
      method: 'GET',
      credentials: 'include',
      mode: 'cors',
      cache: 'no-store',
      headers: {
        Accept: 'application/json, text/plain, */*',
      },
    });

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    }

    return resp.json();
  }

  function getVideoIdFromUrl() {
    const href = window.location.href;
    const pathname = window.location.pathname;

    const bvMatch = href.match(/\/video\/(BV[0-9A-Za-z]+)/i);
    if (bvMatch) return { bvid: bvMatch[1], aid: '' };

    const avMatch = pathname.match(/\/video\/av(\d+)/i) || href.match(/\/video\/av(\d+)/i);
    if (avMatch) return { bvid: '', aid: avMatch[1] };

    return null;
  }

  function watchUrlChange() {
    let lastUrl = location.href;

    setInterval(() => {
      if (location.href === lastUrl) return;

      lastUrl = location.href;

      const id = getVideoIdFromUrl();
      const key = id ? (id.bvid || `av${id.aid}`) : '';

      if (key && key !== lastVideoKey) {
        currentData = null;

        setTimeout(() => {
          loadVideoData(false);
        }, 1200);
      }
    }, 1000);
  }

  function getMatchedKeywordIndexes(tags) {
    let keywordsArr = [];

    try {
      const keywords = window.localStorage.getItem('MyKeywords');
      keywordsArr = keywords ? JSON.parse(keywords) : [];
    } catch (err) {
      console.warn('[B站视频播放量和互动量] MyKeywords 解析失败：', err);
      keywordsArr = [];
    }

    if (!Array.isArray(keywordsArr) || !keywordsArr.length) return [];

    return keywordsArr.reduce((acc, keyword, index) => {
      const kw = String(keyword || '').trim();
      if (!kw) return acc;

      if (tags.some(tag => String(tag || '').includes(kw))) {
        acc.push(index + 1);
      }

      return acc;
    }, []);
  }

  function createPanel() {
    if (document.querySelector('#bili-video-data-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'bili-video-data-panel';
    panel.innerHTML = `
      <div class="bvdp-head">
        <div class="bvdp-title">B站视频数据</div>
        <div class="bvdp-actions">
          <button type="button" id="bvdp-refresh">刷新</button>
          <button type="button" id="bvdp-copy-main">复制</button>
          <button type="button" id="bvdp-collapse">—</button>
        </div>
      </div>
      <div id="bvdp-body">
        <div class="bvdp-loading">等待读取...</div>
      </div>
    `;

    document.documentElement.appendChild(panel);

    document.querySelector('#bvdp-refresh').addEventListener('click', () => {
      loadVideoData(false);
    });

    document.querySelector('#bvdp-copy-main').addEventListener('click', () => {
      if (!currentData) return;
      copyText(getCopyForms(currentData).formData1, '复制');
    });

    document.querySelector('#bvdp-collapse').addEventListener('click', () => {
      panel.classList.toggle('collapsed');
      document.querySelector('#bvdp-collapse').textContent = panel.classList.contains('collapsed') ? '+' : '—';
    });
  }

  function getCopyForms(data) {
    const formData1 = [
      data.upName,
      data.title,
      data.url,
      data.publishTime,
      data.view,
      data.engage,
      data.reply,
      data.danmaku,
      data.like,
      data.coin,
      data.favorite,
      data.share,
    ].join('\t');

    return {
      formData1,
    };
  }

  function renderPanel(data) {
    const body = document.querySelector('#bvdp-body');
    if (!body) return;

    body.innerHTML = `
      <div class="bvdp-video-title" title="${escapeHtml(data.title)}">${escapeHtml(data.title)}</div>
      <div class="bvdp-up">UP：${escapeHtml(data.upName || '-')} ${data.follower ? `｜粉丝：${fmt(data.follower)}` : ''}</div>
      <div class="bvdp-time">发布时间：${escapeHtml(data.publishTime || '-')}</div>

      <div class="bvdp-grid">
        ${metric('播放', data.view, 'red')}
        ${metric('互动', data.engage, 'blue')}
        ${metric('弹幕', data.danmaku)}
        ${metric('评论', data.reply)}
        ${metric('点赞', data.like)}
        ${metric('投币', data.coin)}
        ${metric('收藏', data.favorite)}
        ${metric('分享', data.share)}
      </div>

      <div class="bvdp-sub-grid">
        <div>标：${data.matchedKeywordIndexes.length ? data.matchedKeywordIndexes.join('') : '0'}</div>
        <div>赞播比：${percent(data.like, data.view)}</div>
        <div>评播比：${percent(data.reply, data.view)}</div>
        <div>更新时间：${formatTime(data.updateTime)}</div>
      </div>

      <div class="bvdp-tags">
        ${data.tags.length ? data.tags.map(tag => `<span>${escapeHtml(tag)}</span>`).join('') : '<span>无标签</span>'}
      </div>
    `;
  }

  function renderInline(data) {
    if (!CONFIG.showInlineInVideoInfo) return;
  }

  function renderLoading(text) {
    const body = document.querySelector('#bvdp-body');
    if (!body) return;
    body.innerHTML = `<div class="bvdp-loading">${escapeHtml(text)}</div>`;
  }

  function renderError(text) {
    const body = document.querySelector('#bvdp-body');
    if (!body) return;

    body.innerHTML = `
      <div class="bvdp-error">${escapeHtml(text)}</div>
      <div class="bvdp-help">
        建议：确认当前是 www.bilibili.com/video/BV... 页面；如果仍失败，打开控制台查看接口返回。
      </div>
    `;
  }

  function metric(label, value, color = '') {
    return `
      <div class="bvdp-metric">
        <div class="bvdp-label">${label}</div>
        <div class="bvdp-value ${color}">${fmt(value)}</div>
      </div>
    `;
  }

  function injectStyle() {
    if (document.querySelector('#bili-video-data-style')) return;

    const style = document.createElement('style');
    style.id = 'bili-video-data-style';
    style.textContent = `
      #bili-video-data-panel {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 999999;
        width: 420px;
        max-width: calc(100vw - 36px);
        background: #fff;
        color: #222;
        border: 1px solid #e7e7e7;
        border-radius: 12px;
        box-shadow: 0 8px 30px rgba(0,0,0,.14);
        font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", Arial, sans-serif;
        overflow: hidden;
      }

      #bili-video-data-panel .bvdp-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 12px;
        background: #fbfbfb;
        border-bottom: 1px solid #e7e7e7;
        user-select: none;
      }

      .bvdp-title {
        font-weight: 700;
      }

      .bvdp-actions {
        display: flex;
        gap: 6px;
      }

      .bvdp-actions button {
        border: 1px solid #d9d9d9;
        background: #fff;
        border-radius: 7px;
        padding: 3px 8px;
        cursor: pointer;
        font-size: 12px;
      }

      .bvdp-actions button:hover {
        border-color: #00aeec;
        color: #00aeec;
      }

      #bvdp-body {
        padding: 12px;
      }

      #bili-video-data-panel.collapsed #bvdp-body {
        display: none;
      }

      .bvdp-video-title {
        font-weight: 700;
        margin-bottom: 5px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .bvdp-up,
      .bvdp-time {
        color: #666;
        font-size: 12px;
        margin-bottom: 4px;
      }

      .bvdp-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 8px;
        margin-top: 10px;
      }

      .bvdp-metric {
        border: 1px solid #eee;
        border-radius: 9px;
        padding: 7px 8px;
        background: #fff;
        min-width: 0;
      }

      .bvdp-label {
        color: #666;
        font-size: 12px;
        white-space: nowrap;
      }

      .bvdp-value {
        margin-top: 2px;
        font-size: 16px;
        font-weight: 700;
        white-space: nowrap;
      }

      .bvdp-value.red {
        color: #e11;
      }

      .bvdp-value.blue {
        color: #007fec;
      }

      .bvdp-sub-grid {
        margin-top: 10px;
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 4px 8px;
        color: #666;
        font-size: 12px;
      }

      .bvdp-tags {
        margin-top: 8px;
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
      }

      .bvdp-tags span {
        border: 1px solid #eee;
        background: #fafafa;
        color: #666;
        border-radius: 999px;
        padding: 2px 7px;
        font-size: 12px;
      }

      .bvdp-loading {
        color: #666;
        padding: 8px 2px;
      }

      .bvdp-error {
        color: #cf1322;
        white-space: pre-wrap;
      }

      .bvdp-help {
        color: #666;
        margin-top: 8px;
        font-size: 12px;
      }

      @media (max-width: 560px) {
        #bili-video-data-panel {
          width: calc(100vw - 24px);
          right: 12px;
          bottom: 12px;
        }

        .bvdp-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
    `;

    document.documentElement.appendChild(style);
  }

  async function copyText(text, label = '复制', btn = null) {
    try {
      if (typeof GM_setClipboard === 'function') {
        GM_setClipboard(text, 'text');
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        fallbackCopyText(text);
      }

      if (btn) {
        flashButton(btn, '已复制');
      } else {
        const panelBtn = document.querySelector('#bvdp-copy-main');
        if (panelBtn) flashButton(panelBtn, '已复制');
      }

      console.log(`[B站视频播放量和互动量] ${label}：`, text);
    } catch (err) {
      console.error('[B站视频播放量和互动量] 复制失败：', err);
      alert('复制失败，请查看控制台。');
    }
  }

  function fallbackCopyText(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '-9999px';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  }

  function flashButton(btn, text) {
    const old = btn.textContent;
    btn.textContent = text;
    setTimeout(() => {
      btn.textContent = old;
    }, 900);
  }

  function getDomTitle() {
    const h1 = document.querySelector('h1');
    return h1?.title || h1?.innerText?.trim() || document.title.replace('_哔哩哔哩_bilibili', '').trim();
  }

  function getDomUpName() {
    const el =
      document.querySelector('.up-name') ||
      document.querySelector('.up-info-container .name') ||
      document.querySelector('.username');

    if (!el) return '';

    return el.childNodes?.[0]?.textContent?.trim() || el.textContent?.trim() || '';
  }

  function getDomPubTime() {
    const el =
      document.querySelector('.pubdate-ip-text') ||
      document.querySelector('.pubdate-text') ||
      document.querySelector('.video-info-detail-list .item');

    return el?.innerText?.trim() || '';
  }

  function toNumber(v) {
    if (v === null || v === undefined || v === '') return 0;
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0;

    const s = String(v).replace(/,/g, '').trim();
    if (!s || s === '--' || s === '-') return 0;

    if (s.includes('亿')) return parseFloat(s) * 100000000;
    if (s.includes('万')) return parseFloat(s) * 10000;

    const n = parseFloat(s.replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  }

  function fmt(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '-';

    return new Intl.NumberFormat('zh-CN', {
      maximumFractionDigits: 0,
    }).format(n);
  }

  function percent(num, den) {
    const n = Number(num);
    const d = Number(den);

    if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) return '-';

    return new Intl.NumberFormat('zh-CN', {
      style: 'percent',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n / d);
  }

  function formatTime(input) {
    const d = input instanceof Date ? input : new Date(input);

    if (!Number.isFinite(d.getTime())) return '';

    const pad = n => String(n).padStart(2, '0');

    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>'"]/g, ch => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;',
    }[ch]));
  }
})();
