/* ================================================================
   Tab Out — Dashboard App (Pure Extension Edition)

   This file is the brain of the dashboard. Now that the dashboard
   IS the extension page (not inside an iframe), it can call
   chrome.tabs and chrome.storage directly — no postMessage bridge needed.

   What this file does:
   1. Reads open browser tabs directly via chrome.tabs.query()
   2. Groups tabs by domain with a landing pages category
   3. Renders domain cards, banners, and stats
   4. Handles all user actions (close tabs, save for later, focus tab)
   5. Stores "Saved for Later" tabs in chrome.storage.local (no server)
   ================================================================ */

'use strict';


/* ----------------------------------------------------------------
   CHROME TABS — Direct API Access

   Since this page IS the extension's new tab page, it has full
   access to chrome.tabs and chrome.storage. No middleman needed.
   ---------------------------------------------------------------- */

// All open tabs — populated by fetchOpenTabs()
let openTabs = [];

const REALTIME_REFRESH_DEBOUNCE_MS = 250;
const ACCESS_STATUS_REFRESH_MS = 60000;
const DEFERRED_ALL_GROUP_ID = '__all__';
const DEFAULT_DEFERRED_REMARK = '默认';
const BOOKMARKS_PREVIEW_LIMIT = 10;
const DEFAULT_MODULE_PREFS = {
  browserBookmarks: { visible: true, collapsed: true },
  quickLinks:       { visible: true, collapsed: false },
  deferred:         { visible: true, collapsed: false },
};
let realtimeRefreshTimer = null;
let bookmarkRefreshTimer = null;
let dashboardRenderPromise = null;
let dashboardRenderQueued = false;
let selectedDeferredGroupId = DEFERRED_ALL_GROUP_ID;
let deferredRemarkFilters = new Map();
let deferredRemarkDialogState = null;
let isDeferredItemSorting = false;
let deferredItemDragState = null;
let quickLinkDragState = null;
let suppressNextQuickLinkOpen = false;
let quickLinkTitleManuallyEdited = false;
let selectedBookmarkFolderId = null;
let selectedBookmarkFolderTitle = '书签栏';
let bookmarksExpanded = false;
let modulePrefs = {
  browserBookmarks: { ...DEFAULT_MODULE_PREFS.browserBookmarks },
  quickLinks:       { ...DEFAULT_MODULE_PREFS.quickLinks },
  deferred:         { ...DEFAULT_MODULE_PREFS.deferred },
};

/**
 * fetchOpenTabs()
 *
 * Reads all currently open browser tabs directly from Chrome.
 * Sets the extensionId flag so we can identify Tab Out's own pages.
 */
async function fetchOpenTabs() {
  try {
    const extensionId = chrome.runtime.id;
    // The new URL for this page is now index.html (not newtab.html)
    const newtabUrl = `chrome-extension://${extensionId}/index.html`;

    const tabs = await chrome.tabs.query({});
    openTabs = tabs.map(t => ({
      id:       t.id,
      url:      t.url,
      title:    t.title,
      windowId: t.windowId,
      active:   t.active,
      lastAccessed: t.lastAccessed,
      // Flag Tab Out's own pages so we can detect duplicate new tabs
      isTabOut: t.url === newtabUrl || t.url === 'chrome://newtab/',
    }));
  } catch {
    // chrome.tabs API unavailable (shouldn't happen in an extension page)
    openTabs = [];
  }
}

/**
 * closeTabsByUrls(urls)
 *
 * Closes all open tabs whose hostname matches any of the given URLs.
 * After closing, re-fetches the tab list to keep our state accurate.
 *
 * Special case: file:// URLs are matched exactly (they have no hostname).
 */
async function closeTabsByUrls(urls) {
  if (!urls || urls.length === 0) return;

  // Separate file:// URLs (exact match) from regular URLs (hostname match)
  const targetHostnames = [];
  const exactUrls = new Set();

  for (const u of urls) {
    if (u.startsWith('file://')) {
      exactUrls.add(u);
    } else {
      try { targetHostnames.push(new URL(u).hostname); }
      catch { /* skip unparseable */ }
    }
  }

  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs
    .filter(tab => {
      const tabUrl = tab.url || '';
      if (tabUrl.startsWith('file://') && exactUrls.has(tabUrl)) return true;
      try {
        const tabHostname = new URL(tabUrl).hostname;
        return tabHostname && targetHostnames.includes(tabHostname);
      } catch { return false; }
    })
    .map(tab => tab.id);

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabsExact(urls)
 *
 * Closes tabs by exact URL match (not hostname). Used for landing pages
 * so closing "Gmail inbox" doesn't also close individual email threads.
 */
async function closeTabsExact(urls) {
  if (!urls || urls.length === 0) return;
  const urlSet = new Set(urls);
  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs.filter(t => urlSet.has(t.url)).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * focusTab(url)
 *
 * Switches Chrome to the tab with the given URL (exact match first,
 * then hostname fallback). Also brings the window to the front.
 */
async function focusTab(url) {
  if (!url) return;
  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();

  // Try exact URL match first
  let matches = allTabs.filter(t => t.url === url);

  // Fall back to hostname match
  if (matches.length === 0) {
    try {
      const targetHost = new URL(url).hostname;
      matches = allTabs.filter(t => {
        try { return new URL(t.url).hostname === targetHost; }
        catch { return false; }
      });
    } catch {}
  }

  if (matches.length === 0) return;

  // Prefer a match in a different window so it actually switches windows
  const match = matches.find(t => t.windowId !== currentWindow.id) || matches[0];
  await chrome.tabs.update(match.id, { active: true });
  await chrome.windows.update(match.windowId, { focused: true });
}

/**
 * closeDuplicateTabs(urls, keepOne)
 *
 * Closes duplicate tabs for the given list of URLs.
 * keepOne=true → keep one copy of each, close the rest.
 * keepOne=false → close all copies.
 */
async function closeDuplicateTabs(urls, keepOne = true) {
  const allTabs = await chrome.tabs.query({});
  const toClose = [];

  for (const url of urls) {
    const matching = allTabs.filter(t => t.url === url);
    if (keepOne) {
      const keep = matching.find(t => t.active) || matching[0];
      for (const tab of matching) {
        if (tab.id !== keep.id) toClose.push(tab.id);
      }
    } else {
      for (const tab of matching) toClose.push(tab.id);
    }
  }

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabOutDupes()
 *
 * Closes all duplicate Tab Out new-tab pages except the current one.
 */
async function closeTabOutDupes() {
  const extensionId = chrome.runtime.id;
  const newtabUrl = `chrome-extension://${extensionId}/index.html`;

  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();
  const tabOutTabs = allTabs.filter(t =>
    t.url === newtabUrl || t.url === 'chrome://newtab/'
  );

  if (tabOutTabs.length <= 1) return;

  // Keep the active Tab Out tab in the CURRENT window — that's the one the
  // user is looking at right now. Falls back to any active one, then the first.
  const keep =
    tabOutTabs.find(t => t.active && t.windowId === currentWindow.id) ||
    tabOutTabs.find(t => t.active) ||
    tabOutTabs[0];
  const toClose = tabOutTabs.filter(t => t.id !== keep.id).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — chrome.storage.local

   Replaces the old server-side SQLite + REST API with Chrome's
   built-in key-value storage. Data persists across browser sessions
   and doesn't require a running server.

   Data shape stored under the "deferred" key:
   [
     {
       id: "1712345678901",          // timestamp-based unique ID
       url: "https://example.com",
       title: "Example Page",
       savedAt: "2026-04-04T10:00:00.000Z",  // ISO date string
       remark: "Q3 review",          // optional note/tag, defaults to "默认"
       sortIndex: 0,                 // optional custom order within same-domain group
       completed: false,             // true = checked off (archived)
       dismissed: false              // true = dismissed without reading
     },
     ...
   ]
   ---------------------------------------------------------------- */

/**
 * saveTabForLater(tab)
 *
 * Saves a single tab to the "Saved for Later" list in chrome.storage.local.
 * @param {{ url: string, title: string, remark?: string }} tab
 */
async function saveTabForLater(tab) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  deferred.push({
    id:        Date.now().toString(),
    url:       tab.url,
    title:     tab.title,
    savedAt:   new Date().toISOString(),
    remark:    normalizeDeferredRemark(tab.remark),
    completed: false,
    dismissed: false,
  });
  await chrome.storage.local.set({ deferred });
}

/**
 * getSavedTabs()
 *
 * Returns all saved tabs from chrome.storage.local.
 * Filters out dismissed items (those are gone for good).
 * Splits into active (not completed) and archived (completed).
 */
async function getSavedTabs() {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const visible = deferred.filter(t => !t.dismissed);
  return {
    active:   visible.filter(t => !t.completed),
    archived: visible.filter(t => t.completed),
  };
}

/**
 * checkOffSavedTab(id)
 *
 * Marks a saved tab as completed (checked off). It moves to the archive.
 */
async function checkOffSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.completed = true;
    tab.completedAt = new Date().toISOString();
    await chrome.storage.local.set({ deferred });
  }
}

/**
 * dismissSavedTab(id)
 *
 * Marks a saved tab as dismissed (removed from all lists).
 */
async function dismissSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.dismissed = true;
    await chrome.storage.local.set({ deferred });
  }
}

async function updateSavedTabRemark(id, remark) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (!tab) return null;

  tab.remark = normalizeDeferredRemark(remark);
  await chrome.storage.local.set({ deferred });
  return tab;
}

async function renameDeferredRemarkGroup(groupId, oldRemark, newRemark) {
  const normalizedOld = normalizeDeferredRemark(oldRemark);
  const normalizedNew = normalizeDeferredRemark(newRemark);
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  let updatedCount = 0;

  for (const item of deferred) {
    if (
      !item.dismissed &&
      getDeferredGroupId(item) === groupId &&
      getDeferredRemark(item) === normalizedOld
    ) {
      item.remark = normalizedNew;
      updatedCount += 1;
    }
  }

  if (updatedCount > 0) await chrome.storage.local.set({ deferred });
  return { remark: normalizedNew, updatedCount };
}


/* ----------------------------------------------------------------
   QUICK LINKS — chrome.storage.local

   User-defined navigation shortcuts shown above the open-tabs dashboard.
   Stored under the "quickLinks" key:
   [
     { id, title, url, createdAt }
   ]
   ---------------------------------------------------------------- */

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getFaviconUrl(pageUrl, size = 16) {
  if (
    !pageUrl ||
    typeof chrome === 'undefined' ||
    !chrome.runtime ||
    !chrome.runtime.id
  ) {
    return '';
  }

  try {
    const parsed = new URL(pageUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';

    return `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(parsed.href)}&size=${size}`;
  } catch {
    return '';
  }
}

function renderFavicon(pageUrl, className, size = 16, extraAttrs = '') {
  const faviconUrl = getFaviconUrl(pageUrl, size);
  if (!faviconUrl) return '';

  return `<img class="${className}" src="${escapeHtml(faviconUrl)}" alt="" ${extraAttrs} onerror="this.style.display='none'">`;
}

function normalizeModulePrefs(rawPrefs = {}) {
  return Object.fromEntries(Object.entries(DEFAULT_MODULE_PREFS).map(([moduleId, defaults]) => {
    const stored = rawPrefs[moduleId] || {};
    return [moduleId, {
      visible: typeof stored.visible === 'boolean' ? stored.visible : defaults.visible,
      collapsed: typeof stored.collapsed === 'boolean' ? stored.collapsed : defaults.collapsed,
    }];
  }));
}

async function loadModulePrefs() {
  try {
    const { dashboardModulePrefs = {} } = await chrome.storage.local.get('dashboardModulePrefs');
    modulePrefs = normalizeModulePrefs(dashboardModulePrefs);
  } catch {
    modulePrefs = normalizeModulePrefs();
  }
}

async function saveModulePrefs() {
  await chrome.storage.local.set({ dashboardModulePrefs: modulePrefs });
}

function applyModuleState(moduleId) {
  const pref = modulePrefs[moduleId] || DEFAULT_MODULE_PREFS[moduleId];
  if (!pref) return false;

  const section = document.querySelector(`[data-module-section="${moduleId}"]`);
  const body = document.querySelector(`[data-module-body="${moduleId}"]`);
  const hiddenNotice = document.querySelector(`[data-module-hidden-notice="${moduleId}"]`);
  const collapseToggle = document.querySelector(`[data-module-collapse-toggle="${moduleId}"]`);

  if (section) section.style.display = pref.visible ? 'block' : 'none';
  if (hiddenNotice) hiddenNotice.style.display = pref.visible ? 'none' : 'flex';
  if (body) body.style.display = pref.visible && !pref.collapsed ? 'block' : 'none';
  if (collapseToggle) collapseToggle.textContent = pref.collapsed ? '展开' : '收起';

  return pref.visible;
}

function normalizeQuickLinkUrl(rawUrl) {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) throw new Error('请输入网址');

  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  let parsed;
  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new Error('网址格式不正确');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('只支持 http 或 https 网址');
  }

  return parsed.href;
}

