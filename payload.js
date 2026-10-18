/* ===== BEGIN tv-adblock (injected; remove this block to revert) ===== */
(() => {
  try {
    const { app } = require('electron');
    const fs = require('fs');
    const path = require('path');

    const DEBUG = process.env.TV_ADBLOCK_LOG === '1';
    const OFF = process.env.TV_ADBLOCK_DISABLE === '1';
    if (OFF) return;

    const userData = app.getPath('userData');
    const EXTRA_HOSTS_FILE = path.join(userData, 'adblock-extra-hosts.txt');
    const EXTRA_CSS_FILE = path.join(userData, 'adblock-extra.css');
    const LOG_FILE = path.join(userData, 'adblock-requests.log');

    /* ---------- network blocklist ---------- */

    // Matched against the request hostname: exact match, or any subdomain of it.
    const BLOCK_HOSTS = [
      // --- ad serving / ad exchanges ---
      'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
      'googletagservices.com', 'adservice.google.com', '2mdn.net',
      'amazon-adsystem.com', 'adnxs.com', 'adsrvr.org', 'rubiconproject.com',
      'pubmatic.com', 'openx.net', 'casalemedia.com', 'smartadserver.com',
      'sharethrough.com', 'bidswitch.net', 'criteo.com', 'criteo.net',
      'taboola.com', 'outbrain.com', 'teads.tv', 'media.net', 'mgid.com',
      'revcontent.com', 'adroll.com', 'zemanta.com', 'propellerads.com',
      'ads-twitter.com', 'analytics.twitter.com', 'ct.pinterest.com',
      'ads.linkedin.com', 'px.ads.linkedin.com', 'snap.licdn.com',
      'bat.bing.com', 'tr.snapchat.com', 'sc-static.net',

      // --- analytics / session recording / attribution ---
      'google-analytics.com', 'googletagmanager.com', 'analytics.google.com',
      'hotjar.com', 'hotjar.io', 'amplitude.com', 'mixpanel.com',
      'segment.com', 'segment.io', 'fullstory.com', 'logrocket.com',
      'mouseflow.com', 'clarity.ms', 'quantserve.com', 'scorecardresearch.com',
      'crazyegg.com', 'luckyorange.com', 'inspectlet.com', 'statcounter.com',
      'heap.io', 'heapanalytics.com', 'chartbeat.com', 'parsely.com',
      'cxense.com', 'permutive.com', 'tealium.com', 'krxd.net', 'demdex.net',
      'omtrdc.net', 'everesttech.net', 'adobedtm.com', '2o7.net',
      'optimizely.com', 'branch.io', 'appsflyer.com', 'adjust.com',
      'onesignal.com', 'newrelic.com', 'nr-data.net', 'mc.yandex.ru',
      'matomo.cloud', 'plausible.io',
      // TradingView's own Snowplow behavioural tracking pixel (no UI role).
      'snowplow-pixel.tradingview.com',

      // --- crash/telemetry reporting (not ads; delete these 4 lines to keep) ---
      'sentry.io', 'ingest.sentry.io', 'datadoghq.com',
      'browser-intake-datadoghq.com',
      'telemetry.tradingview.com',
    ];

    // Full-URL regexes. Used for hosts we must NOT block wholesale (e.g. Google
    // and Facebook, which also serve login), where only one path is a tracker.
    const BLOCK_URL_RE = [
      /^https?:\/\/connect\.facebook\.net\/[^/]*\/fbevents\.js/i,
      /^https?:\/\/(www\.)?facebook\.com\/tr[/?]/i,
      /^https?:\/\/(www\.)?google\.[a-z.]+\/(pagead|ads)\//i,
      /\/(adsbygoogle|gtag\/js|gtm\.js|analytics\.js|fbevents\.js)(\?|$)/i,
    ];

    let extraHosts = [];
    function loadExtraHosts() {
      try {
        extraHosts = fs.readFileSync(EXTRA_HOSTS_FILE, 'utf8')
          .split('\n')
          .map((l) => l.replace(/#.*$/, '').trim().toLowerCase())
          .filter(Boolean);
      } catch { extraHosts = []; }
    }
    loadExtraHosts();

    function hostBlocked(host) {
      for (const list of [BLOCK_HOSTS, extraHosts]) {
        for (const h of list) {
          if (host === h || host.endsWith('.' + h)) return true;
        }
      }
      return false;
    }

    function shouldBlock(url) {
      let u;
      try { u = new URL(url); } catch { return false; }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      if (hostBlocked(u.hostname.toLowerCase())) return true;
      for (const re of BLOCK_URL_RE) if (re.test(url)) return true;
      return false;
    }

    /* ---------- request logging (TV_ADBLOCK_LOG=1) ---------- */

    const seen = new Set();
    function logReq(verdict, url, type) {
      if (!DEBUG) return;
      try {
        const host = new URL(url).hostname;
        const key = verdict + ' ' + host + ' ' + type;
        if (seen.has(key)) return;
        seen.add(key);
        fs.appendFileSync(LOG_FILE, `${verdict}\t${type}\t${host}\n`);
      } catch { /* ignore */ }
    }

    /* ---------- install the filter on every session ---------- */

    const hooked = new WeakSet();

    function hookSession(sess) {
      if (!sess || hooked.has(sess)) return;
      hooked.add(sess);
      try {
        const wr = sess.webRequest;
        // The app does not currently use onBeforeRequest, but Electron allows
        // only one listener per session: if a future version registers one it
        // would silently replace ours. Capture it and chain instead.
        const register = wr.onBeforeRequest.bind(wr);
        let downstream = null;

        register((details, callback) => {
          if (shouldBlock(details.url)) {
            logReq('BLOCK', details.url, details.resourceType);
            return callback({ cancel: true });
          }
          logReq('ok', details.url, details.resourceType);
          if (downstream) {
            try { return downstream(details, callback); } catch { return callback({}); }
          }
          callback({});
        });

        wr.onBeforeRequest = (a, b) => {
          const listener = typeof a === 'function' ? a : b;
          downstream = typeof listener === 'function' ? listener : null;
        };
      } catch (e) {
        try { console.error('[tv-adblock] session hook failed:', e); } catch {}
      }
    }

    app.on('session-created', hookSession);
    app.on('ready', () => {
      try { hookSession(require('electron').session.defaultSession); } catch {}
    });

    /* ---------- cosmetic filtering ---------- */

    // Deliberately narrow. With the ad scripts blocked at the network layer the
    // chart page renders no ad containers at all (verified: 0 matches over 1297
    // elements), so these only collapse leftover slots on the non-chart pages.
    // Broader "hide the upsell UI" rules are shipped commented-out in
    // adblock-extra.css instead - they risk hiding real navigation.
    const BUILTIN_CSS = `
[id*="div-gpt-ad"], ins.adsbygoogle, [id^="google_ads"],
iframe[src*="doubleclick.net"], iframe[src*="googlesyndication.com"],
[class*="adBanner"], [class*="ad-banner"], [data-name="ads"],
.tv-ad, .tv-ads, .tv-footer-ad {
  display: none !important;
}

/* "Trade" and "Upgrade" buttons in the top-right of the chart toolbar.
 * These hide the outer container, not the inner <button>, so the toolbar
 * closes up instead of leaving a gap. TradingView suffixes its class names
 * with a build hash (desktopUpgrade-P4LQzYFS), hence the prefix match. */
#header-toolbar-trade-desktop,
[class*="desktopTrade-"],
[class*="desktopUpgrade-"] {
  display: none !important;
}
`;

    function cosmeticCSS() {
      let extra = '';
      try { extra = fs.readFileSync(EXTRA_CSS_FILE, 'utf8'); } catch { /* none */ }
      return BUILTIN_CSS + '\n' + extra;
    }

    const TV_URL = /^https?:\/\/([a-z0-9-]+\.)*tradingview\.com(\/|$)/i;

    app.on('web-contents-created', (_e, wc) => {
      const apply = () => {
        try {
          if (process.env.TV_ADBLOCK_NOCSS === '1') return; // for the DOM probe
          if (!TV_URL.test(wc.getURL() || '')) return;
          wc.insertCSS(cosmeticCSS(), { cssOrigin: 'user' });
        } catch { /* ignore */ }
      };
      wc.on('dom-ready', apply);
      wc.on('did-navigate', apply);
      wc.on('did-navigate-in-page', apply);
      if (DEBUG) wc.on('dom-ready', () => setTimeout(() => probe(wc), 8000));
    });

    // TV_ADBLOCK_LOG=1 only: report elements that look like ad/promo containers
    // and still occupy space, so the cosmetic rules above can be verified.
    function probe(wc) {
      try {
        if (!TV_URL.test(wc.getURL() || '')) return;
        wc.executeJavaScript(`(() => {
          const hit = /\\b(ad|ads|advert|promo|banner|upsell|upgrade|gopro|go-pro)\\b|adBanner|promoBanner/i;
          const out = [];
          for (const el of document.querySelectorAll('div,section,aside,iframe,ins')) {
            const sig = (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '')
              + ' ' + (el.id || '') + ' ' + (el.getAttribute('data-name') || '');
            if (!hit.test(sig)) continue;
            const r = el.getBoundingClientRect();
            if (r.width * r.height < 1000) continue;
            out.push(Math.round(r.width) + 'x' + Math.round(r.height) + '  <' + el.tagName.toLowerCase() + '> ' + sig.trim().slice(0, 160));
          }
          const slots = [...document.querySelectorAll('[id*="div-gpt-ad"],ins.adsbygoogle,[id^="google_ads"]')]
            .map((e) => 'GPT SLOT ' + (e.id || e.className) + ' ' + Math.round(e.getBoundingClientRect().height) + 'px');

          // Locate named toolbar buttons (e.g. "Trade" / "Upgrade") and report
          // enough of the ancestor chain to build a precise selector for them.
          const wanted = ${JSON.stringify(
            (process.env.TV_ADBLOCK_PROBE_TEXT || 'Trade,Upgrade')
              .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
          )};
          const desc = (e) => e.tagName.toLowerCase()
            + (e.id ? '#' + e.id : '')
            + (e.getAttribute('data-name') ? '[data-name="' + e.getAttribute('data-name') + '"]' : '')
            + (e.getAttribute('href') ? '[href="' + e.getAttribute('href').slice(0, 60) + '"]' : '')
            + '.' + String(e.className && e.className.baseVal !== undefined ? e.className.baseVal : e.className || '')
                .trim().split(/\\s+/).join('.');
          const btns = [];
          for (const el of document.querySelectorAll('button,a,div[role="button"],span[role="button"]')) {
            const txt = (el.textContent || '').trim();
            if (!wanted.includes(txt.toLowerCase())) continue;
            const r = el.getBoundingClientRect();
            if (!r.width) continue;
            const chain = [];
            let p = el;
            for (let i = 0; i < 4 && p; i++) { chain.push(desc(p)); p = p.parentElement; }
            btns.push('BUTTON "' + txt + '" @' + Math.round(r.left) + ',' + Math.round(r.top)
              + ' ' + Math.round(r.width) + 'x' + Math.round(r.height)
              + '\\n    ' + chain.join('\\n      < '));
          }
          return 'scanned=' + document.querySelectorAll('div,section,aside,iframe,ins').length
            + ' matches=' + out.length + ' buttons=' + btns.length
            + '\\n' + out.slice(0, 40).concat(slots).concat(btns).join('\\n');
        })()`, true).then((res) => {
          fs.appendFileSync(LOG_FILE, '\n--- AD CANDIDATES ' + wc.getURL().slice(0, 80) + ' ---\n' + res + '\n');
        }).catch((e) => {
          try { fs.appendFileSync(LOG_FILE, '\n--- PROBE FAILED: ' + e + '\n'); } catch {}
        });
      } catch { /* ignore */ }
    }

    try { console.log('[tv-adblock] active' + (DEBUG ? ' (logging to ' + LOG_FILE + ')' : '')); } catch {}
  } catch (e) {
    try { console.error('[tv-adblock] init failed:', e); } catch {}
  }
})();
/* ===== END tv-adblock ===== */
