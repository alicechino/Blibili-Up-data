// ==UserScript==
// @name         B站UP主数据分析
// @namespace    https://github.com/alicechino/Blibili-Up-data
// @version      4.0.1
// @description  在B站UP主页右下角显示UP主数据分析，修复新版空间页投稿接口、DOM失效、近30均赞不显示问题
// @author       alicechino
// @match        *://space.bilibili.com/*
// @icon         https://static.hdslb.com/images/favicon.ico
// @require      https://cdn.jsdelivr.net/npm/blueimp-md5@2.19.0/js/md5.min.js
// @grant        GM_setClipboard
// @run-at       document-end
// @license      MPL-2.0
// ==/UserScript==

(async function () {
  'use strict';

  const CONFIG = {
    recentLimit: 30,
    topLimit: 5,

    // 用于读取近30视频点赞、投币、收藏、分享等详细数据
    // 如果遇到风控或加载很慢，可以改成 5 或 0
    detailStatLimit: 30,

    // 0 表示不自动刷新；例如 5 表示每5分钟自动刷新一次
    autoRefreshMinutes: 0,
  };

  const API = {
    nav: 'https://api.bilibili.com/x/web-interface/nav',
    card: 'https://api.bilibili.com/x/web-interface/card',
    relation: 'https://api.bilibili.com/x/relation/stat',
    upstat: 'https://api.bilibili.com/x/space/upstat',
    accInfo: 'https://api.bilibili.com/x/space/wbi/acc/info',
    arcSearch: 'https://api.bilibili.com/x/space/wbi/arc/search',

    // 视频统计接口
    archiveStat: 'https://api.bilibili.com/x/web-interface/archive/stat',

    // 备用视频详情接口，data.stat 里也有 like/view/reply/favorite 等
    archiveView: 'https://api.bilibili.com/x/web-interface/view',
  };

  let currentUid = getUidFromUrl();
  let lastResult = null;
  let running = false;

  injectStyle();
  const panel = createPanel();
  bindEvents(panel);

  if (!currentUid) {
    renderMessage('未识别到 UID。请打开 https://space.bilibili.com/{uid} 页面。');
    return;
  }

  await analyzeAndRender(currentUid);

  // 兼容B站单页路由跳转
  setInterval(() => {
    const uid = getUidFromUrl();
    if (uid && uid !== currentUid) {
      currentUid = uid;
      analyzeAndRender(uid);
    }
  }, 1200);

  if (CONFIG.autoRefreshMinutes > 0) {
    setInterval(() => {
      const uid = getUidFromUrl();
      if (uid) analyzeAndRender(uid, true);
    }, CONFIG.autoRefreshMinutes * 60 * 1000);
  }

  async function analyzeAndRender(uid, silent = false) {
    if (running) return;
    running = true;

    if (!silent) {
      renderLoading('正在读取UP主数据...');
    }

    try {
      const [cardRes, relationRes, upstatRes, accInfoRes, arcRes] = await Promise.allSettled([
        getCard(uid),
        getRelation(uid),
        getUpStat(uid),
        getAccInfo(uid),
        getArcList(uid, 1, CONFIG.recentLimit),
      ]);

      const card = unwrap(cardRes);
      const relation = unwrap(relationRes);
      const upstat = unwrap(upstatRes);
      const accInfo = unwrap(accInfoRes);
      const arc = unwrap(arcRes);

      if (!arc || arc.code !== 0) {
        throw new Error(`投稿列表读取失败：${arc?.message || arc?.msg || '未知错误'}${arc?.code !== undefined ? `，code=${arc.code}` : ''}`);
      }

      const rawVideos = arc?.data?.list?.vlist || [];

      const totalVideo =
        numberOf(arc?.data?.page?.count) ||
        numberOf(card?.data?.archive_count) ||
        numberOf(card?.data?.card?.archive_count);

      const basic = mergeBasic(uid, card, relation, upstat, accInfo, rawVideos[0]);

      const videos = rawVideos.slice(0, CONFIG.recentLimit).map(v => ({
        aid: v.aid,
        bvid: v.bvid,
        title: v.title || '',
        created: v.created,
        play: numberOf(v.play),
        comment: numberOf(v.comment),
        danmaku: numberOf(v.video_review),
        length: v.length || '',
        url: v.bvid ? `https://www.bilibili.com/video/${v.bvid}` : '',
      }));

      // 读取近30条视频详情，用于获取点赞、投币、收藏、分享
      if (CONFIG.detailStatLimit > 0) {
        renderLoading('正在读取UP主数据... 正在补充近30视频点赞数据');

        const statMap = await getArchiveStats(videos.slice(0, CONFIG.detailStatLimit));

        for (const v of videos) {
          const s = statMap.get(v.bvid) || statMap.get(String(v.aid));
          if (!s) continue;

          if (s.view !== undefined && s.view !== null) {
            v.play = numberOf(s.view) || v.play;
          }

          if (s.danmaku !== undefined && s.danmaku !== null) {
            v.danmaku = numberOf(s.danmaku);
          }

          if (s.reply !== undefined && s.reply !== null) {
            v.comment = numberOf(s.reply);
          }

          if (s.like !== undefined && s.like !== null) {
            v.like = numberOf(s.like);
          }

          if (s.coin !== undefined && s.coin !== null) {
            v.coin = numberOf(s.coin);
          }

          if (s.favorite !== undefined && s.favorite !== null) {
            v.favorite = numberOf(s.favorite);
          }

          if (s.share !== undefined && s.share !== null) {
            v.share = numberOf(s.share);
          }
        }

        console.log('[B站UP主数据分析] 已读取视频详情数量：', statMap.size);
      }

      lastResult = calcResult({ uid, basic, totalVideo, videos });
      renderResult(lastResult);
    } catch (err) {
      console.error('[B站UP主数据分析] 失败：', err);
      renderError(err);
    } finally {
      running = false;
    }
  }

  function mergeBasic(uid, card, relation, upstat, accInfo, firstVideo) {
    const cardData = card?.data || {};
    const cardInfo = cardData.card || {};
    const relationData = relation?.data || {};
    const upstatData = upstat?.data || {};
    const accData = accInfo?.data || {};

    return {
      uid,
      name:
        accData.name ||
        cardInfo.name ||
        firstVideo?.author ||
        document.title.replace(/的个人空间.*/, '').trim() ||
        `UID ${uid}`,

      follower:
        numberOf(relationData.follower) ||
        numberOf(cardData.follower) ||
        numberOf(cardInfo.fans),

      following:
        numberOf(relationData.following) ||
        numberOf(cardInfo.attention),

      totalLikes:
        numberOf(upstatData.likes) ||
        numberOf(cardData.like_num),

      totalViews:
        numberOf(upstatData.archive?.view),

      articleViews:
        numberOf(upstatData.article?.view),
    };
  }

  function calcResult({ uid, basic, totalVideo, videos }) {
    const r30 = videos.slice(0, CONFIG.recentLimit);
    const r5 = videos.slice(0, CONFIG.topLimit);

    const allAvgView = basic.totalViews && totalVideo ? basic.totalViews / totalVideo : null;
    const allAvgLike = basic.totalLikes && totalVideo ? basic.totalLikes / totalVideo : null;
    const viewsPerFollower = basic.totalViews && basic.follower ? basic.totalViews / basic.follower : null;
    const allLikeRate = basic.totalLikes && basic.totalViews ? basic.totalLikes / basic.totalViews : null;

    const r30Play = sum(r30, 'play');
    const r5Play = sum(r5, 'play');

    const likeKnownCount = r30.filter(v => Number.isFinite(v.like)).length;

    const r30Like = sumKnown(r30, 'like');
    const r30Coin = sumKnown(r30, 'coin');
    const r30Fav = sumKnown(r30, 'favorite');
    const r30Share = sumKnown(r30, 'share');
    const r30Comment = sum(r30, 'comment');
    const r30Danmaku = sum(r30, 'danmaku');

    const interactionTotal = r30Like + r30Coin + r30Fav + r30Share + r30Comment;

    return {
      uid,
      name: basic.name,
      follower: basic.follower,
      following: basic.following,
      totalVideo,
      totalViews: basic.totalViews,
      totalLikes: basic.totalLikes,
      articleViews: basic.articleViews,

      allAvgView,
      allAvgLike,
      viewsPerFollower,
      allLikeRate,

      videos,

      recent: {
        count30: r30.length,
        count5: r5.length,

        totalPlay30: r30Play,
        totalPlay5: r5Play,

        avgPlay30: avg(r30Play, r30.length),
        avgPlay5: avg(r5Play, r5.length),

        avgLike30: likeKnownCount ? r30Like / likeKnownCount : null,
        likeKnownCount,

        avgComment30: avg(r30Comment, r30.length),
        avgDanmaku30: avg(r30Danmaku, r30.length),

        interactionRate30: r30Play ? interactionTotal / r30Play : null,
      },

      updatedAt: new Date(),
    };
  }

  function getCard(mid) {
    return fetchJson(API.card, {
      mid,
      photo: false,
    });
  }

  function getRelation(mid) {
    return fetchJson(API.relation, {
      vmid: mid,
    });
  }

  function getUpStat(mid) {
    return fetchJson(API.upstat, {
      mid,
    });
  }

  function getAccInfo(mid) {
    return fetchWbiJson(API.accInfo, {
      mid,
      token: '',
      platform: 'web',
      web_location: 1550101,
    });
  }

  function getArcList(mid, pn = 1, ps = 30) {
    return fetchWbiJson(API.arcSearch, {
      mid,
      ps,
      tid: 0,
      pn,
      keyword: '',
      order: 'pubdate',
      platform: 'web',
      web_location: 1550101,
      order_avoided: true,
    });
  }

  async function getArchiveStats(videos) {
    const map = new Map();
    const queue = videos.filter(v => v.bvid || v.aid);

    // 降低并发，减少被风控概率
    const concurrency = 2;
    let idx = 0;

    async function fetchOneVideoStat(v) {
      const tries = [];

      // 优先 aid
      if (v.aid) {
        tries.push({
          url: API.archiveStat,
          params: { aid: v.aid },
          name: 'archive/stat aid',
        });
      }

      if (v.bvid) {
        tries.push({
          url: API.archiveStat,
          params: { bvid: v.bvid },
          name: 'archive/stat bvid',
        });
      }

      // 备用 view 接口
      if (v.aid) {
        tries.push({
          url: API.archiveView,
          params: { aid: v.aid },
          name: 'view aid',
        });
      }

      if (v.bvid) {
        tries.push({
          url: API.archiveView,
          params: { bvid: v.bvid },
          name: 'view bvid',
        });
      }

      for (const item of tries) {
        try {
          const res = await fetchJson(item.url, item.params);

          if (res?.code === 0) {
            const stat = res.data?.stat || res.data;

            if (
              stat &&
              (
                stat.view !== undefined ||
                stat.like !== undefined ||
                stat.reply !== undefined ||
                stat.favorite !== undefined
              )
            ) {
              return stat;
            }
          } else {
            console.warn('[B站UP主数据分析] 视频统计接口失败：', item.name, v.bvid || v.aid, res);
          }
        } catch (e) {
          console.warn('[B站UP主数据分析] 视频统计接口异常：', item.name, v.bvid || v.aid, e);
        }

        await sleep(120 + Math.random() * 160);
      }

      return null;
    }

    async function worker() {
      while (idx < queue.length) {
        const v = queue[idx++];

        const stat = await fetchOneVideoStat(v);

        if (stat) {
          if (v.bvid) map.set(v.bvid, stat);
          if (v.aid) map.set(String(v.aid), stat);
        } else {
          console.warn('[B站UP主数据分析] 视频详情读取失败：', v.bvid || v.aid, v.title);
        }

        await sleep(260 + Math.random() * 260);
      }
    }

    await Promise.all(Array.from({ length: concurrency }, worker));
    return map;
  }

  async function fetchJson(url, params = {}) {
    const finalUrl = `${url}?${new URLSearchParams(cleanParams(params)).toString()}`;

    const resp = await fetch(finalUrl, {
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

  async function fetchWbiJson(url, params = {}) {
    const signed = await signWbi(params);
    return fetchJson(url, signed);
  }

  function cleanParams(params) {
    const out = {};

    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null) {
        out[k] = v;
      }
    }

    return out;
  }

  async function signWbi(params) {
    const { imgKey, subKey } = await getWbiKeys();
    const mixinKey = getMixinKey(imgKey + subKey);
    const wts = Math.round(Date.now() / 1000);

    const signed = {
      ...cleanParams(params),
      wts,
    };

    const query = Object.keys(signed)
      .sort()
      .map(key => {
        const value = String(signed[key]).replace(/[!'()*]/g, '');
        return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
      })
      .join('&');

    return {
      ...signed,
      w_rid: md5(query + mixinKey),
    };
  }

  async function getWbiKeys() {
    const today = new Date().toISOString().slice(0, 10);
    const cacheKey = 'bili_up_analysis_wbi_keys_v1';

    try {
      const cache = JSON.parse(localStorage.getItem(cacheKey) || 'null');
      if (cache?.date === today && cache.imgKey && cache.subKey) {
        return cache;
      }
    } catch (_) {}

    const nav = await fetchJson(API.nav);
    const wbi = nav?.data?.wbi_img;

    const imgKey = extractWbiKey(wbi?.img_url);
    const subKey = extractWbiKey(wbi?.sub_url);

    if (!imgKey || !subKey) {
      throw new Error('WBI key 获取失败，可能是B站接口变更、未登录、或网络被拦截。');
    }

    const data = {
      date: today,
      imgKey,
      subKey,
    };

    localStorage.setItem(cacheKey, JSON.stringify(data));
    return data;
  }

  function extractWbiKey(url = '') {
    const fileName = String(url).split('/').pop() || '';
    return fileName.split('.')[0] || '';
  }

  function getMixinKey(raw) {
    const table = [
      46, 47, 18, 2, 53, 8, 23, 32,
      15, 50, 10, 31, 58, 3, 45, 35,
      27, 43, 5, 49, 33, 9, 42, 19,
      29, 28, 14, 39, 12, 38, 41, 13,
      37, 48, 7, 16, 24, 55, 40, 61,
      26, 17, 0, 1, 60, 51, 30, 4,
      22, 25, 54, 21, 56, 59, 6, 63,
      57, 62, 11, 36, 20, 34, 44, 52,
    ];

    return table.map(i => raw[i]).join('').slice(0, 32);
  }

  function createPanel() {
    let el = document.querySelector('#bili-up-analysis-panel');

    if (el) {
      return el;
    }

    el = document.createElement('div');
    el.id = 'bili-up-analysis-panel';

    el.innerHTML = `
      <div class="bua-head">
        <div id="bua-title">UP主数据分析</div>
        <div class="bua-actions">
          <button id="bua-refresh" type="button">刷新</button>
          <button id="bua-copy" type="button">复制</button>
          <button id="bua-min" type="button">—</button>
        </div>
      </div>
      <div id="bua-body"></div>
    `;

    document.documentElement.appendChild(el);
    return el;
  }

  function bindEvents(panel) {
    panel.querySelector('#bua-refresh').addEventListener('click', () => {
      const uid = getUidFromUrl();
      if (uid) {
        analyzeAndRender(uid);
      }
    });

    panel.querySelector('#bua-copy').addEventListener('click', () => {
      if (!lastResult) {
        return;
      }

      GM_setClipboard(toTsv(lastResult), 'text');
      flashCopyButton('已复制');
    });

    panel.querySelector('#bua-min').addEventListener('click', () => {
      panel.classList.toggle('bua-collapsed');
      panel.querySelector('#bua-min').textContent = panel.classList.contains('bua-collapsed') ? '+' : '—';
    });
  }

  function renderResult(r) {
    document.querySelector('#bua-title').textContent = 'UP主数据分析';

    document.querySelector('#bua-body').innerHTML = `
      <div class="bua-grid">
        ${metric('粉丝', fmt(r.follower), '')}
        ${metric('投稿', fmt(r.totalVideo), '')}
        ${metric('总播放', fmt(r.totalViews), rateClass(r.totalViews, [1000000, 10000000, 50000000]))}
        ${metric('总点赞', fmt(r.totalLikes), rateClass(r.totalLikes, [100000, 500000, 2000000]))}

        ${metric('全投稿均播', fmt(r.allAvgView), playClass(r.allAvgView))}
        ${metric('近30均播', fmt(r.recent.avgPlay30), playClass(r.recent.avgPlay30))}
        ${metric('近5均播', fmt(r.recent.avgPlay5), playClass(r.recent.avgPlay5))}
        ${metric('全投稿均赞', fmt(r.allAvgLike), likeClass(r.allAvgLike))}

        ${metric('近30均赞', fmt(r.recent.avgLike30), likeClass(r.recent.avgLike30))}
        ${metric('总赞播比', pct(r.allLikeRate), ratioClass(r.allLikeRate))}
        ${metric('近30互动率', pct(r.recent.interactionRate30), ratioClass(r.recent.interactionRate30))}
        ${metric('播放/粉丝', fmt(r.viewsPerFollower, 2), '')}
      </div>

      <div class="bua-note">
        <div><b>${escapeHtml(r.name)}</b> UID ${r.uid}</div>
        <div>近30样本：${r.recent.count30} 条；近30点赞样本：${r.recent.likeKnownCount} 条；更新：${formatTime(r.updatedAt)}</div>
        <div>均评：${fmt(r.recent.avgComment30)}；均弹幕：${fmt(r.recent.avgDanmaku30)}</div>
      </div>

      ${renderVideoTable(r.videos.slice(0, 5))}
    `;
  }

  function metric(label, value, cls) {
    return `
      <div class="bua-metric">
        <div class="bua-label">${label}</div>
        <div class="bua-value ${cls || ''}">${value}</div>
      </div>
    `;
  }

  function renderVideoTable(videos) {
    if (!videos.length) {
      return '<div class="bua-note">未读取到视频列表。</div>';
    }

    return `
      <div class="bua-table-title">最新5条</div>
      <table class="bua-table">
        <thead>
          <tr>
            <th>标题</th>
            <th>播放</th>
            <th>赞</th>
            <th>评</th>
          </tr>
        </thead>
        <tbody>
          ${videos.map(v => `
            <tr>
              <td title="${escapeHtml(v.title)}">
                <a href="${v.url}" target="_blank">${escapeHtml(shortText(v.title, 18))}</a>
              </td>
              <td>${fmt(v.play)}</td>
              <td>${fmt(v.like)}</td>
              <td>${fmt(v.comment)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  function renderLoading(text) {
    document.querySelector('#bua-title').textContent = 'UP主数据分析';
    document.querySelector('#bua-body').innerHTML = `
      <div class="bua-loading">${escapeHtml(text)}</div>
    `;
  }

  function renderMessage(text) {
    document.querySelector('#bua-body').innerHTML = `
      <div class="bua-loading">${escapeHtml(text)}</div>
    `;
  }

  function renderError(err) {
    document.querySelector('#bua-title').textContent = 'UP主数据分析 - 失败';

    document.querySelector('#bua-body').innerHTML = `
      <div class="bua-error">${escapeHtml(err?.message || String(err))}</div>
      <div class="bua-note">
        建议：确认已登录B站；刷新空间页；如果仍失败，把 CONFIG.detailStatLimit 改成 5 或 0。
      </div>
    `;
  }

  function injectStyle() {
    if (document.querySelector('#bua-style')) {
      return;
    }

    const style = document.createElement('style');
    style.id = 'bua-style';

    style.textContent = `
      #bili-up-analysis-panel {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 999999;
        width: 438px;
        max-width: calc(100vw - 36px);
        background: #fff;
        color: #222;
        border: 1px solid #e7e7e7;
        border-radius: 12px;
        box-shadow: 0 8px 30px rgba(0,0,0,.14);
        font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", Arial, sans-serif;
        overflow: hidden;
      }

      #bili-up-analysis-panel .bua-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 12px;
        background: #fbfbfb;
        border-bottom: 1px solid #e7e7e7;
        user-select: none;
      }

      #bua-title {
        font-weight: 700;
      }

      .bua-actions {
        display: flex;
        gap: 6px;
      }

      .bua-actions button {
        border: 1px solid #d9d9d9;
        background: #fff;
        border-radius: 7px;
        padding: 3px 8px;
        cursor: pointer;
        font-size: 12px;
      }

      .bua-actions button:hover {
        border-color: #00aeec;
        color: #00aeec;
      }

      #bua-body {
        padding: 12px;
      }

      .bua-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 8px;
      }

      .bua-metric {
        border: 1px solid #eee;
        border-radius: 9px;
        padding: 7px 8px;
        background: #fff;
        min-width: 0;
      }

      .bua-label {
        color: #666;
        font-size: 12px;
        white-space: nowrap;
      }

      .bua-value {
        margin-top: 2px;
        font-size: 16px;
        font-weight: 700;
        white-space: nowrap;
      }

      .bua-value.good {
        color: #00a36c;
      }

      .bua-value.mid {
        color: #1677ff;
      }

      .bua-value.warn {
        color: #d48806;
      }

      .bua-value.bad {
        color: #cf1322;
      }

      .bua-note {
        margin-top: 10px;
        color: #666;
        font-size: 12px;
      }

      .bua-loading {
        color: #666;
        padding: 8px 2px;
      }

      .bua-error {
        color: #cf1322;
        white-space: pre-wrap;
      }

      .bua-table-title {
        margin-top: 10px;
        font-weight: 700;
      }

      .bua-table {
        width: 100%;
        border-collapse: collapse;
        margin-top: 6px;
        font-size: 12px;
      }

      .bua-table th,
      .bua-table td {
        border-top: 1px solid #eee;
        padding: 5px 3px;
        text-align: right;
        white-space: nowrap;
      }

      .bua-table th:first-child,
      .bua-table td:first-child {
        text-align: left;
        max-width: 220px;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .bua-table a {
        color: #1677ff;
        text-decoration: none;
      }

      #bili-up-analysis-panel.bua-collapsed #bua-body {
        display: none;
      }

      @media (max-width: 560px) {
        #bili-up-analysis-panel {
          width: calc(100vw - 24px);
          right: 12px;
          bottom: 12px;
        }

        .bua-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
    `;

    document.documentElement.appendChild(style);
  }

  function toTsv(r) {
    return [
      r.name,
      r.uid,
      r.follower,
      r.totalVideo,
      r.totalViews,
      r.totalLikes,
      round(r.allAvgView),
      round(r.recent.avgPlay30),
      round(r.recent.avgPlay5),
      round(r.allAvgLike),
      round(r.recent.avgLike30),
      percentText(r.allLikeRate),
      percentText(r.recent.interactionRate30),
      round(r.viewsPerFollower, 2),
      round(r.recent.avgComment30),
      round(r.recent.avgDanmaku30),
      formatTime(r.updatedAt),
    ].map(v => v ?? '').join('\t');
  }

  function getUidFromUrl() {
    const m = location.href.match(/space\.bilibili\.com\/(\d+)/);
    return m ? m[1] : '';
  }

  function unwrap(settled) {
    return settled.status === 'fulfilled' ? settled.value : null;
  }

  function numberOf(v) {
    if (v === null || v === undefined || v === '') {
      return 0;
    }

    if (typeof v === 'number') {
      return Number.isFinite(v) ? v : 0;
    }

    const s = String(v).replace(/,/g, '').trim();

    if (!s || s === '-') {
      return 0;
    }

    if (s.includes('亿')) {
      return parseFloat(s) * 100000000;
    }

    if (s.includes('万')) {
      return parseFloat(s) * 10000;
    }

    const n = parseFloat(s.replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  }

  function sum(arr, key) {
    return arr.reduce((acc, item) => acc + numberOf(item[key]), 0);
  }

  function sumKnown(arr, key) {
    return arr.reduce((acc, item) => {
      return Number.isFinite(item[key]) ? acc + item[key] : acc;
    }, 0);
  }

  function avg(total, count) {
    return count ? total / count : null;
  }

  function round(v, digits = 0) {
    if (v === null || v === undefined || !Number.isFinite(Number(v))) {
      return '';
    }

    return Number(Number(v).toFixed(digits));
  }

  function fmt(v, digits = 0) {
    if (v === null || v === undefined || !Number.isFinite(Number(v))) {
      return '-';
    }

    return new Intl.NumberFormat('zh-CN', {
      maximumFractionDigits: digits,
    }).format(Number(v));
  }

  function pct(v) {
    if (v === null || v === undefined || !Number.isFinite(Number(v))) {
      return '-';
    }

    return new Intl.NumberFormat('zh-CN', {
      style: 'percent',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Number(v));
  }

  function percentText(v) {
    if (v === null || v === undefined || !Number.isFinite(Number(v))) {
      return '';
    }

    return `${(Number(v) * 100).toFixed(2)}%`;
  }

  function playClass(v) {
    v = Number(v);

    if (!Number.isFinite(v)) return '';
    if (v >= 100000) return 'good';
    if (v >= 30000) return 'mid';
    if (v >= 10000) return 'warn';

    return 'bad';
  }

  function likeClass(v) {
    v = Number(v);

    if (!Number.isFinite(v)) return '';
    if (v >= 3000) return 'good';
    if (v >= 1000) return 'mid';
    if (v >= 300) return 'warn';

    return 'bad';
  }

  function ratioClass(v) {
    v = Number(v);

    if (!Number.isFinite(v)) return '';
    if (v >= 0.05) return 'good';
    if (v >= 0.03) return 'mid';
    if (v >= 0.015) return 'warn';

    return 'bad';
  }

  function rateClass(v, [a, b, c]) {
    v = Number(v);

    if (!Number.isFinite(v)) return '';
    if (v >= c) return 'good';
    if (v >= b) return 'mid';
    if (v >= a) return 'warn';

    return 'bad';
  }

  function shortText(s, len) {
    s = String(s || '');
    return s.length > len ? `${s.slice(0, len)}...` : s;
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

  function formatTime(date) {
    const d = date instanceof Date ? date : new Date(date);
    const pad = n => String(n).padStart(2, '0');

    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function flashCopyButton(text) {
    const btn = document.querySelector('#bua-copy');
    const old = btn.textContent;

    btn.textContent = text;

    setTimeout(() => {
      btn.textContent = old;
    }, 900);
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
})();