function titleFromQuickLinkUrl(url) {
  try {
    const parsed = new URL(url);
    const domain = parsed.hostname.replace(/^www\./, '');
    const friendly = friendlyDomain(domain);
    if (friendly && friendly !== domain) return friendly;

    const mainPart = domain.split('.')[0] || domain;
    return mainPart
      .split(/[-_]/)
      .filter(Boolean)
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ') || domain;
  } catch {
    return '';
  }
}

async function inferQuickLinkTitle(rawUrl) {
  const normalizedUrl = normalizeQuickLinkUrl(rawUrl);
  const normalizedWithoutHash = normalizedUrl.split('#')[0];

  const matchingTab = openTabs.find(tab => {
    const tabUrl = tab.url || '';
    return tabUrl === normalizedUrl || tabUrl.split('#')[0] === normalizedWithoutHash;
  });

  if (matchingTab && matchingTab.title) {
    return cleanTitle(smartTitle(stripTitleNoise(matchingTab.title), normalizedUrl), '');
  }

  if (hasBookmarksApi() && chrome.bookmarks.search) {
    try {
      const matches = await chrome.bookmarks.search({ url: normalizedUrl });
      const bookmark = Array.isArray(matches) ? matches.find(node => node.url === normalizedUrl && node.title) : null;
      if (bookmark) return bookmark.title;
    } catch {}
  }

  return titleFromQuickLinkUrl(normalizedUrl);
}

async function maybeAutofillQuickLinkTitle({ force = false } = {}) {
  const editingInput = document.getElementById('quickLinkEditingId');
  const titleInput = document.getElementById('quickLinkTitle');
  const urlInput = document.getElementById('quickLinkUrl');
  if (!titleInput || !urlInput) return;
  if (editingInput && editingInput.value && !force) return;
  if (quickLinkTitleManuallyEdited && !force) return;

  const rawUrl = urlInput.value.trim();
  if (!rawUrl) return;

  try {
    const inferredTitle = await inferQuickLinkTitle(rawUrl);
    if (inferredTitle) titleInput.value = inferredTitle;
  } catch {
    // Keep the form quiet while the user is still typing an incomplete URL.
  }
}

async function getQuickLinks() {
  const { quickLinks = [] } = await chrome.storage.local.get('quickLinks');
  return Array.isArray(quickLinks) ? quickLinks : [];
}

async function addQuickLink({ title, url }) {
  const normalizedUrl = normalizeQuickLinkUrl(url);
  const cleanTitle = String(title || '').trim() || await inferQuickLinkTitle(normalizedUrl);
  if (!cleanTitle) throw new Error('请输入名称');

  const quickLinks = await getQuickLinks();
  const alreadyExists = quickLinks.some(link => link.url === normalizedUrl);
  if (alreadyExists) throw new Error('这个网址已经在常用导航里了');

  quickLinks.push({
    id:        Date.now().toString(),
    title:     cleanTitle,
    url:       normalizedUrl,
    createdAt: new Date().toISOString(),
  });

  await chrome.storage.local.set({ quickLinks });
}

async function updateQuickLink(id, { title, url }) {
  const normalizedUrl = normalizeQuickLinkUrl(url);
  const cleanTitle = String(title || '').trim() || await inferQuickLinkTitle(normalizedUrl);
  if (!cleanTitle) throw new Error('请输入名称');

  const quickLinks = await getQuickLinks();
  const target = quickLinks.find(link => link.id === id);
  if (!target) throw new Error('快捷入口不存在');

  const alreadyExists = quickLinks.some(link => link.id !== id && link.url === normalizedUrl);
  if (alreadyExists) throw new Error('这个网址已经在常用导航里了');

  target.title = cleanTitle;
  target.url = normalizedUrl;
  target.updatedAt = new Date().toISOString();

  await chrome.storage.local.set({ quickLinks });
}

async function removeQuickLink(id) {
  const quickLinks = await getQuickLinks();
  await chrome.storage.local.set({
    quickLinks: quickLinks.filter(link => link.id !== id),
  });
}

async function saveQuickLinkOrderFromDom() {
  const cards = [...document.querySelectorAll('.quick-link-card')];
  const orderedIds = cards.map(card => card.dataset.quickLinkId).filter(Boolean);
  const quickLinks = await getQuickLinks();
  const linksById = new Map(quickLinks.map(link => [link.id, link]));
  const orderedLinks = orderedIds.map(id => linksById.get(id)).filter(Boolean);
  const missingLinks = quickLinks.filter(link => !orderedIds.includes(link.id));

  await chrome.storage.local.set({
    quickLinks: [...orderedLinks, ...missingLinks],
  });
}

async function getQuickLink(id) {
  const quickLinks = await getQuickLinks();
  return quickLinks.find(link => link.id === id) || null;
}

async function openQuickLink(url) {
  if (!url) return;
  if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) {
    await chrome.tabs.create({ url });
    return;
  }
  window.open(url, '_blank', 'noopener');
}


/* ----------------------------------------------------------------
   UI HELPERS
   ---------------------------------------------------------------- */

/**
 * playCloseSound()
 *
 * Plays a clean "swoosh" sound when tabs are closed.
 * Built entirely with the Web Audio API — no sound files needed.
 * A filtered noise sweep that descends in pitch, like air moving.
 */
function playCloseSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t = ctx.currentTime;

    // Swoosh: shaped white noise through a sweeping bandpass filter
    const duration = 0.25;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    // Generate noise with a natural envelope (quick attack, smooth decay)
    for (let i = 0; i < data.length; i++) {
      const pos = i / data.length;
      // Envelope: ramps up fast in first 10%, then fades out smoothly
      const env = pos < 0.1 ? pos / 0.1 : Math.pow(1 - (pos - 0.1) / 0.9, 1.5);
      data[i] = (Math.random() * 2 - 1) * env;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Bandpass filter sweeps from high to low — creates the "swoosh" character
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 2.0;
    filter.frequency.setValueAtTime(4000, t);
    filter.frequency.exponentialRampToValueAtTime(400, t + duration);

    // Volume
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(t);

    setTimeout(() => ctx.close(), 500);
  } catch {
    // Audio not supported — fail silently
  }
}

/**
 * shootConfetti(x, y)
 *
 * Shoots a burst of colorful confetti particles from the given screen
 * coordinates (typically the center of a card being closed).
 * Pure CSS + JS, no libraries.
 */
function shootConfetti(x, y) {
  const colors = [
    '#c8713a', // amber
    '#e8a070', // amber light
    '#5a7a62', // sage
    '#8aaa92', // sage light
    '#5a6b7a', // slate
    '#8a9baa', // slate light
    '#d4b896', // warm paper
    '#b35a5a', // rose
  ];

  const particleCount = 17;

  for (let i = 0; i < particleCount; i++) {
    const el = document.createElement('div');

    const isCircle = Math.random() > 0.5;
    const size = 5 + Math.random() * 6; // 5–11px
    const color = colors[Math.floor(Math.random() * colors.length)];

    el.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      width: ${size}px;
      height: ${size}px;
      background: ${color};
      border-radius: ${isCircle ? '50%' : '2px'};
      pointer-events: none;
      z-index: 9999;
      transform: translate(-50%, -50%);
      opacity: 1;
    `;
    document.body.appendChild(el);

    // Physics: random angle and speed for the outward burst
    const angle   = Math.random() * Math.PI * 2;
    const speed   = 60 + Math.random() * 120;
    const vx      = Math.cos(angle) * speed;
    const vy      = Math.sin(angle) * speed - 80; // bias upward
    const gravity = 200;

    const startTime = performance.now();
    const duration  = 700 + Math.random() * 200; // 700–900ms

    function frame(now) {
      const elapsed  = (now - startTime) / 1000;
      const progress = elapsed / (duration / 1000);

      if (progress >= 1) { el.remove(); return; }

      const px = vx * elapsed;
      const py = vy * elapsed + 0.5 * gravity * elapsed * elapsed;
      const opacity = progress < 0.5 ? 1 : 1 - (progress - 0.5) * 2;
      const rotate  = elapsed * 200 * (isCircle ? 0 : 1);

      el.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px)) rotate(${rotate}deg)`;
      el.style.opacity = opacity;

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }
}

/**
 * animateCardOut(card)
 *
 * Smoothly removes a mission card: fade + scale down, then confetti.
 * After the animation, checks if the grid is now empty.
 */
function animateCardOut(card) {
  if (!card) return;

  const rect = card.getBoundingClientRect();
  shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);

  card.classList.add('closing');
  setTimeout(() => {
    card.remove();
    checkAndShowEmptyState();
  }, 300);
}

/**
 * showToast(message)
 *
 * Brief pop-up notification at the bottom of the screen.
 */
function showToast(message) {
  const toast = document.getElementById('toast');
  document.getElementById('toastText').textContent = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 2500);
}

/**
 * checkAndShowEmptyState()
 *
 * Shows a cheerful "Inbox zero" message when all domain cards are gone.
 */
function checkAndShowEmptyState() {
  const missionsEl = document.getElementById('openTabsMissions');
  if (!missionsEl) return;

  const remaining = missionsEl.querySelectorAll('.mission-card:not(.closing)').length;
  if (remaining > 0) return;

  missionsEl.innerHTML = `
    <div class="missions-empty-state">
      <div class="empty-checkmark">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </div>
      <div class="empty-title">标签页已清空</div>
      <div class="empty-subtitle">现在可以轻装上阵了。</div>
    </div>
  `;

  const countEl = document.getElementById('openTabsSectionCount');
  if (countEl) countEl.textContent = '0 个分组';
}

/**
 * timeAgo(dateStr)
 *
 * Converts an ISO date string into a human-friendly relative time.
 * "2026-04-04T10:00:00Z" → "2 hrs ago" or "yesterday"
 */
function timeAgo(dateStr) {
  if (!dateStr) return '';
  const then = new Date(dateStr);
  const now  = new Date();
  const diffMins  = Math.floor((now - then) / 60000);
  const diffHours = Math.floor((now - then) / 3600000);
  const diffDays  = Math.floor((now - then) / 86400000);

  if (diffMins < 1)   return '刚刚';
  if (diffMins < 60)  return diffMins + ' 分钟前';
  if (diffHours < 24) return diffHours + ' 小时前';
  if (diffDays === 1) return '昨天';
  return diffDays + ' 天前';
}

function getTabAccessState(lastAccessed) {
  if (!Number.isFinite(lastAccessed)) return null;

  const diffMs = Math.max(0, Date.now() - lastAccessed);
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  let timeText = '刚刚看过';
  if (diffMins >= 1 && diffMins < 60) {
    timeText = `${diffMins} 分钟前看过`;
  } else if (diffHours >= 1 && diffHours < 24) {
    timeText = `${diffHours} 小时前看过`;
  } else if (diffDays >= 1) {
    timeText = `${diffDays} 天前看过`;
  }

  if (diffMins < 15) {
    return { timeText, label: '刚看过', level: 'fresh', prominent: false };
  }

  if (diffMins < 120) {
    return { timeText, label: '最近看过', level: 'recent', prominent: false };
  }

  if (diffHours < 24) {
    return { timeText, label: '较久未看', level: 'stale', prominent: true };
  }

  if (diffDays < 7) {
    return { timeText, label: '长期未看', level: 'old', prominent: true };
  }

  return { timeText, label: '可能遗忘', level: 'forgotten', prominent: true };
}

