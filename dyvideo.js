// ==UserScript==
// @name         抖音视频数据统计
// @namespace    https://github.com/alicechino/Blibili-Up-data/
// @version      2.2.0
// @description  通过当前视频ID调用抖音详情接口，统计播放、点赞、评论、收藏、转发、互动总和
// @author       alicechino
// @match        https://www.douyin.com/*
// @match        https://v.douyin.com/*
// @icon         https://www.douyin.com/favicon.ico
// @grant        GM_setClipboard
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  let currentData = null;
  let lastUrl = location.href;
  let running = false;

  injectStyle();
  createPanel();
  watchUrlChange();

  setTimeout(loadData, 1500);

  async function loadData() {
    if (running) return;
    running = true;

    try {
      renderLoading('正在读取当前视频数据...');

      const videoId = getVideoIdFromUrl();

      if (!videoId) {
        throw new Error('没有识别到当前视频ID。请确认页面是 douyin.com/video/数字。');
      }

      const aweme = await fetchAwemeDetail(videoId);

      if (!aweme) {
        throw new Error(`接口没有返回当前视频 ${videoId} 的详情。请确认已登录抖音，或刷新页面后重试。`);
      }

      currentData = buildDataFromAweme(aweme, videoId);
      renderPanel(currentData);

      console.log('[抖音视频数据统计] 当前视频数据：', currentData);
      console.log('[抖音视频数据统计] 原始详情：', aweme);
    } catch (err) {
      console.warn('[抖音视频数据统计] 读取失败：', err);
      renderError(err.message || String(err));
    } finally {
      running = false;
    }
  }

  async function fetchAwemeDetail(videoId) {
    const api = new URL('https://www.douyin.com/aweme/v1/web/multi/aweme/detail/');
    api.searchParams.set('aweme_ids', `[${videoId}]`);
    api.searchParams.set('request_source', '3');
    api.searchParams.set('origin_type', 'web');
    api.searchParams.set('device_platform', 'webapp');
    api.searchParams.set('aid', '6383');
    api.searchParams.set('version_code', '170400');
    api.searchParams.set('version_name', '17.4.0');

    const resp = await fetch(api.toString(), {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers: {
        Accept: 'application/json, text/plain, */*',
        Referer: location.href,
      },
    });

    if (!resp.ok) {
      throw new Error(`详情接口 HTTP ${resp.status}`);
    }

    const json = await resp.json();

    const list =
      json.aweme_details ||
      json.aweme_list ||
      json.data?.aweme_details ||
      json.data?.aweme_list ||
      [];

    if (!Array.isArray(list) || list.length === 0) {
      console.warn('[抖音视频数据统计] 接口返回：', json);
      return null;
    }

    return list.find(item => String(item.aweme_id || item.awemeId || item.id) === String(videoId)) || list[0];
  }

  function buildDataFromAweme(aweme, videoId) {
    const stat = aweme.statistics || aweme.stats || aweme.stat || {};

    const like = toNumber(stat.digg_count ?? stat.like_count ?? stat.likeCount);
    const comment = toNumber(stat.comment_count ?? stat.commentCount);
    const collect = toNumber(stat.collect_count ?? stat.collectCount ?? stat.favourite_count ?? stat.favorite_count);
    const share = toNumber(stat.share_count ?? stat.shareCount);
    const play = toNumber(stat.play_count ?? stat.playCount ?? stat.view_count ?? stat.play);

    const title =
      aweme.desc ||
      aweme.title ||
      aweme.share_info?.share_title ||
      aweme.shareInfo?.shareTitle ||
      document.title.replace(/ - 抖音$/, '').trim();

    const upName =
      aweme.author?.nickname ||
      aweme.authorInfo?.nickname ||
      aweme.author_user_info?.nickname ||
      aweme.nickname ||
      '';

    const createTime =
      aweme.create_time ||
      aweme.createTime ||
      aweme.create_timestamp ||
      0;

    return {
      videoId,
      upName,
      title,
      url: `https://www.douyin.com/video/${videoId}`,
      publishTime: createTime ? formatTime(Number(createTime) * 1000) : '',
      play,
      like,
      comment,
      collect,
      share,
      engage: like + comment + collect + share,
      updateTime: new Date(),
    };
  }

  function createPanel() {
    if (document.querySelector('#douyin-video-data-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'douyin-video-data-panel';
    panel.innerHTML = `
      <div class="dvdp-head">
        <div class="dvdp-title">抖音视频数据</div>
        <div class="dvdp-actions">
          <button type="button" id="dvdp-refresh">刷新</button>
          <button type="button" id="dvdp-copy">复制</button>
          <button type="button" id="dvdp-min">—</button>
        </div>
      </div>
      <div id="dvdp-body">
        <div class="dvdp-loading">等待读取...</div>
      </div>
    `;

    document.documentElement.appendChild(panel);

    document.querySelector('#dvdp-refresh').addEventListener('click', loadData);

    document.querySelector('#dvdp-copy').addEventListener('click', () => {
      if (!currentData) return;
      copyText(toTsv(currentData));
      flashButton(document.querySelector('#dvdp-copy'), '已复制');
    });

    document.querySelector('#dvdp-min').addEventListener('click', () => {
      panel.classList.toggle('collapsed');
      document.querySelector('#dvdp-min').textContent = panel.classList.contains('collapsed') ? '+' : '—';
    });
  }

  function renderPanel(data) {
    const body = document.querySelector('#dvdp-body');
    if (!body) return;

    body.innerHTML = `
      <div class="dvdp-video-title" title="${escapeHtml(data.title)}">${escapeHtml(data.title || '-')}</div>
      <div class="dvdp-meta">作者：${escapeHtml(data.upName || '-')}</div>
      <div class="dvdp-meta">视频ID：${escapeHtml(data.videoId)}</div>
      <div class="dvdp-meta">链接：${escapeHtml(data.url)}</div>
      ${data.publishTime ? `<div class="dvdp-meta">发布时间：${escapeHtml(data.publishTime)}</div>` : ''}

      <div class="dvdp-grid">
        ${metric('播放', data.play)}
        ${metric('互动', data.engage, 'blue')}
        ${metric('点赞', data.like, 'red')}
        ${metric('评论', data.comment)}
        ${metric('收藏', data.collect)}
        ${metric('转发', data.share)}
      </div>

      <div class="dvdp-footer">
        复制顺序：作者 / 标题 / 链接 / 发布时间 / 播放 / 互动 / 评论 / 点赞 / 收藏 / 转发
        <br>
        更新时间：${formatTime(data.updateTime)}
      </div>
    `;
  }

  function renderLoading(text) {
    const body = document.querySelector('#dvdp-body');
    if (!body) return;
    body.innerHTML = `<div class="dvdp-loading">${escapeHtml(text)}</div>`;
  }

  function renderError(text) {
    const body = document.querySelector('#dvdp-body');
    if (!body) return;

    body.innerHTML = `
      <div class="dvdp-error">${escapeHtml(text)}</div>
      <div class="dvdp-help">
        如果接口返回空，通常是 Cookie、登录态、风控或接口参数问题。先确认当前浏览器能正常打开该视频，再点刷新。
      </div>
    `;
  }

  function metric(label, value, color = '') {
    return `
      <div class="dvdp-metric">
        <div class="dvdp-label">${label}</div>
        <div class="dvdp-value ${color}">${formatNum(value)}</div>
      </div>
    `;
  }

  function toTsv(data) {
    return [
      data.upName,
      data.title,
      data.url,
      data.publishTime || '',
      data.play,
      data.engage,
      data.comment,
      data.like,
      data.collect,
      data.share,
    ].join('\t');
  }

  function copyText(text) {
    if (typeof GM_setClipboard === 'function') {
      GM_setClipboard(text, 'text');
      return;
    }

    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text);
      return;
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  }

  function watchUrlChange() {
    setInterval(() => {
      if (location.href === lastUrl) return;

      lastUrl = location.href;
      currentData = null;

      setTimeout(loadData, 1200);
    }, 1000);
  }

  function getVideoIdFromUrl() {
    const url = location.href;

    const videoMatch = url.match(/\/video\/(\d+)/);
    if (videoMatch) return videoMatch[1];

    const noteMatch = url.match(/\/note\/(\d+)/);
    if (noteMatch) return noteMatch[1];

    const modalMatch = url.match(/[?&]modal_id=(\d+)/);
    if (modalMatch) return modalMatch[1];

    return '';
  }

  function toNumber(value) {
    if (value === undefined || value === null || value === '') return 0;

    if (typeof value === 'number') {
      return Number.isFinite(value) ? Math.round(value) : 0;
    }

    const s = String(value)
      .replace(/,/g, '')
      .replace(/\s+/g, '')
      .trim();

    const m = s.match(/([0-9]+(?:\.[0-9]+)?)(万|w|W|k|K|千)?/);
    if (!m) return 0;

    const n = parseFloat(m[1]);
    const unit = m[2];

    if (unit === '万' || unit === 'w' || unit === 'W') return Math.round(n * 10000);
    if (unit === 'k' || unit === 'K' || unit === '千') return Math.round(n * 1000);

    return Math.round(n);
  }

  function formatNum(n) {
    const num = Number(n);
    if (!Number.isFinite(num)) return '0';

    return new Intl.NumberFormat('zh-CN', {
      maximumFractionDigits: 0,
      useGrouping: false,
    }).format(num);
  }

  function formatTime(input) {
    const d = input instanceof Date ? input : new Date(input);
    if (!Number.isFinite(d.getTime())) return '';

    const pad = n => String(n).padStart(2, '0');

    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function flashButton(btn, text) {
    if (!btn) return;

    const old = btn.textContent;
    btn.textContent = text;

    setTimeout(() => {
      btn.textContent = old;
    }, 900);
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

  function injectStyle() {
    if (document.querySelector('#douyin-video-data-style')) return;

    const style = document.createElement('style');
    style.id = 'douyin-video-data-style';
    style.textContent = `
      #douyin-video-data-panel {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 999999;
        width: 420px;
        max-width: calc(100vw - 36px);
        background: rgba(20, 20, 20, .94);
        color: #fff;
        border: 1px solid rgba(255,255,255,.16);
        border-radius: 12px;
        box-shadow: 0 8px 30px rgba(0,0,0,.35);
        font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", Arial, sans-serif;
        overflow: hidden;
      }

      .dvdp-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 12px;
        background: rgba(255,255,255,.06);
        border-bottom: 1px solid rgba(255,255,255,.12);
      }

      .dvdp-title { font-weight: 700; }
      .dvdp-actions { display: flex; gap: 6px; }

      .dvdp-actions button {
        border: 1px solid rgba(255,255,255,.24);
        background: rgba(255,255,255,.08);
        color: #fff;
        border-radius: 7px;
        padding: 3px 8px;
        cursor: pointer;
        font-size: 12px;
      }

      .dvdp-actions button:hover { background: rgba(255,255,255,.18); }

      #dvdp-body { padding: 12px; }
      #douyin-video-data-panel.collapsed #dvdp-body { display: none; }

      .dvdp-video-title {
        font-weight: 700;
        margin-bottom: 5px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .dvdp-meta {
        color: rgba(255,255,255,.72);
        font-size: 12px;
        margin-bottom: 4px;
        word-break: break-all;
      }

      .dvdp-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 8px;
        margin-top: 10px;
      }

      .dvdp-metric {
        border: 1px solid rgba(255,255,255,.14);
        border-radius: 9px;
        padding: 7px 8px;
        background: rgba(255,255,255,.06);
        min-width: 0;
      }

      .dvdp-label {
        color: rgba(255,255,255,.68);
        font-size: 12px;
      }

      .dvdp-value {
        margin-top: 2px;
        font-size: 16px;
        font-weight: 700;
        white-space: nowrap;
      }

      .dvdp-value.red { color: #ff4d4f; }
      .dvdp-value.blue { color: #40a9ff; }

      .dvdp-footer {
        margin-top: 10px;
        color: rgba(255,255,255,.58);
        font-size: 12px;
      }

      .dvdp-loading {
        color: rgba(255,255,255,.76);
        padding: 8px 2px;
      }

      .dvdp-error {
        color: #ff7875;
        white-space: pre-wrap;
      }

      .dvdp-help {
        color: rgba(255,255,255,.64);
        margin-top: 8px;
        font-size: 12px;
      }
    `;

    document.documentElement.appendChild(style);
  }
})();
