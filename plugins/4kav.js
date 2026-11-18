export const meta = {
  id: '4k-av',
  name: '4K-AV',
  version: '1.1.2',
  protocol: 1,
  description: '4K-AV 影视源：首页、分类、搜索、详情与直链播放。',
  author: 'community',
  kind: 'source',
  linkDomains: ['4k-av.com', 'www.4k-av.com'],
  defaultHeaders: {
    Referer: 'https://4k-av.com/',
    Origin: 'https://4k-av.com',
    Accept: '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
  },
  timeouts: { read: 20, playback: 30 },
};

const SITE = 'https://4k-av.com';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1';
const LANGUAGE = 'zh-CN,zh;q=0.9,en;q=0.8';

// 根据当前页面分类及导航调整的标签定义
const TABS = [
  { id: 'home', label: '首页', path: '' },
  { id: 'tv', label: '电视剧', path: '/tv', type: 'series' },
  { id: 'movie', label: '电影', path: '/movie', type: 'movie' },
  { id: 'av', label: 'AV', path: '/av', type: 'movie' },
];

export default function (hg) {
  function origin() {
    const cur = hg.endpoint && hg.endpoint.current;
    if (cur && typeof cur.url === 'string' && cur.url) return cur.url.replace(/\/$/, '');
    return SITE;
  }

  function pageHeaders(referer) {
    return {
      'User-Agent': UA,
      Referer: referer || origin() + '/',
      Origin: origin(),
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': LANGUAGE,
    };
  }

  function mediaHeaders(referer) {
    return {
      'User-Agent': UA,
      Referer: referer || origin() + '/',
      Origin: origin(),
      Accept: '*/*',
      'Accept-Language': LANGUAGE,
    };
  }

  function fail(code, message, extra) {
    throw new hg.PluginError(code, message, extra);
  }

  async function fetchHtml(url, ctx) {
    const res = await hg.http.fetch({
      url,
      headers: pageHeaders(url),
      responseType: 'text',
      timeoutMs: 15000,
      retry: 1,
      maxBytes: 8 * 1024 * 1024,
      signal: ctx && ctx.signal,
    });
    if (!res.ok) fail('UPSTREAM_ERROR', '页面暂时不可用（HTTP ' + res.status + '）');
    return res.data;
  }

  function absUrl(href) {
    if (!href) return '';
    // 保留站点返回的完整主机名，避免播放域名被改写后触发防盗链。
    if (/^https?:\/\//i.test(href)) return href;
    if (href.startsWith('//')) return 'https:' + href;
    const o = origin();
    return href.startsWith('/') ? o + href : o + '/' + href;
  }

  function mediaIdFromHref(href) {
    try {
      const u = new URL(absUrl(href));
      return u.pathname.replace(/\/$/, '') || href;
    } catch (_) {
      return String(href || '');
    }
  }

  // 解析当前页面的视频卡片列表
  function parseCards(html, typeHint) {
    const doc = hg.html.parse(html);
    const items = [];
    // 匹配页面中的视频列表项
    const nodes = doc.select('.virow .NTMitem, .NTMitem');
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      const a = el.first('a');
      const href = a && a.attr('href');
      const titleEl = el.first('.title h2') || el.first('.title') || el.first('h2') || el.first('h3') || a;
      const title = titleEl ? titleEl.text() : '';
      if (!href || !title) continue;
      
      const img = el.first('img');
      const cover = img && (img.attr('src') || img.attr('data-src'));
      
      const item = {
        id: mediaIdFromHref(href),
        title: title.trim(),
        type: typeHint || 'movie',
      };
      if (cover) item.cover = absUrl(cover);
      items.push(item);
    }
    return items;
  }

  function parseLastPage(html) {
    const doc = hg.html.parse(html);
    const nav = doc.first('.page-number') || doc.first('a[href*="page-"]');
    if (!nav) return 1;
    const text = nav.text();
    const parts = text.split('/');
    const n = parseInt(parts[parts.length - 1], 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
  }

  function pageOf(cursor) {
    if (!cursor) return { page: 1, last: 0 };
    const parts = String(cursor).split(':');
    const page = parseInt(parts[0], 10);
    const last = parseInt(parts[1], 10);
    return {
      page: Number.isFinite(page) && page > 0 ? page : 1,
      last: Number.isFinite(last) && last > 0 ? last : 0,
    };
  }

  function tabOf(categoryId) {
    for (let i = 0; i < TABS.length; i++) {
      if (TABS[i].id === categoryId) return TABS[i];
    }
    return TABS[0];
  }

  async function listByTab(tab, cursor, ctx) {
    const cur = pageOf(cursor);
    let url = origin() + tab.path;
    if (cur.page > 1) {
      let last = cur.last;
      if (!last) {
        const firstHtml = await fetchHtml(url, ctx);
        last = parseLastPage(firstHtml);
      }
      url += '/page-' + (last - cur.page + 1) + '.html';
      const html = await fetchHtml(url, ctx);
      const items = parseCards(html, tab.type);
      const nextPage = cur.page + 1;
      return {
        items,
        next: nextPage <= last ? nextPage + ':' + last : null,
      };
    }
    const html = await fetchHtml(url, ctx);
    const last = parseLastPage(html);
    const items = parseCards(html, tab.type);
    return {
      items,
      next: last > 1 ? '2:' + last : null,
    };
  }

  function guessFormat(url) {
    if (/\.m3u8(\?|$)/i.test(url)) return 'hls';
    if (/\.mp4(\?|$)/i.test(url)) return 'progressive';
    return 'progressive';
  }

  return {
    endpoints: {
      list() {
        return [{ id: 'main', label: '主站', url: SITE }];
      },
    },

    home: {
      async getSections(params, ctx) {
        const latest = await listByTab(TABS[0], '1', ctx);
        return { items: [
            { id: 'latest', title: '最新视频', layout: 'grid', items: latest.items },
          ], next: null };
      },
    },

    catalog: {
      async getCategories() {
        return TABS.map(function (t) {
            return { id: t.id, label: t.label };
          });
      },
      async list(params, ctx) {
        const tab = tabOf(params && params.categoryId);
        return listByTab(tab, params && params.cursor, ctx);
      },
    },

    search: {
      async search(params, ctx) {
        const q = params && params.query ? String(params.query).trim() : '';
        if (!q) return { items: [], next: null };
        const html = await fetchHtml(origin() + '/s?u=' + encodeURIComponent(q), ctx);
        return { items: parseCards(html), next: null };
      },
    },

    media: {
      async getDetail(params, ctx) {
        const id = params && params.id;
        if (!id) fail('INVALID_ARGUMENT', '缺少作品 ID');
        const url = absUrl(id);
        const html = await fetchHtml(url, ctx);
        const doc = hg.html.parse(html);
        
        const titleEl = doc.first('h1') || doc.first('h2') || doc.first('title');
        const title = titleEl ? titleEl.text().trim() : String(id);
        
        const coverEl = doc.first('.poster img') || doc.first('video');
        const cover = coverEl && (coverEl.attr('poster') || coverEl.attr('src'));
        
        const descEl = doc.first('.videodesc') || doc.first('.intro');
        
        // 尝试解析选集/剧集列表
        const playlist = doc.select('#rtlist li, .playlist li');
        const episodes = [];
        if (playlist.length) {
          for (let i = 0; i < playlist.length; i++) {
            const li = playlist[i];
            const a = li.first('a') || li;
            const span = li.first('span');
            const label = span ? span.text().trim() : (a ? a.text().trim() : String(i + 1));
            episodes.push({
              id: mediaIdFromHref(a.attr('href') || url),
              index: i + 1,
              episodeNumber: i + 1,
              label: label,
            });
          }
        } else {
          episodes.push({ id: mediaIdFromHref(url), index: 1, episodeNumber: 1, label: '播放' });
        }

        const detail = {
          id: mediaIdFromHref(id),
          title,
          type: episodes.length > 1 ? 'series' : 'movie',
          playlists: [{ id: 'main', label: '默认', episodes }],
        };
        if (cover) detail.cover = absUrl(cover);
        if (descEl) {
          const desc = descEl.text().trim();
          if (desc) detail.description = desc;
        }
        return detail;
      },

      async resolvePlayback(params, ctx) {
        const episodeId = params && params.episodeId;
        if (!episodeId) fail('INVALID_ARGUMENT', '缺少分集 ID');
        const url = absUrl(episodeId);
        const html = await fetchHtml(url, ctx);
        const doc = hg.html.parse(html);
        
        const source = doc.first('video source') || doc.first('video') || doc.first('iframe');
        const playUrl = source && (source.attr('src') || source.attr('data-src') || source.attr('href'));
        if (!playUrl) fail('UPSTREAM_CHANGED', '未解析到播放地址');
        
        const href = absUrl(playUrl);
        return {
          streams: [{
            url: href,
            kind: 'media',
            format: guessFormat(href),
            // 播放列表和分片沿用详情页来源，满足上游防盗链校验。
            headers: mediaHeaders(url),
          }],
        };
      },

      matchUrl(params) {
        const raw = params && params.url;
        if (!raw) return null;
        try {
          const u = new URL(raw);
          if (!/4k-av\.com$/i.test(u.hostname)) return null;
          if (u.pathname === '/' || u.pathname === '') return null;
          return { mediaId: u.pathname.replace(/\/$/, '') };
        } catch (_) {
          return null;
        }
      },
    },
  };
}