function renderTabAccessMeta(lastAccessed) {
  const state = getTabAccessState(lastAccessed);
  if (!state) return '';

  const badge = state.prominent
    ? `<span class="chip-access-badge chip-access-${state.level}">${state.label}</span>`
    : '';

  return `
    <span class="chip-access-meta">
      <span class="chip-access-time">${state.timeText}</span>
      ${badge}
    </span>`;
}

/**
 * getGreeting() — "早上好 / 下午好 / 晚上好"
 */
function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 6) return '夜深了';
  if (hour < 12) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

/**
 * getDateDisplay() — "2026年4月4日 星期五"
 */
function getDateDisplay() {
  return new Date().toLocaleDateString('zh-CN', {
    weekday: 'long',
    year:    'numeric',
    month:   'long',
    day:     'numeric',
  });
}


/* ----------------------------------------------------------------
   DOMAIN & TITLE CLEANUP HELPERS
   ---------------------------------------------------------------- */

// Map of known hostnames → friendly display names.
const FRIENDLY_DOMAINS = {
  'github.com':           'GitHub',
  'www.github.com':       'GitHub',
  'gist.github.com':      'GitHub Gist',
  'youtube.com':          'YouTube',
  'www.youtube.com':      'YouTube',
  'music.youtube.com':    'YouTube Music',
  'x.com':                'X',
  'www.x.com':            'X',
  'twitter.com':          'X',
  'www.twitter.com':      'X',
  'reddit.com':           'Reddit',
  'www.reddit.com':       'Reddit',
  'old.reddit.com':       'Reddit',
  'substack.com':         'Substack',
  'www.substack.com':     'Substack',
  'medium.com':           'Medium',
  'www.medium.com':       'Medium',
  'linkedin.com':         'LinkedIn',
  'www.linkedin.com':     'LinkedIn',
  'stackoverflow.com':    'Stack Overflow',
  'www.stackoverflow.com':'Stack Overflow',
  'news.ycombinator.com': 'Hacker News',
  'google.com':           'Google',
  'www.google.com':       'Google',
  'mail.google.com':      'Gmail',
  'docs.google.com':      'Google Docs',
  'drive.google.com':     'Google Drive',
  'calendar.google.com':  'Google Calendar',
  'meet.google.com':      'Google Meet',
  'gemini.google.com':    'Gemini',
  'chatgpt.com':          'ChatGPT',
  'www.chatgpt.com':      'ChatGPT',
  'chat.openai.com':      'ChatGPT',
  'claude.ai':            'Claude',
  'www.claude.ai':        'Claude',
  'code.claude.com':      'Claude Code',
  'notion.so':            'Notion',
  'www.notion.so':        'Notion',
  'figma.com':            'Figma',
  'www.figma.com':        'Figma',
  'slack.com':            'Slack',
  'app.slack.com':        'Slack',
  'discord.com':          'Discord',
  'www.discord.com':      'Discord',
  'wikipedia.org':        'Wikipedia',
  'en.wikipedia.org':     'Wikipedia',
  'amazon.com':           'Amazon',
  'www.amazon.com':       'Amazon',
  'netflix.com':          'Netflix',
  'www.netflix.com':      'Netflix',
  'spotify.com':          'Spotify',
  'open.spotify.com':     'Spotify',
  'vercel.com':           'Vercel',
  'www.vercel.com':       'Vercel',
  'npmjs.com':            'npm',
  'www.npmjs.com':        'npm',
  'developer.mozilla.org':'MDN',
  'arxiv.org':            'arXiv',
  'www.arxiv.org':        'arXiv',
  'huggingface.co':       'Hugging Face',
  'www.huggingface.co':   'Hugging Face',
  'producthunt.com':      'Product Hunt',
  'www.producthunt.com':  'Product Hunt',
  'xiaohongshu.com':      'RedNote',
  'www.xiaohongshu.com':  'RedNote',
  'local-files':          'Local Files',
};

function friendlyDomain(hostname) {
  if (!hostname) return '';
  if (FRIENDLY_DOMAINS[hostname]) return FRIENDLY_DOMAINS[hostname];

  if (hostname.endsWith('.substack.com') && hostname !== 'substack.com') {
    return capitalize(hostname.replace('.substack.com', '')) + "'s Substack";
  }
  if (hostname.endsWith('.github.io')) {
    return capitalize(hostname.replace('.github.io', '')) + ' (GitHub Pages)';
  }

  let clean = hostname
    .replace(/^www\./, '')
    .replace(/\.(com|org|net|io|co|ai|dev|app|so|me|xyz|info|us|uk|co\.uk|co\.jp)$/, '');

  return clean.split('.').map(part => capitalize(part)).join(' ');
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function stripTitleNoise(title) {
  if (!title) return '';
  // Strip leading notification count: "(2) Title"
  title = title.replace(/^\(\d+\+?\)\s*/, '');
  // Strip inline counts like "Inbox (16,359)"
  title = title.replace(/\s*\([\d,]+\+?\)\s*/g, ' ');
  // Strip email addresses (privacy + cleaner display)
  title = title.replace(/\s*[\-\u2010-\u2015]\s*[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  title = title.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  // Clean X/Twitter format
  title = title.replace(/\s+on X:\s*/, ': ');
  title = title.replace(/\s*\/\s*X\s*$/, '');
  return title.trim();
}

function cleanTitle(title, hostname) {
  if (!title || !hostname) return title || '';

  const friendly = friendlyDomain(hostname);
  const domain   = hostname.replace(/^www\./, '');
  const seps     = [' - ', ' | ', ' — ', ' · ', ' – '];

  for (const sep of seps) {
    const idx = title.lastIndexOf(sep);
    if (idx === -1) continue;
    const suffix     = title.slice(idx + sep.length).trim();
    const suffixLow  = suffix.toLowerCase();
    if (
      suffixLow === domain.toLowerCase() ||
      suffixLow === friendly.toLowerCase() ||
      suffixLow === domain.replace(/\.\w+$/, '').toLowerCase() ||
      domain.toLowerCase().includes(suffixLow) ||
      friendly.toLowerCase().includes(suffixLow)
    ) {
      const cleaned = title.slice(0, idx).trim();
      if (cleaned.length >= 5) return cleaned;
    }
  }
  return title;
}

function smartTitle(title, url) {
  if (!url) return title || '';
  let pathname = '', hostname = '';
  try { const u = new URL(url); pathname = u.pathname; hostname = u.hostname; }
  catch { return title || ''; }

  const titleIsUrl = !title || title === url || title.startsWith(hostname) || title.startsWith('http');

  if ((hostname === 'x.com' || hostname === 'twitter.com' || hostname === 'www.x.com') && pathname.includes('/status/')) {
    const username = pathname.split('/')[1];
    if (username) return titleIsUrl ? `Post by @${username}` : title;
  }

  if (hostname === 'github.com' || hostname === 'www.github.com') {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const [owner, repo, ...rest] = parts;
      if (rest[0] === 'issues' && rest[1]) return `${owner}/${repo} Issue #${rest[1]}`;
      if (rest[0] === 'pull'   && rest[1]) return `${owner}/${repo} PR #${rest[1]}`;
      if (rest[0] === 'blob' || rest[0] === 'tree') return `${owner}/${repo} — ${rest.slice(2).join('/')}`;
      if (titleIsUrl) return `${owner}/${repo}`;
    }
  }

  if ((hostname === 'www.youtube.com' || hostname === 'youtube.com') && pathname === '/watch') {
    if (titleIsUrl) return 'YouTube Video';
  }

  if ((hostname === 'www.reddit.com' || hostname === 'reddit.com' || hostname === 'old.reddit.com') && pathname.includes('/comments/')) {
    const parts  = pathname.split('/').filter(Boolean);
    const subIdx = parts.indexOf('r');
    if (subIdx !== -1 && parts[subIdx + 1]) {
      if (titleIsUrl) return `r/${parts[subIdx + 1]} post`;
    }
  }

  return title || url;
}


/* ----------------------------------------------------------------
   SVG ICON STRINGS
   ---------------------------------------------------------------- */
const ICONS = {
  tabs:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8.25V18a2.25 2.25 0 0 0 2.25 2.25h13.5A2.25 2.25 0 0 0 21 18V8.25m-18 0V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v2.25m-18 0h18" /></svg>`,
  close:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>`,
  archive: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg>`,
  focus:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>`,
  edit:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125" /></svg>`,
};


/* ----------------------------------------------------------------
   IN-MEMORY STORE FOR OPEN-TAB GROUPS
   ---------------------------------------------------------------- */
let domainGroups = [];


/* ----------------------------------------------------------------
   HELPER: filter out browser-internal pages
   ---------------------------------------------------------------- */

/**
 * getRealTabs()
 *
 * Returns tabs that are real web pages — no chrome://, extension
 * pages, about:blank, etc.
 */
function getRealTabs() {
  return openTabs.filter(t => {
    const url = t.url || '';
    return (
      !url.startsWith('chrome://') &&
      !url.startsWith('chrome-extension://') &&
      !url.startsWith('about:') &&
      !url.startsWith('edge://') &&
      !url.startsWith('brave://')
    );
  });
}

/**
 * checkTabOutDupes()
 *
 * Counts how many Tab Out pages are open. If more than 1,
 * shows a banner offering to close the extras.
 */
function checkTabOutDupes() {
  const tabOutTabs = openTabs.filter(t => t.isTabOut);
  const banner  = document.getElementById('tabOutDupeBanner');
  const countEl = document.getElementById('tabOutDupeCount');
  if (!banner) return;

  if (tabOutTabs.length > 1) {
    if (countEl) countEl.textContent = tabOutTabs.length;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}


/* ----------------------------------------------------------------
   DOMAIN CARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderDomainCard(group, groupIndex)
 *
 * Builds the HTML for one domain group card.
 * group = { domain: string, tabs: [{ url, title, id, windowId, active }] }
 */
function renderDomainCard(group) {
  const tabs      = group.tabs || [];
  const tabCount  = tabs.length;
  const isLanding = group.domain === '__landing-pages__';
  const stableId  = 'domain-' + group.domain.replace(/[^a-z0-9]/g, '-');

  // Count duplicates (exact URL match)
  const urlCounts = {};
  for (const tab of tabs) urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;
  const dupeUrls   = Object.entries(urlCounts).filter(([, c]) => c > 1);
  const hasDupes   = dupeUrls.length > 0;
  const totalExtras = dupeUrls.reduce((s, [, c]) => s + c - 1, 0);

  const tabBadge = `<span class="open-tabs-badge">
    ${ICONS.tabs}
    ${tabCount} 个标签页
  </span>`;

  const dupeBadge = hasDupes
    ? `<span class="open-tabs-badge" style="color:var(--accent-amber);background:rgba(200,113,58,0.08);">
        ${totalExtras} 个重复
      </span>`
    : '';

  // Deduplicate for display: show each URL once, with (Nx) badge if duped
  const seen = new Set();
  const uniqueTabs = [];
  for (const tab of tabs) {
    if (!seen.has(tab.url)) { seen.add(tab.url); uniqueTabs.push(tab); }
  }

  const shouldScrollTabs = uniqueTabs.length > 8;

  const pageChips = uniqueTabs.map(tab => {
    let label = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), group.domain);
    // For localhost tabs, prepend port number so you can tell projects apart
    try {
      const parsed = new URL(tab.url);
      if (parsed.hostname === 'localhost' && parsed.port) label = `${parsed.port} ${label}`;
    } catch {}
    const count    = urlCounts[tab.url];
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl   = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    const accessMeta = renderTabAccessMeta(tab.lastAccessed);
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${renderFavicon(tab.url, 'chip-favicon', 16)}
      <span class="chip-content">
        <span class="chip-text">${label}</span>
        ${accessMeta}
      </span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="稍后处理">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="关闭这个标签页">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('');

  const pagesClass = shouldScrollTabs ? 'mission-pages is-scrollable' : 'mission-pages';
  const pagesHint = shouldScrollTabs
    ? `<div class="mission-pages-hint">共 ${uniqueTabs.length} 个页面，可在卡片内上下滑动</div>`
    : '';

  let actionsHtml = '';

  if (hasDupes) {
    const dupeUrlsEncoded = dupeUrls.map(([url]) => encodeURIComponent(url)).join(',');
    actionsHtml += `
      <button class="action-btn" data-action="dedup-keep-one" data-dupe-urls="${dupeUrlsEncoded}">
        关闭 ${totalExtras} 个重复标签页
      </button>`;
  }

  const dangerHtml = `
    <div class="domain-danger-zone">
      <span class="domain-danger-hint">危险操作</span>
      <button class="action-btn close-tabs domain-close-all" data-action="close-domain-tabs" data-domain-id="${stableId}">
        ${ICONS.close}
        关闭该分组全部 ${tabCount} 个标签页
      </button>
    </div>`;

  return `
    <div class="mission-card domain-card ${hasDupes ? 'has-amber-bar' : 'has-neutral-bar'}" data-domain-id="${stableId}">
      <div class="status-bar"></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${isLanding ? '常用首页' : (group.label || friendlyDomain(group.domain))}</span>
          ${tabBadge}
          ${dupeBadge}
        </div>
        ${pagesHint}
        <div class="${pagesClass}">${pageChips}</div>
        ${actionsHtml ? `<div class="actions">${actionsHtml}</div>` : ''}
        ${dangerHtml}
      </div>
      <div class="mission-meta">
        <div class="mission-page-count">${tabCount}</div>
        <div class="mission-page-label">标签页</div>
      </div>
    </div>`;
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — Render Checklist Section
   ---------------------------------------------------------------- */

function getDeferredGroupId(item) {
  try {
    return new URL(item.url).hostname.replace(/^www\./, '') || '其他';
  } catch {
    return '其他';
  }
}

function normalizeDeferredRemark(value) {
  const trimmed = String(value || '').trim().replace(/\s+/g, ' ');
  return trimmed || DEFAULT_DEFERRED_REMARK;
}

function getDeferredRemark(item) {
  return normalizeDeferredRemark(item && item.remark);
}

function buildDeferredRemarkCounts(items) {
  const counts = new Map();

  for (const item of items) {
    const remark = getDeferredRemark(item);
    counts.set(remark, (counts.get(remark) || 0) + 1);
  }

  return [...counts.entries()].sort((a, b) => {
    if (a[0] === DEFAULT_DEFERRED_REMARK) return -1;
    if (b[0] === DEFAULT_DEFERRED_REMARK) return 1;
    if (a[1] !== b[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });
}

async function getDeferredRemarkOptionsForUrl(url) {
  const groupId = getDeferredGroupId({ url });
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const sameDomainActive = deferred.filter(item =>
    !item.dismissed &&
    !item.completed &&
    getDeferredGroupId(item) === groupId
  );

  return buildDeferredRemarkCounts(sameDomainActive)
    .map(([remark, count]) => ({ remark, count }));
}

function closeDeferredRemarkDialog(result) {
  if (!deferredRemarkDialogState) return;

  const { resolve, previousFocus } = deferredRemarkDialogState;
  const backdrop = document.getElementById('deferredRemarkDialogBackdrop');
  if (backdrop) backdrop.style.display = 'none';
  deferredRemarkDialogState = null;
  resolve(result);

  if (previousFocus && typeof previousFocus.focus === 'function') {
    try { previousFocus.focus(); } catch {}
  }
}

function ensureDeferredRemarkDialog() {
  let backdrop = document.getElementById('deferredRemarkDialogBackdrop');
  if (backdrop) return backdrop;

  backdrop = document.createElement('div');
  backdrop.id = 'deferredRemarkDialogBackdrop';
  backdrop.className = 'deferred-remark-dialog-backdrop';
  backdrop.style.display = 'none';
  backdrop.innerHTML = `
    <div class="deferred-remark-dialog" role="dialog" aria-modal="true" aria-labelledby="deferredRemarkDialogTitle">
      <div class="deferred-remark-dialog-header">
        <div>
          <h3 id="deferredRemarkDialogTitle">选择备注标签</h3>
          <div class="deferred-remark-dialog-domain" id="deferredRemarkDialogDomain"></div>
        </div>
        <button class="deferred-remark-dialog-close" type="button" aria-label="关闭">×</button>
      </div>
      <div class="deferred-remark-dialog-empty" id="deferredRemarkDialogEmpty" style="display:none">
        当前域名下还没有备注标签。
      </div>
      <div class="deferred-remark-choice-list" id="deferredRemarkChoiceList"></div>
      <form class="deferred-remark-create" id="deferredRemarkCreateForm">
        <input type="text" id="deferredRemarkCreateInput" placeholder="输入新备注，留空使用默认" autocomplete="off">
        <button type="submit" class="action-btn primary">保存</button>
      </form>
    </div>`;

  document.body.appendChild(backdrop);

  const closeBtn = backdrop.querySelector('.deferred-remark-dialog-close');
  const form = backdrop.querySelector('#deferredRemarkCreateForm');
  const input = backdrop.querySelector('#deferredRemarkCreateInput');

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop || e.target === closeBtn) {
      closeDeferredRemarkDialog(null);
      return;
    }

    const choice = e.target.closest('.deferred-remark-choice');
    if (!choice) return;

    closeDeferredRemarkDialog(normalizeDeferredRemark(choice.dataset.remark));
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    closeDeferredRemarkDialog(normalizeDeferredRemark(input.value));
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !deferredRemarkDialogState) return;
    closeDeferredRemarkDialog(null);
  });

  return backdrop;
}

function renderDeferredRemarkChoices(backdrop, options, currentRemark = '') {
  const list = backdrop.querySelector('#deferredRemarkChoiceList');
  const empty = backdrop.querySelector('#deferredRemarkDialogEmpty');
  if (!list || !empty) return;

  const normalizedCurrent = currentRemark ? normalizeDeferredRemark(currentRemark) : '';
  const hasDefault = options.some(option => option.remark === DEFAULT_DEFERRED_REMARK);
  const choices = hasDefault
    ? options
    : [{ remark: DEFAULT_DEFERRED_REMARK, count: 0 }, ...options];

  empty.style.display = options.length > 0 ? 'none' : 'block';
  list.innerHTML = '';

  for (const option of choices) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `deferred-remark-choice${normalizedCurrent === option.remark ? ' active' : ''}`;
    button.dataset.remark = option.remark;
    button.setAttribute('aria-pressed', normalizedCurrent === option.remark ? 'true' : 'false');

    const label = document.createElement('span');
    label.className = 'deferred-remark-choice-label';
    label.textContent = option.remark;
    button.appendChild(label);

    if (option.count > 0) {
      const count = document.createElement('span');
      count.className = 'deferred-remark-choice-count';
      count.textContent = `${option.count}项`;
      button.appendChild(count);
    }

    list.appendChild(button);
  }
}

async function promptDeferredRemarkForUrl(url, currentRemark = '') {
  const options = await getDeferredRemarkOptionsForUrl(url);
  const backdrop = ensureDeferredRemarkDialog();
  const domainEl = backdrop.querySelector('#deferredRemarkDialogDomain');
  const input = backdrop.querySelector('#deferredRemarkCreateInput');
  const previousFocus = document.activeElement;

  if (domainEl) domainEl.textContent = getDeferredGroupId({ url });
  if (input) input.value = '';
  renderDeferredRemarkChoices(backdrop, options, currentRemark);
  backdrop.style.display = 'flex';

  const activeChoice = backdrop.querySelector('.deferred-remark-choice.active');
  const firstChoice = backdrop.querySelector('.deferred-remark-choice');
  if (activeChoice) activeChoice.focus();
  else if (firstChoice) firstChoice.focus();

  return new Promise(resolve => {
    deferredRemarkDialogState = { resolve, previousFocus };
  });
}

function getDeferredRemarkFilter(groupId, items) {
  const selected = deferredRemarkFilters.get(groupId);
  if (!selected) return '';

  const hasRemark = items.some(item => getDeferredRemark(item) === selected);
  if (!hasRemark) {
    deferredRemarkFilters.delete(groupId);
    return '';
  }

  return selected;
}

function buildDeferredGroups(activeItems) {
  const groupsById = new Map();

  for (const item of activeItems) {
    const groupId = getDeferredGroupId(item);
    if (!groupsById.has(groupId)) {
      groupsById.set(groupId, {
        id: groupId,
        label: groupId,
        items: [],
        createdAt: item.savedAt || new Date().toISOString(),
      });
    }

    const group = groupsById.get(groupId);
    group.items.push(item);
    if (item.savedAt && item.savedAt < group.createdAt) group.createdAt = item.savedAt;
  }

  return [...groupsById.values()].sort((a, b) => {
    const byCreated = String(a.createdAt).localeCompare(String(b.createdAt));
    if (byCreated !== 0) return byCreated;
    return a.label.localeCompare(b.label);
  });
}

function applyDeferredItemOrder(items) {
  return [...items].sort((a, b) => {
    const aCustom = Number.isFinite(a.sortIndex);
    const bCustom = Number.isFinite(b.sortIndex);
    if (aCustom && bCustom) return a.sortIndex - b.sortIndex;
    if (aCustom !== bCustom) return aCustom ? -1 : 1;
    return String(a.savedAt || '').localeCompare(String(b.savedAt || ''));
  });
}

function hasCustomDeferredItemOrder(items) {
  return items.some(item => Number.isFinite(item.sortIndex));
}

async function saveDeferredItemOrderFromDom() {
  const rows = [...document.querySelectorAll('.deferred-item')];
  const orderedIds = rows.map(row => row.dataset.deferredId).filter(Boolean);
  const orderById = new Map(orderedIds.map((id, index) => [id, index]));
  const { deferred = [] } = await chrome.storage.local.get('deferred');

  for (const item of deferred) {
    if (orderById.has(item.id)) item.sortIndex = orderById.get(item.id);
  }

  await chrome.storage.local.set({ deferred });
}

async function resetDeferredItemSort(groupId) {
  if (!groupId || groupId === DEFERRED_ALL_GROUP_ID) return;

  isDeferredItemSorting = false;
  const { deferred = [] } = await chrome.storage.local.get('deferred');

  for (const item of deferred) {
    if (getDeferredGroupId(item) === groupId) delete item.sortIndex;
  }

  await chrome.storage.local.set({ deferred });
  await renderDeferredColumn();
}

function renderDeferredSortControls(visibleActive) {
  const controls = document.getElementById('deferredGroupControls');
  const toggle   = document.getElementById('deferredSortToggle');
  const reset    = document.getElementById('deferredSortReset');
  if (!controls) return;

  const canSortItems = selectedDeferredGroupId !== DEFERRED_ALL_GROUP_ID && visibleActive.length > 1;
  controls.style.display = canSortItems ? 'flex' : 'none';
  if (!canSortItems) {
    isDeferredItemSorting = false;
    return;
  }

  if (toggle) toggle.textContent = isDeferredItemSorting ? '完成排序' : '调整优先级';
  if (reset) reset.style.display = hasCustomDeferredItemOrder(visibleActive) ? 'inline-flex' : 'none';
}

function hideDeferredGroupTabs() {
  const tabsEl   = document.getElementById('deferredGroupTabs');
  if (!tabsEl) return;

  tabsEl.style.display = 'none';
  tabsEl.innerHTML = '';
}

function renderDeferredRemarkFilters(group, selectedRemark, totalCount) {
  const safeGroupId = escapeHtml(group.id);
  const allActive = selectedRemark ? '' : ' active';
  const remarkButtons = buildDeferredRemarkCounts(group.items).map(([remark, count]) => {
    const safeRemark = escapeHtml(remark);
    const active = selectedRemark === remark ? ' active' : '';

    return `
      <span class="deferred-remark-filter-wrap">
        <button class="deferred-remark-filter${active}" data-action="filter-deferred-remark" data-deferred-group-id="${safeGroupId}" data-deferred-remark="${safeRemark}" type="button" title="${safeRemark}">
          <span class="deferred-remark-label">${safeRemark}</span>
          <span class="deferred-remark-count">${count}</span>
        </button>
        <button class="deferred-remark-edit" data-action="rename-deferred-remark" data-deferred-group-id="${safeGroupId}" data-deferred-remark="${safeRemark}" type="button" title="重命名：${safeRemark}" aria-label="重命名 ${safeRemark}">✎</button>
      </span>`;
  }).join('');

  return `
    <div class="deferred-remark-filters">
      <button class="deferred-remark-filter is-all${allActive}" data-action="filter-deferred-remark" data-deferred-group-id="${safeGroupId}" data-deferred-remark="" type="button">
        <span class="deferred-remark-label">全部</span>
        <span class="deferred-remark-count">${totalCount}</span>
      </button>
      ${remarkButtons}
    </div>`;
}

function renderDeferredGroupCard(group) {
  const safeLabel = escapeHtml(group.label);
  const orderedItems = applyDeferredItemOrder(group.items);
  const selectedRemark = getDeferredRemarkFilter(group.id, orderedItems);
  const visibleItems = selectedRemark
    ? orderedItems.filter(item => getDeferredRemark(item) === selectedRemark)
    : orderedItems;
  const countText = selectedRemark
    ? `${visibleItems.length}/${orderedItems.length} 项`
    : `${orderedItems.length} 项`;

  return `
    <article class="deferred-group-card">
      <div class="deferred-group-card-header">
        <h3 class="deferred-group-card-title" title="${safeLabel}">${safeLabel}</h3>
        <span class="deferred-group-card-count">${countText}</span>
      </div>
      ${renderDeferredRemarkFilters(group, selectedRemark, orderedItems.length)}
      <div class="deferred-group-card-items">
        ${visibleItems.map(item => renderDeferredItem(item, {
          showDomain: false,
          groupId: group.id,
          selectedRemark,
        })).join('')}
      </div>
    </article>`;
}

/**
 * renderDeferredColumn()
 *
 * Reads saved tabs from chrome.storage.local and renders the top
 * "Saved for Later" checklist section. Shows active items as a checklist
 * and completed items in a collapsible archive.
 */
async function renderDeferredColumn() {
  const column         = document.getElementById('deferredColumn');
  const list           = document.getElementById('deferredList');
  const empty          = document.getElementById('deferredEmpty');
  const countEl        = document.getElementById('deferredCount');
  const archiveEl      = document.getElementById('deferredArchive');
  const archiveCountEl = document.getElementById('archiveCount');
  const archiveList    = document.getElementById('archiveList');
  const hiddenNotice   = document.querySelector('[data-module-hidden-notice="deferred"]');

  if (!column) return;

  try {
    const { active, archived } = await getSavedTabs();

    // Hide the entire section if there's nothing to show.
    if (active.length === 0 && archived.length === 0) {
      column.style.display = 'none';
      if (hiddenNotice) hiddenNotice.style.display = 'none';
      return;
    }

    const isVisible = applyModuleState('deferred');
    if (!isVisible) return;

    const groups = buildDeferredGroups(active);
    selectedDeferredGroupId = DEFERRED_ALL_GROUP_ID;
    isDeferredItemSorting = false;
    hideDeferredGroupTabs();
    renderDeferredSortControls([]);

    // Render active items as domain groups; CSS lays each group's items out in columns.
    if (active.length > 0) {
      countEl.textContent = `${groups.length} 个域名分组 · ${active.length} 项`;
      list.className = 'deferred-list is-grouped';
      list.innerHTML = groups.map(renderDeferredGroupCard).join('');
      list.style.display = 'block';
      empty.style.display = 'none';
    } else {
      list.className = 'deferred-list';
      list.style.display = 'none';
      countEl.textContent = '';
      empty.style.display = 'block';
      hideDeferredGroupTabs();
    }

    // Render archive section
    if (archived.length > 0) {
      archiveCountEl.textContent = `(${archived.length})`;
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      archiveEl.style.display = 'block';
    } else {
      archiveEl.style.display = 'none';
    }

  } catch (err) {
    console.warn('[tab-out] Could not load saved tabs:', err);
    column.style.display = 'none';
    if (hiddenNotice) hiddenNotice.style.display = 'none';
  }
}

/**
 * renderDeferredItem(item)
 *
 * Builds HTML for one active checklist item: checkbox, title link,
 * domain, time ago, dismiss button.
 */
function renderDeferredItem(item, options = {}) {
  const { showDomain = true, groupId = getDeferredGroupId(item), selectedRemark = '' } = options;
  let domain = '';
  try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
  const ago = timeAgo(item.savedAt);
  const remark = getDeferredRemark(item);
  const safeGroupId = escapeHtml(groupId);
  const safeRemark = escapeHtml(remark);
  const safeId = escapeHtml(item.id);
  const remarkActive = selectedRemark === remark ? ' active' : '';
  const metaParts = [
    showDomain && domain ? `<span>${domain}</span>` : '',
    `<span>${ago}</span>`,
    `<button class="deferred-item-remark${remarkActive}" data-action="edit-deferred-remark" data-deferred-id="${safeId}" data-deferred-group-id="${safeGroupId}" data-deferred-remark="${safeRemark}" type="button" title="修改备注：${safeRemark}">${safeRemark}</button>`,
  ].filter(Boolean).join('');
  const sortClass = isDeferredItemSorting ? ' sorting' : '';
  const handle = isDeferredItemSorting
    ? '<button class="deferred-item-drag" type="button" title="拖拽调整优先级" aria-label="拖拽调整优先级">☰</button>'
    : '';

  return `
    <div class="deferred-item${sortClass}" data-deferred-id="${item.id}">
      ${handle}
      <input type="checkbox" class="deferred-checkbox" data-action="check-deferred" data-deferred-id="${item.id}" ${isDeferredItemSorting ? 'disabled' : ''}>
      <div class="deferred-info">
        <a href="${item.url}" target="_blank" rel="noopener" class="deferred-title" title="${(item.title || '').replace(/"/g, '&quot;')}">
          ${renderFavicon(item.url, 'deferred-favicon', 16)}${item.title || item.url}
        </a>
        <div class="deferred-meta">
          ${metaParts}
        </div>
      </div>
      <button class="deferred-dismiss" data-action="dismiss-deferred" data-deferred-id="${item.id}" title="移除">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>`;
}

/**
 * renderArchiveItem(item)
 *
 * Builds HTML for one completed/archived item (simpler: just title + date).
 */
function renderArchiveItem(item) {
  const ago = item.completedAt ? timeAgo(item.completedAt) : timeAgo(item.savedAt);
  return `
    <div class="archive-item">
      <a href="${item.url}" target="_blank" rel="noopener" class="archive-item-title" title="${(item.title || '').replace(/"/g, '&quot;')}">
        ${item.title || item.url}
      </a>
      <span class="archive-item-date">${ago}</span>
    </div>`;
}


/* ----------------------------------------------------------------
   BROWSER BOOKMARKS — Render Chrome Bookmarks Bar
   ---------------------------------------------------------------- */

function hasBookmarksApi() {
  return (
    typeof chrome !== 'undefined' &&
    chrome.bookmarks &&
    typeof chrome.bookmarks.getTree === 'function' &&
    typeof chrome.bookmarks.getChildren === 'function'
  );
}

async function getBookmarkBarNode() {
  if (!hasBookmarksApi()) return null;

  const tree = await chrome.bookmarks.getTree();
  const root = Array.isArray(tree) ? tree[0] : null;
  const children = root && Array.isArray(root.children) ? root.children : [];

  return (
    children.find(node => node.id === '1') ||
    children.find(node => /bookmarks bar|书签栏|收藏夹栏/i.test(node.title || '')) ||
    children[0] ||
    null
  );
}

async function getBookmarkFolderChildren(folderId) {
  if (!hasBookmarksApi() || !folderId) return [];
  const children = await chrome.bookmarks.getChildren(folderId);
  return Array.isArray(children) ? children : [];
}

async function ensureBookmarkFolderSelection() {
  if (selectedBookmarkFolderId) return;

  const bookmarkBar = await getBookmarkBarNode();
  if (!bookmarkBar) return;

  selectedBookmarkFolderId = bookmarkBar.id;
  selectedBookmarkFolderTitle = bookmarkBar.title || '书签栏';
}

function renderBookmarkCard(node) {
  const safeId = escapeHtml(node.id);
  const safeTitle = escapeHtml(node.title || (node.url ? node.url : '未命名文件夹'));

  if (!node.url) {
    const childCount = Array.isArray(node.children) ? node.children.length : '';
    return `
      <button class="browser-bookmark-card is-folder" data-action="open-bookmark-folder" data-bookmark-id="${safeId}" data-bookmark-title="${safeTitle}" type="button" title="${safeTitle}">
        <span class="browser-bookmark-folder-icon">文件夹</span>
        <span class="browser-bookmark-info">
          <span class="browser-bookmark-title">${safeTitle}</span>
          <span class="browser-bookmark-domain">${childCount ? `${childCount} 项` : '文件夹'}</span>
        </span>
      </button>`;
  }

  const safeUrl = escapeHtml(node.url);
  let domain = '';
  try { domain = new URL(node.url).hostname.replace(/^www\./, ''); } catch {}

  return `
    <button class="browser-bookmark-card" data-action="open-browser-bookmark" data-bookmark-url="${safeUrl}" type="button" title="${safeTitle}">
      ${renderFavicon(node.url, 'browser-bookmark-favicon', 32)}
      <span class="browser-bookmark-info">
        <span class="browser-bookmark-title">${safeTitle}</span>
        <span class="browser-bookmark-domain">${escapeHtml(domain)}</span>
      </span>
    </button>`;
}

async function renderBrowserBookmarks() {
  const section = document.getElementById('browserBookmarksSection');
  const grid = document.getElementById('browserBookmarksGrid');
  const countEl = document.getElementById('browserBookmarksCount');
  const toolbar = document.getElementById('browserBookmarksToolbar');
  const backBtn = document.getElementById('bookmarkFolderBack');
  const expandBtn = document.getElementById('bookmarkExpandToggle');
  if (!section || !grid) return;

  if (!hasBookmarksApi()) {
    section.style.display = 'none';
    return;
  }

  const isVisible = applyModuleState('browserBookmarks');
  if (!isVisible) return;

  try {
    await ensureBookmarkFolderSelection();
    if (!selectedBookmarkFolderId) {
      section.style.display = 'none';
      return;
    }

    const bookmarkBar = await getBookmarkBarNode();
    const isBookmarkBar = !bookmarkBar || selectedBookmarkFolderId === bookmarkBar.id;
    const children = await getBookmarkFolderChildren(selectedBookmarkFolderId);
    const visibleChildren = bookmarksExpanded
      ? children
      : children.slice(0, BOOKMARKS_PREVIEW_LIMIT);

    applyModuleState('browserBookmarks');
    if (countEl) {
      countEl.textContent = `${selectedBookmarkFolderTitle || '书签栏'} · ${children.length} 项`;
    }

    if (toolbar) toolbar.style.display = children.length > BOOKMARKS_PREVIEW_LIMIT || !isBookmarkBar ? 'flex' : 'none';
    if (backBtn) backBtn.style.display = isBookmarkBar ? 'none' : 'inline-flex';
    if (expandBtn) {
      expandBtn.style.display = children.length > BOOKMARKS_PREVIEW_LIMIT ? 'inline-flex' : 'none';
      expandBtn.textContent = bookmarksExpanded ? '收起' : `显示更多 ${children.length - BOOKMARKS_PREVIEW_LIMIT} 项`;
    }

    if (children.length === 0) {
      grid.innerHTML = `
        <div class="browser-bookmarks-empty">
          当前收藏夹没有内容。
        </div>`;
      return;
    }

    grid.innerHTML = visibleChildren.map(renderBookmarkCard).join('');
  } catch (err) {
    console.warn('[tab-out] Could not load browser bookmarks:', err);
    section.style.display = 'none';
  }
}

async function resetBookmarkFolderToBar() {
  const bookmarkBar = await getBookmarkBarNode();
  if (!bookmarkBar) return;

  selectedBookmarkFolderId = bookmarkBar.id;
  selectedBookmarkFolderTitle = bookmarkBar.title || '书签栏';
  bookmarksExpanded = false;
  await renderBrowserBookmarks();
}


/* ----------------------------------------------------------------
   QUICK LINKS — Render Navigation Shortcuts
   ---------------------------------------------------------------- */

async function renderQuickLinks() {
  const section = document.getElementById('quickLinksSection');
  const grid    = document.getElementById('quickLinksGrid');
  const countEl = document.getElementById('quickLinksCount');
  if (!section || !grid) return;

  const isVisible = applyModuleState('quickLinks');
  if (!isVisible) return;

  try {
    const quickLinks = await getQuickLinks();
    applyModuleState('quickLinks');

    if (countEl) countEl.textContent = quickLinks.length > 0 ? `${quickLinks.length} 个快捷入口` : '';

    if (quickLinks.length === 0) {
      grid.innerHTML = `
        <div class="quick-link-empty">
          添加常用工作台、文档、系统或项目地址，之后打开新标签页就能直接进入。
        </div>`;
      return;
    }

    grid.innerHTML = quickLinks.map(link => {
      const safeTitle = escapeHtml(link.title);
      const safeUrl   = escapeHtml(link.url);
      let domain = '';
      try { domain = new URL(link.url).hostname.replace(/^www\./, ''); } catch {}
      const safeDomain = escapeHtml(domain);
      const safeId = escapeHtml(link.id);

      return `
        <div class="quick-link-card" data-action="open-quick-link" data-quick-link-id="${safeId}" data-quick-link-url="${safeUrl}" title="${safeUrl}">
          <button class="quick-link-drag" data-action="drag-quick-link" type="button" title="拖拽调整顺序" aria-label="拖拽调整顺序">☰</button>
          ${renderFavicon(link.url, 'quick-link-favicon', 32)}
          <div class="quick-link-info">
            <div class="quick-link-title">${safeTitle}</div>
            <div class="quick-link-domain">${safeDomain}</div>
          </div>
          <button class="chip-action quick-link-edit" data-action="edit-quick-link" data-quick-link-id="${safeId}" title="编辑快捷入口">
            ${ICONS.edit}
          </button>
          <button class="chip-action chip-close quick-link-remove" data-action="remove-quick-link" data-quick-link-id="${safeId}" title="移除快捷入口">
            ${ICONS.close}
          </button>
        </div>`;
    }).join('');
  } catch (err) {
    console.warn('[tab-out] Could not load quick links:', err);
    section.style.display = 'none';
  }
}

function resetQuickLinkForm() {
  const editingInput = document.getElementById('quickLinkEditingId');
  const titleInput   = document.getElementById('quickLinkTitle');
  const urlInput     = document.getElementById('quickLinkUrl');
  const submitBtn    = document.getElementById('quickLinkSubmit');
  const cancelBtn    = document.getElementById('quickLinkCancel');

  quickLinkTitleManuallyEdited = false;
  if (editingInput) editingInput.value = '';
  if (titleInput) titleInput.value = '';
  if (urlInput) urlInput.value = '';
  if (submitBtn) submitBtn.textContent = '添加';
  if (cancelBtn) cancelBtn.style.display = 'none';
}

async function startEditingQuickLink(id) {
  const link = await getQuickLink(id);
  if (!link) {
    showToast('快捷入口不存在');
    return;
  }

  const editingInput = document.getElementById('quickLinkEditingId');
  const titleInput   = document.getElementById('quickLinkTitle');
  const urlInput     = document.getElementById('quickLinkUrl');
  const submitBtn    = document.getElementById('quickLinkSubmit');
  const cancelBtn    = document.getElementById('quickLinkCancel');

  if (editingInput) editingInput.value = link.id;
  if (titleInput) titleInput.value = link.title;
  if (urlInput) urlInput.value = link.url;
  if (submitBtn) submitBtn.textContent = '保存';
  if (cancelBtn) cancelBtn.style.display = 'inline-flex';
  quickLinkTitleManuallyEdited = true;
  if (titleInput) titleInput.focus();
}


/* ----------------------------------------------------------------
   MAIN DASHBOARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderStaticDashboard()
 *
 * The main render function:
 * 1. Paints greeting + date
 * 2. Fetches open tabs via chrome.tabs.query()
 * 3. Groups tabs by domain (with landing pages pulled out to their own group)
 * 4. Renders domain cards
 * 5. Updates footer stats
 * 6. Renders the "Saved for Later" checklist
 */
async function renderStaticDashboard() {
  // --- Header ---
  const greetingEl = document.getElementById('greeting');
  const dateEl     = document.getElementById('dateDisplay');
  if (greetingEl) greetingEl.textContent = getGreeting();
  if (dateEl)     dateEl.textContent     = getDateDisplay();

  // --- Render browser bookmarks bar ---
  await renderBrowserBookmarks();

  // --- Render custom quick navigation links ---
  await renderQuickLinks();

  // --- Render "Saved for Later" section ---
  await renderDeferredColumn();

  // --- Fetch tabs ---
  await fetchOpenTabs();
  const realTabs = getRealTabs();

  // --- Group tabs by domain ---
  // Landing pages (Gmail inbox, Twitter home, etc.) get their own special group
  // so they can be closed together without affecting content tabs on the same domain.
  const LANDING_PAGE_PATTERNS = [
    { hostname: 'mail.google.com', test: (p, h) =>
        !h.includes('#inbox/') && !h.includes('#sent/') && !h.includes('#search/') },
    { hostname: 'x.com',               pathExact: ['/home'] },
    { hostname: 'www.linkedin.com',    pathExact: ['/'] },
    { hostname: 'github.com',          pathExact: ['/'] },
    { hostname: 'www.youtube.com',     pathExact: ['/'] },
    // Merge personal patterns from config.local.js (if it exists)
    ...(typeof LOCAL_LANDING_PAGE_PATTERNS !== 'undefined' ? LOCAL_LANDING_PAGE_PATTERNS : []),
  ];

  function isLandingPage(url) {
    try {
      const parsed = new URL(url);
      return LANDING_PAGE_PATTERNS.some(p => {
        // Support both exact hostname and suffix matching (for wildcard subdomains)
        const hostnameMatch = p.hostname
          ? parsed.hostname === p.hostname
          : p.hostnameEndsWith
            ? parsed.hostname.endsWith(p.hostnameEndsWith)
            : false;
        if (!hostnameMatch) return false;
        if (p.test)       return p.test(parsed.pathname, url);
        if (p.pathPrefix) return parsed.pathname.startsWith(p.pathPrefix);
        if (p.pathExact)  return p.pathExact.includes(parsed.pathname);
        return parsed.pathname === '/';
      });
    } catch { return false; }
  }

  domainGroups = [];
  const groupMap    = {};
  const landingTabs = [];

  // Custom group rules from config.local.js (if any)
  const customGroups = typeof LOCAL_CUSTOM_GROUPS !== 'undefined' ? LOCAL_CUSTOM_GROUPS : [];

  // Check if a URL matches a custom group rule; returns the rule or null
  function matchCustomGroup(url) {
    try {
      const parsed = new URL(url);
      return customGroups.find(r => {
        const hostMatch = r.hostname
          ? parsed.hostname === r.hostname
          : r.hostnameEndsWith
            ? parsed.hostname.endsWith(r.hostnameEndsWith)
            : false;
        if (!hostMatch) return false;
        if (r.pathPrefix) return parsed.pathname.startsWith(r.pathPrefix);
        return true; // hostname matched, no path filter
      }) || null;
    } catch { return null; }
  }

  for (const tab of realTabs) {
    try {
      if (isLandingPage(tab.url)) {
        landingTabs.push(tab);
        continue;
      }

      // Check custom group rules first (e.g. merge subdomains, split by path)
      const customRule = matchCustomGroup(tab.url);
      if (customRule) {
        const key = customRule.groupKey;
        if (!groupMap[key]) groupMap[key] = { domain: key, label: customRule.groupLabel, tabs: [] };
        groupMap[key].tabs.push(tab);
        continue;
      }

      let hostname;
      if (tab.url && tab.url.startsWith('file://')) {
        hostname = 'local-files';
      } else {
        hostname = new URL(tab.url).hostname;
      }
      if (!hostname) continue;

      if (!groupMap[hostname]) groupMap[hostname] = { domain: hostname, tabs: [] };
      groupMap[hostname].tabs.push(tab);
    } catch {
      // Skip malformed URLs
    }
  }

  if (landingTabs.length > 0) {
    groupMap['__landing-pages__'] = { domain: '__landing-pages__', tabs: landingTabs };
  }

  // Sort: landing pages first, then domains from landing page sites, then by tab count
  // Collect exact hostnames and suffix patterns for priority sorting
  const landingHostnames = new Set(LANDING_PAGE_PATTERNS.map(p => p.hostname).filter(Boolean));
  const landingSuffixes = LANDING_PAGE_PATTERNS.map(p => p.hostnameEndsWith).filter(Boolean);
  function isLandingDomain(domain) {
    if (landingHostnames.has(domain)) return true;
    return landingSuffixes.some(s => domain.endsWith(s));
  }
  domainGroups = Object.values(groupMap).sort((a, b) => {
    const aIsLanding = a.domain === '__landing-pages__';
    const bIsLanding = b.domain === '__landing-pages__';
    if (aIsLanding !== bIsLanding) return aIsLanding ? -1 : 1;

    const aIsPriority = isLandingDomain(a.domain);
    const bIsPriority = isLandingDomain(b.domain);
    if (aIsPriority !== bIsPriority) return aIsPriority ? -1 : 1;

    return b.tabs.length - a.tabs.length;
  });

  // --- Render domain cards ---
  const openTabsSection      = document.getElementById('openTabsSection');
  const openTabsMissionsEl   = document.getElementById('openTabsMissions');
  const openTabsSectionCount = document.getElementById('openTabsSectionCount');
  const openTabsSectionTitle = document.getElementById('openTabsSectionTitle');

  if (domainGroups.length > 0 && openTabsSection) {
    if (openTabsSectionTitle) openTabsSectionTitle.textContent = '打开的标签页';
    openTabsSectionCount.innerHTML = `${domainGroups.length} 个分组 &nbsp;&middot;&nbsp; <button class="action-btn close-tabs" data-action="close-all-open-tabs" style="font-size:11px;padding:3px 10px;">${ICONS.close} 关闭全部 ${realTabs.length} 个标签页</button>`;
    openTabsMissionsEl.innerHTML = domainGroups.map(g => renderDomainCard(g)).join('');
    openTabsSection.style.display = 'block';
  } else if (openTabsSection) {
    openTabsSection.style.display = 'none';
  }

  // --- Footer stats ---
  const statTabs = document.getElementById('statTabs');
  if (statTabs) statTabs.textContent = openTabs.length;

  // --- Check for duplicate Tab Out tabs ---
  checkTabOutDupes();

}

async function renderDashboard() {
  if (dashboardRenderPromise) {
    dashboardRenderQueued = true;
    return dashboardRenderPromise;
  }

  dashboardRenderPromise = (async () => {
    try {
      do {
        dashboardRenderQueued = false;
        await renderStaticDashboard();
      } while (dashboardRenderQueued);
    } finally {
      dashboardRenderPromise = null;
    }
  })();

  return dashboardRenderPromise;
}

/* ----------------------------------------------------------------
   REALTIME TAB REFRESH

   Keep the dashboard in sync when tabs are opened, closed, or navigate
   while this Tab Out page is already open.
   ---------------------------------------------------------------- */

function scheduleRealtimeRefresh() {
  if (realtimeRefreshTimer !== null) clearTimeout(realtimeRefreshTimer);

  realtimeRefreshTimer = setTimeout(() => {
    realtimeRefreshTimer = null;
    renderDashboard().catch(err => {
      console.warn('[tab-out] Realtime refresh failed:', err);
    });
  }, REALTIME_REFRESH_DEBOUNCE_MS);
}

function installRealtimeTabRefresh() {
  if (
    typeof chrome === 'undefined' ||
    !chrome.tabs ||
    !chrome.tabs.onCreated ||
    !chrome.tabs.onUpdated ||
    !chrome.tabs.onRemoved
  ) {
    return;
  }

  chrome.tabs.onCreated.addListener(() => {
    scheduleRealtimeRefresh();
  });

  chrome.tabs.onRemoved.addListener(() => {
    scheduleRealtimeRefresh();
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    const shouldRefresh =
      Object.prototype.hasOwnProperty.call(changeInfo, 'url') ||
      Object.prototype.hasOwnProperty.call(changeInfo, 'title') ||
      Object.prototype.hasOwnProperty.call(changeInfo, 'status');

    if (shouldRefresh) scheduleRealtimeRefresh();
  });
}

function scheduleBookmarkRefresh() {
  if (bookmarkRefreshTimer !== null) clearTimeout(bookmarkRefreshTimer);

  bookmarkRefreshTimer = setTimeout(() => {
    bookmarkRefreshTimer = null;
    renderBrowserBookmarks().catch(err => {
      console.warn('[tab-out] Bookmark refresh failed:', err);
    });
  }, REALTIME_REFRESH_DEBOUNCE_MS);
}

function installRealtimeBookmarkRefresh() {
  if (
    typeof chrome === 'undefined' ||
    !chrome.bookmarks ||
    !chrome.bookmarks.onCreated ||
    !chrome.bookmarks.onRemoved ||
    !chrome.bookmarks.onChanged ||
    !chrome.bookmarks.onMoved
  ) {
    return;
  }

  chrome.bookmarks.onCreated.addListener(scheduleBookmarkRefresh);
  chrome.bookmarks.onRemoved.addListener(scheduleBookmarkRefresh);
  chrome.bookmarks.onChanged.addListener(scheduleBookmarkRefresh);
  chrome.bookmarks.onMoved.addListener(scheduleBookmarkRefresh);

  if (chrome.bookmarks.onChildrenReordered) {
    chrome.bookmarks.onChildrenReordered.addListener(scheduleBookmarkRefresh);
  }
}

function installAccessStatusRefresh() {
  setInterval(() => {
    renderDashboard().catch(err => {
      console.warn('[tab-out] Access status refresh failed:', err);
    });
  }, ACCESS_STATUS_REFRESH_MS);
}


/* ----------------------------------------------------------------
   EVENT HANDLERS — using event delegation

   One listener on document handles ALL button clicks.
   Think of it as one security guard watching the whole building
   instead of one per door.
   ---------------------------------------------------------------- */

document.addEventListener('click', async (e) => {
  // Walk up the DOM to find the nearest element with data-action
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;

  const action = actionEl.dataset.action;

  // ---- Dashboard module visibility/collapse controls ----
  if (action === 'toggle-module-collapse') {
    const moduleId = actionEl.dataset.moduleId;
    if (!modulePrefs[moduleId]) return;

    modulePrefs[moduleId].collapsed = !modulePrefs[moduleId].collapsed;
    applyModuleState(moduleId);
    await saveModulePrefs();
    return;
  }

  if (action === 'hide-module') {
    const moduleId = actionEl.dataset.moduleId;
    if (!modulePrefs[moduleId]) return;

    modulePrefs[moduleId].visible = false;
    applyModuleState(moduleId);
    await saveModulePrefs();
    return;
  }

  if (action === 'show-module') {
    const moduleId = actionEl.dataset.moduleId;
    if (!modulePrefs[moduleId]) return;

    modulePrefs[moduleId].visible = true;
    modulePrefs[moduleId].collapsed = false;
    applyModuleState(moduleId);
    await saveModulePrefs();
    if (moduleId === 'browserBookmarks') await renderBrowserBookmarks();
    if (moduleId === 'quickLinks') await renderQuickLinks();
    if (moduleId === 'deferred') await renderDeferredColumn();
    return;
  }

  // ---- Drag handle for quick navigation ordering ----
  if (action === 'drag-quick-link') {
    e.preventDefault();
    e.stopPropagation();
    return;
  }

  // ---- Open a browser bookmark ----
  if (action === 'open-browser-bookmark') {
    const url = actionEl.dataset.bookmarkUrl;
    if (url) await openQuickLink(url);
    return;
  }

  // ---- Enter a browser bookmark folder ----
  if (action === 'open-bookmark-folder') {
    selectedBookmarkFolderId = actionEl.dataset.bookmarkId || selectedBookmarkFolderId;
    selectedBookmarkFolderTitle = actionEl.dataset.bookmarkTitle || '收藏夹';
    bookmarksExpanded = false;
    await renderBrowserBookmarks();
    return;
  }

  // ---- Return to the browser bookmarks bar ----
  if (action === 'bookmark-folder-back') {
    await resetBookmarkFolderToBar();
    return;
  }

  // ---- Expand/collapse browser bookmarks preview ----
  if (action === 'toggle-bookmarks-expanded') {
    bookmarksExpanded = !bookmarksExpanded;
    await renderBrowserBookmarks();
    return;
  }

  // ---- Open a quick navigation link ----
  if (action === 'open-quick-link') {
    if (suppressNextQuickLinkOpen) {
      suppressNextQuickLinkOpen = false;
      return;
    }

    const url = actionEl.dataset.quickLinkUrl;
    if (url) await openQuickLink(url);
    return;
  }

  // ---- Edit a quick navigation link ----
  if (action === 'edit-quick-link') {
    e.stopPropagation();
    const id = actionEl.dataset.quickLinkId;
    if (id) await startEditingQuickLink(id);
    return;
  }

  // ---- Cancel quick link editing ----
  if (action === 'cancel-quick-link-edit') {
    e.stopPropagation();
    resetQuickLinkForm();
    return;
  }

  // ---- Remove a quick navigation link ----
  if (action === 'remove-quick-link') {
    e.stopPropagation();
    const id = actionEl.dataset.quickLinkId;
    if (!id) return;

    await removeQuickLink(id);
    await renderQuickLinks();
    showToast('已移除快捷入口');
    return;
  }

  // ---- Select a saved-for-later group tab ----
  if (action === 'select-deferred-group') {
    if (isDeferredItemSorting) return;
    selectedDeferredGroupId = actionEl.dataset.deferredGroupId || DEFERRED_ALL_GROUP_ID;
    await renderDeferredColumn();
    return;
  }

  // ---- Toggle saved-for-later item sorting mode ----
  if (action === 'toggle-deferred-group-sort') {
    if (selectedDeferredGroupId === DEFERRED_ALL_GROUP_ID) return;

    if (isDeferredItemSorting) {
      await saveDeferredItemOrderFromDom();
      isDeferredItemSorting = false;
      showToast('优先级顺序已保存');
    } else {
      isDeferredItemSorting = true;
    }
    await renderDeferredColumn();
    return;
  }

  // ---- Restore default saved-for-later item sorting ----
  if (action === 'reset-deferred-group-sort') {
    if (selectedDeferredGroupId === DEFERRED_ALL_GROUP_ID) return;

    const confirmed = window.confirm('确认恢复当前分组内网页的默认排序吗？');
    if (!confirmed) return;
    await resetDeferredItemSort(selectedDeferredGroupId);
    showToast('已恢复默认排序');
    return;
  }

  // ---- Filter saved-for-later items by remark within one domain group ----
  if (action === 'filter-deferred-remark') {
    e.preventDefault();
    e.stopPropagation();

    const groupId = actionEl.dataset.deferredGroupId;
    const remark = normalizeDeferredRemark(actionEl.dataset.deferredRemark);
    if (!groupId) return;

    if (!actionEl.dataset.deferredRemark) {
      deferredRemarkFilters.delete(groupId);
    } else {
      deferredRemarkFilters.set(groupId, remark);
    }

    await renderDeferredColumn();
    return;
  }

  // ---- Rename one remark group inside the current domain ----
  if (action === 'rename-deferred-remark') {
    e.preventDefault();
    e.stopPropagation();

    const groupId = actionEl.dataset.deferredGroupId;
    const oldRemark = normalizeDeferredRemark(actionEl.dataset.deferredRemark);
    if (!groupId) return;

    const input = window.prompt('更新组名', oldRemark);
    if (input === null) return;

    const newRemark = normalizeDeferredRemark(input);
    if (newRemark === oldRemark) return;

    const { remark, updatedCount } = await renameDeferredRemarkGroup(groupId, oldRemark, newRemark);
    if (updatedCount === 0) {
      showToast('没有可更新的待看内容');
      return;
    }

    if (deferredRemarkFilters.get(groupId) === oldRemark) {
      deferredRemarkFilters.set(groupId, remark);
    }

    showToast(`已更新组名 · ${remark}（${updatedCount}项）`);
    await renderDeferredColumn();
    return;
  }

  // ---- Reassign one saved-for-later item to another remark group ----
  if (action === 'edit-deferred-remark') {
    e.preventDefault();
    e.stopPropagation();

    const id = actionEl.dataset.deferredId;
    if (!id) return;

    const { deferred = [] } = await chrome.storage.local.get('deferred');
    const item = deferred.find(tab => tab.id === id && !tab.dismissed && !tab.completed);
    if (!item) {
      showToast('稍后处理不存在');
      return;
    }

    const currentRemark = getDeferredRemark(item);
    const remark = await promptDeferredRemarkForUrl(item.url, currentRemark);
    if (remark === null) return;

    const updated = await updateSavedTabRemark(id, remark);
    if (!updated) {
      showToast('稍后处理不存在');
      return;
    }

    const groupId = getDeferredGroupId(updated);
    if (deferredRemarkFilters.has(groupId)) {
      deferredRemarkFilters.set(groupId, remark);
    }

    showToast(`已更新备注 · ${remark}`);
    await renderDeferredColumn();
    return;
  }

  // ---- Close duplicate Tab Out tabs ----
  if (action === 'close-tabout-dupes') {
    await closeTabOutDupes();
    playCloseSound();
    const banner = document.getElementById('tabOutDupeBanner');
    if (banner) {
      banner.style.transition = 'opacity 0.4s';
      banner.style.opacity = '0';
      setTimeout(() => { banner.style.display = 'none'; banner.style.opacity = '1'; }, 400);
    }
    showToast('已关闭多余的 Tab Out 页面');
    return;
  }

  const card = actionEl.closest('.mission-card');

  // ---- Focus a specific tab ----
  if (action === 'focus-tab') {
    const tabUrl = actionEl.dataset.tabUrl;
    if (tabUrl) await focusTab(tabUrl);
    return;
  }

  // ---- Close a single tab ----
  if (action === 'close-single-tab') {
    e.stopPropagation(); // don't trigger parent chip's focus-tab
    const tabUrl = actionEl.dataset.tabUrl;
    if (!tabUrl) return;

    // Close the tab in Chrome directly
    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    playCloseSound();

    // Animate the chip row out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      const rect = chip.getBoundingClientRect();
      shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => {
        chip.remove();
        // If the card now has no tabs, remove it too
        const parentCard = document.querySelector('.mission-card:has(.mission-pages:empty)');
        if (parentCard) animateCardOut(parentCard);
        document.querySelectorAll('.mission-card').forEach(c => {
          if (c.querySelectorAll('.page-chip[data-action="focus-tab"]').length === 0) {
            animateCardOut(c);
          }
        });
      }, 200);
    }

    // Update footer
    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;

    showToast('标签页已关闭');
    return;
  }

  // ---- Save a single tab for later (then close it) ----
  if (action === 'defer-single-tab') {
    e.stopPropagation();
    const tabUrl   = actionEl.dataset.tabUrl;
    const tabTitle = actionEl.dataset.tabTitle || tabUrl;
    if (!tabUrl) return;

    const remark = await promptDeferredRemarkForUrl(tabUrl);
    if (remark === null) return;

    // Save to chrome.storage.local
    try {
      await saveTabForLater({ url: tabUrl, title: tabTitle, remark });
    } catch (err) {
      console.error('[tab-out] Failed to save tab:', err);
      showToast('保存失败');
      return;
    }

    // Close the tab in Chrome
    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    // Animate chip out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => chip.remove(), 200);
    }

    showToast(`已保存到稍后处理 · ${remark}`);
    await renderDeferredColumn();
    return;
  }

  // ---- Check off a saved tab (moves it to archive) ----
  if (action === 'check-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await checkOffSavedTab(id);

    // Animate: strikethrough first, then slide out
    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('checked');
      setTimeout(() => {
        item.classList.add('removing');
        setTimeout(() => {
          item.remove();
          renderDeferredColumn(); // refresh counts and archive
        }, 300);
      }, 800);
    }
    return;
  }

  // ---- Dismiss a saved tab (removes it entirely) ----
  if (action === 'dismiss-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await dismissSavedTab(id);

    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('removing');
      setTimeout(() => {
        item.remove();
        renderDeferredColumn();
      }, 300);
    }
    return;
  }

  // ---- Close all tabs in a domain group ----
  if (action === 'close-domain-tabs') {
    const domainId = actionEl.dataset.domainId;
    const group    = domainGroups.find(g => {
      return 'domain-' + g.domain.replace(/[^a-z0-9]/g, '-') === domainId;
    });
    if (!group) return;

    const urls      = group.tabs.map(t => t.url);
    // Landing pages and custom groups (whose domain key isn't a real hostname)
    // must use exact URL matching to avoid closing unrelated tabs
    const useExact  = group.domain === '__landing-pages__' || !!group.label;
    const groupLabel = group.domain === '__landing-pages__' ? '常用首页' : (group.label || friendlyDomain(group.domain));

    if (urls.length > 1) {
      const confirmed = window.confirm(`确认关闭「${groupLabel}」中的全部 ${urls.length} 个标签页吗？`);
      if (!confirmed) return;
    }

    if (useExact) {
      await closeTabsExact(urls);
    } else {
      await closeTabsByUrls(urls);
    }

    if (card) {
      playCloseSound();
      animateCardOut(card);
    }

    // Remove from in-memory groups
    const idx = domainGroups.indexOf(group);
    if (idx !== -1) domainGroups.splice(idx, 1);

    showToast(`已关闭「${groupLabel}」中的 ${urls.length} 个标签页`);

    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;
    return;
  }

  // ---- Close duplicates, keep one copy ----
  if (action === 'dedup-keep-one') {
    const urlsEncoded = actionEl.dataset.dupeUrls || '';
    const urls = urlsEncoded.split(',').map(u => decodeURIComponent(u)).filter(Boolean);
    if (urls.length === 0) return;

    await closeDuplicateTabs(urls, true);
    playCloseSound();

    // Hide the dedup button
    actionEl.style.transition = 'opacity 0.2s';
    actionEl.style.opacity    = '0';
    setTimeout(() => actionEl.remove(), 200);

    // Remove dupe badges from the card
    if (card) {
      card.querySelectorAll('.chip-dupe-badge').forEach(b => {
        b.style.transition = 'opacity 0.2s';
        b.style.opacity    = '0';
        setTimeout(() => b.remove(), 200);
      });
      card.querySelectorAll('.open-tabs-badge').forEach(badge => {
        if (badge.textContent.includes('重复')) {
          badge.style.transition = 'opacity 0.2s';
          badge.style.opacity    = '0';
          setTimeout(() => badge.remove(), 200);
        }
      });
      card.classList.remove('has-amber-bar');
      card.classList.add('has-neutral-bar');
    }

    showToast('已关闭重复标签页，每个页面保留一个');
    return;
  }

  // ---- Close ALL open tabs ----
  if (action === 'close-all-open-tabs') {
    const allUrls = openTabs
      .filter(t => t.url && !t.url.startsWith('chrome') && !t.url.startsWith('about:'))
      .map(t => t.url);
    await closeTabsByUrls(allUrls);
    playCloseSound();

    document.querySelectorAll('#openTabsMissions .mission-card').forEach(c => {
      shootConfetti(
        c.getBoundingClientRect().left + c.offsetWidth / 2,
        c.getBoundingClientRect().top  + c.offsetHeight / 2
      );
      animateCardOut(c);
    });

    showToast('所有标签页已关闭，重新开始。');
    return;
  }
});

// ---- Archive toggle — expand/collapse the archive section ----
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('#archiveToggle');
  if (!toggle) return;

  toggle.classList.toggle('open');
  const body = document.getElementById('archiveBody');
  if (body) {
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  }
});

function getQuickLinkDropTarget(container, x, y) {
  const cards = [...container.querySelectorAll('.quick-link-card:not(.dragging)')];
  return cards.find(card => {
    const rect = card.getBoundingClientRect();
    const isSameRow = y >= rect.top && y <= rect.bottom;
    if (isSameRow) return x < rect.left + rect.width / 2;
    return y < rect.top + rect.height / 2;
  }) || null;
}

// ---- Quick link drag sorting — Pointer Events support mouse + touch ----
document.addEventListener('pointerdown', (e) => {
  const handle = e.target.closest('.quick-link-drag');
  if (!handle) return;

  const card = handle.closest('.quick-link-card');
  const container = document.getElementById('quickLinksGrid');
  if (!card || !container) return;

  e.preventDefault();
  e.stopPropagation();
  const rect = card.getBoundingClientRect();
  const placeholder = document.createElement('div');
  placeholder.className = 'quick-link-placeholder';
  placeholder.style.height = `${rect.height}px`;
  container.insertBefore(placeholder, card);
  document.body.appendChild(card);

  card.setPointerCapture(e.pointerId);
  card.classList.add('dragging');
  document.body.classList.add('quick-link-dragging');

  Object.assign(card.style, {
    position: 'fixed',
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    zIndex: '1000',
    pointerEvents: 'none',
  });

  quickLinkDragState = {
    card,
    container,
    placeholder,
    pointerId: e.pointerId,
    offsetX: e.clientX - rect.left,
    offsetY: e.clientY - rect.top,
    startX: e.clientX,
    startY: e.clientY,
    moved: false,
  };
});

document.addEventListener('pointermove', (e) => {
  if (!quickLinkDragState) return;

  const { card, container, placeholder, offsetX, offsetY, startX, startY } = quickLinkDragState;
  card.style.left = `${e.clientX - offsetX}px`;
  card.style.top = `${e.clientY - offsetY}px`;
  quickLinkDragState.moved = Math.hypot(e.clientX - startX, e.clientY - startY) > 4;

  const dropTarget = getQuickLinkDropTarget(container, e.clientX, e.clientY);
  if (dropTarget && dropTarget !== placeholder) {
    container.insertBefore(placeholder, dropTarget);
  } else if (!dropTarget) {
    container.appendChild(placeholder);
  }
});

async function finishQuickLinkDrag() {
  if (!quickLinkDragState) return;

  const { card, container, placeholder, pointerId, moved } = quickLinkDragState;
  try {
    if (card.hasPointerCapture(pointerId)) card.releasePointerCapture(pointerId);
  } catch {}

  if (placeholder.parentNode) {
    placeholder.replaceWith(card);
  } else {
    container.appendChild(card);
  }

  card.classList.remove('dragging');
  Object.assign(card.style, {
    position: '',
    left: '',
    top: '',
    width: '',
    height: '',
    zIndex: '',
    pointerEvents: '',
  });
  document.body.classList.remove('quick-link-dragging');
  quickLinkDragState = null;

  if (moved) {
    suppressNextQuickLinkOpen = true;
    await saveQuickLinkOrderFromDom();
    showToast('常用导航顺序已保存');
    setTimeout(() => {
      suppressNextQuickLinkOpen = false;
    }, 250);
  }
}

document.addEventListener('pointerup', () => {
  finishQuickLinkDrag().catch(err => {
    console.warn('[tab-out] Could not save quick link order:', err);
  });
});

document.addEventListener('pointercancel', () => {
  finishQuickLinkDrag().catch(err => {
    console.warn('[tab-out] Could not save quick link order:', err);
  });
});

function getDeferredItemDropTarget(container, y) {
  const items = [...container.querySelectorAll('.deferred-item:not(.dragging)')];
  return items.find(item => {
    const rect = item.getBoundingClientRect();
    return y < rect.top + rect.height / 2;
  }) || null;
}

// ---- Deferred item drag sorting — Pointer Events support mouse + touch ----
document.addEventListener('pointerdown', (e) => {
  const handle = e.target.closest('.deferred-item-drag');
  if (!handle || !isDeferredItemSorting) return;

  const item = handle.closest('.deferred-item');
  const container = document.getElementById('deferredList');
  if (!item || !container) return;

  e.preventDefault();
  item.setPointerCapture(e.pointerId);
  item.classList.add('dragging');
  document.body.classList.add('deferred-item-dragging');
  deferredItemDragState = { item, container, pointerId: e.pointerId };
});

document.addEventListener('pointermove', (e) => {
  if (!deferredItemDragState) return;

  const { item, container } = deferredItemDragState;
  const dropTarget = getDeferredItemDropTarget(container, e.clientY);
  if (dropTarget && dropTarget !== item) {
    container.insertBefore(item, dropTarget);
  } else if (!dropTarget) {
    container.appendChild(item);
  }
});

async function finishDeferredItemDrag() {
  if (!deferredItemDragState) return;

  const { item } = deferredItemDragState;
  item.classList.remove('dragging');
  document.body.classList.remove('deferred-item-dragging');
  deferredItemDragState = null;
  await saveDeferredItemOrderFromDom();
}

document.addEventListener('pointerup', () => {
  finishDeferredItemDrag().catch(err => {
    console.warn('[tab-out] Could not save deferred item order:', err);
  });
});

document.addEventListener('pointercancel', () => {
  finishDeferredItemDrag().catch(err => {
    console.warn('[tab-out] Could not save deferred item order:', err);
  });
});

// ---- Quick link form — add or edit a custom navigation shortcut ----
document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'quickLinkForm') return;
  e.preventDefault();

  const editingInput = document.getElementById('quickLinkEditingId');
  const titleInput = document.getElementById('quickLinkTitle');
  const urlInput   = document.getElementById('quickLinkUrl');
  if (!titleInput || !urlInput) return;

  try {
    const editingId = editingInput ? editingInput.value : '';
    const payload = {
      title: titleInput.value,
      url:   urlInput.value,
    };

    if (editingId) {
      await updateQuickLink(editingId, payload);
    } else {
      await addQuickLink(payload);
    }

    resetQuickLinkForm();
    await renderQuickLinks();
    showToast(editingId ? '快捷入口已更新' : '已添加到常用导航');
  } catch (err) {
    showToast(err.message || '保存失败');
  }
});

let quickLinkAutofillTimer = null;

// ---- Quick link URL input — infer title while the user adds a shortcut ----
document.addEventListener('input', (e) => {
  if (e.target.id === 'quickLinkTitle') {
    quickLinkTitleManuallyEdited = true;
    return;
  }

  if (e.target.id !== 'quickLinkUrl') return;

  if (quickLinkAutofillTimer !== null) clearTimeout(quickLinkAutofillTimer);
  quickLinkAutofillTimer = setTimeout(() => {
    quickLinkAutofillTimer = null;
    maybeAutofillQuickLinkTitle().catch(err => {
      console.warn('[tab-out] Could not infer quick link title:', err);
    });
  }, 250);
});

document.addEventListener('blur', (e) => {
  if (e.target.id !== 'quickLinkUrl') return;
  maybeAutofillQuickLinkTitle().catch(err => {
    console.warn('[tab-out] Could not infer quick link title:', err);
  });
}, true);

// ---- Archive search — filter archived items as user types ----
document.addEventListener('input', async (e) => {
  if (e.target.id !== 'archiveSearch') return;

  const q = e.target.value.trim().toLowerCase();
  const archiveList = document.getElementById('archiveList');
  if (!archiveList) return;

  try {
    const { archived } = await getSavedTabs();

    if (q.length < 2) {
      // Show all archived items
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      return;
    }

    // Filter by title or URL containing the query string
    const results = archived.filter(item =>
      (item.title || '').toLowerCase().includes(q) ||
      (item.url  || '').toLowerCase().includes(q)
    );

    archiveList.innerHTML = results.map(item => renderArchiveItem(item)).join('')
      || '<div style="font-size:12px;color:var(--muted);padding:8px 0">没有找到结果</div>';
  } catch (err) {
    console.warn('[tab-out] Archive search failed:', err);
  }
});


/* ----------------------------------------------------------------
   INITIALIZE
   ---------------------------------------------------------------- */
async function initializeDashboard() {
  await loadModulePrefs();
  installRealtimeTabRefresh();
  installRealtimeBookmarkRefresh();
  installAccessStatusRefresh();
  await renderDashboard();
}

initializeDashboard().catch(err => {
  console.warn('[tab-out] Dashboard initialization failed:', err);
});
