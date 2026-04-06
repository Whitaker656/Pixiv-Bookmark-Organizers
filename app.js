const STORAGE_KEY = "pixiv-bookmark-organizer-state-github-share";
const STORAGE_VERSION = 2;
const SNAPSHOT_GLOBAL_KEY = "__PIXIV_BOOKMARK_SNAPSHOT__";
const BOOKMARK_TAG_STATS_GLOBAL_KEY = "__PIXIV_BOOKMARK_TAG_STATS__";
const THUMBNAIL_CACHE_INDEX_GLOBAL_KEY = "__PIXIV_THUMBNAIL_CACHE_INDEX__";
const LONG_PRESS_DURATION_MS = 650;
const QUICK_REPLACE_DELETE_VALUE = "__DELETE__";
const MAX_RECOMMENDATIONS = 8;

const initialState = {
  selectedArtworkId: "",
  selectedArtworkIds: [],
  selectedDeletedArtworkIds: [],
  galleryFilter: "all",
  gallerySearch: "",
  galleryPage: 1,
  galleryPageSize: 48,
  snapshotInfo: null,
  accountTags: [
    { id: "acct-1", name: "original", note: "기본 분류" },
    { id: "acct-2", name: "favorite", note: "자주 재사용" },
    { id: "acct-3", name: "needs-review", note: "확인 필요" }
  ],
  artworkOverrides: {},
  artworks: [],
  mappings: [],
  replaceRules: []
};

let state = loadState();
const uiState = {
  galleryPageJumpDraft: ""
};
const derivedState = {
  textNormalizationCache: new Map(),
  tokenCache: new Map(),
  bigramCache: new Map(),
  artworkProfileCache: new Map(),
  recommendationCache: new Map(),
  currentBookmarkTagStats: {
    revision: -1,
    value: []
  },
  accountTagUsageCounts: {
    revision: -1,
    value: {}
  },
  revisions: {
    artworkData: 0,
    accountTags: 0,
    mappings: 0
  }
};
const apiState = {
  available: false,
  worker: null,
  lastCacheGeneratedAt: String(window[THUMBNAIL_CACHE_INDEX_GLOBAL_KEY]?.generated_at || ""),
  lastStatusSignature: "",
  pollTimer: null,
  syncBusy: false,
  syncApplyWorker: null,
  refreshBusy: false,
  session: {
    loading: false,
    checked: false,
    authenticated: false,
    authMode: "",
    authSource: "none",
    authValue: "",
    configuredUserId: "",
    profile: null,
    error: ""
  },
  deletedRemoval: {
    running: false,
    total: 0,
    completed: 0,
    failed: 0
  }
};
applyBundledSnapshot();
let lastPersistedStateRaw = window.localStorage.getItem(STORAGE_KEY) || "";

function finalizeRender() {
  saveState();
  document.body.classList.add("is-loaded");
}

function invalidateArtworkDerivedData() {
  derivedState.artworkProfileCache.clear();
  derivedState.recommendationCache.clear();
  derivedState.currentBookmarkTagStats.revision = -1;
  derivedState.accountTagUsageCounts.revision = -1;
  derivedState.revisions.artworkData += 1;
}

function invalidateAccountTagDerivedData() {
  derivedState.artworkProfileCache.clear();
  derivedState.recommendationCache.clear();
  derivedState.currentBookmarkTagStats.revision = -1;
  derivedState.accountTagUsageCounts.revision = -1;
  derivedState.revisions.accountTags += 1;
}

function invalidateMappingDerivedData() {
  derivedState.recommendationCache.clear();
  derivedState.revisions.mappings += 1;
}

function loadState() {
  const saved = window.localStorage.getItem(STORAGE_KEY);
  if (!saved) {
    return normalizeAccountTagState(structuredClone(initialState));
  }

  try {
    const parsed = JSON.parse(saved);
    const isCurrentStorage = Number(parsed.storageVersion || 0) >= STORAGE_VERSION;
    return normalizeAccountTagState({
      ...structuredClone(initialState),
      ...parsed,
      selectedArtworkId: "",
      selectedArtworkIds: [],
      selectedDeletedArtworkIds: [],
      accountTags: Array.isArray(parsed.accountTags) ? parsed.accountTags : structuredClone(initialState.accountTags),
      artworkOverrides: isCurrentStorage && parsed.artworkOverrides && typeof parsed.artworkOverrides === "object" ? parsed.artworkOverrides : {},
      artworks: [],
      mappings: Array.isArray(parsed.mappings) ? parsed.mappings : [],
      replaceRules: Array.isArray(parsed.replaceRules) ? parsed.replaceRules : []
    });
  } catch {
    return normalizeAccountTagState(structuredClone(initialState));
  }
}

function saveState() {
  const persistedState = {
    storageVersion: STORAGE_VERSION,
    selectedArtworkId: state.selectedArtworkId,
    selectedArtworkIds: state.selectedArtworkIds,
    selectedDeletedArtworkIds: state.selectedDeletedArtworkIds,
    galleryFilter: state.galleryFilter,
    gallerySearch: state.gallerySearch,
    galleryPage: state.galleryPage,
    galleryPageSize: state.galleryPageSize,
    accountTags: state.accountTags,
    artworkOverrides: state.artworkOverrides,
    mappings: state.mappings,
    replaceRules: state.replaceRules
  };

  const serialized = JSON.stringify(persistedState);
  if (serialized === lastPersistedStateRaw) {
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, serialized);
  lastPersistedStateRaw = serialized;
}

function createId(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

function createUniqueId(prefix, usedIds) {
  let id = createId(prefix);
  while (usedIds.has(id)) {
    id = createId(prefix);
  }
  return id;
}

function normalizeAccountTagState(inputState) {
  const workingState = inputState;
  const rawTags = Array.isArray(workingState.accountTags) ? workingState.accountTags : [];
  const usedIds = new Set();
  const idRemap = new Map();

  workingState.accountTags = rawTags.map((tag) => {
    const name = String(tag?.name || "").trim();
    if (!name) {
      return null;
    }

    const originalId = String(tag?.id || "").trim();
    const nextId = originalId && !usedIds.has(originalId)
      ? originalId
      : createUniqueId("acct", usedIds);

    if (originalId && originalId !== nextId) {
      idRemap.set(originalId, nextId);
    }

    usedIds.add(nextId);
    return {
      id: nextId,
      name,
      note: String(tag?.note || "").trim()
    };
  }).filter(Boolean);

  const validTagIds = new Set(workingState.accountTags.map((tag) => tag.id));
  const remapTagId = (tagId) => idRemap.get(String(tagId || "").trim()) || String(tagId || "").trim();

  workingState.mappings = (Array.isArray(workingState.mappings) ? workingState.mappings : []).map((mapping) => ({
    ...mapping,
    accountTagId: remapTagId(mapping.accountTagId)
  })).filter((mapping) => validTagIds.has(mapping.accountTagId));

  workingState.replaceRules = (Array.isArray(workingState.replaceRules) ? workingState.replaceRules : []).map((rule) => {
    const sourceTagId = remapTagId(rule.sourceTagId);
    const targetTagId = remapTagId(rule.targetTagId);
    const sourceTag = workingState.accountTags.find((tag) => tag.id === sourceTagId);
    return {
      ...rule,
      sourceTagId,
      sourceTagName: sourceTag?.name || String(rule.sourceTagName || "").trim(),
      targetTagId
    };
  }).filter((rule) => validTagIds.has(rule.sourceTagId) && validTagIds.has(rule.targetTagId));

  if (Array.isArray(workingState.artworks)) {
    workingState.artworks = workingState.artworks.map((artwork) => ({
      ...artwork,
      accountTagIds: Array.isArray(artwork.accountTagIds)
        ? artwork.accountTagIds.map((tagId) => remapTagId(tagId)).filter((tagId) => validTagIds.has(tagId))
        : []
    }));
  }

  return workingState;
}

function copyText(text, successMessage) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => showToast(successMessage)).catch(() => showToast("복사에 실패했습니다."));
    return;
  }
  showToast("복사에 실패했습니다.");
}

function showToast(message) {
  const toast = document.getElementById("feedback-toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("is-visible"), 2200);
}

function getThumbnailCacheIndex() {
  const cache = window[THUMBNAIL_CACHE_INDEX_GLOBAL_KEY];
  return cache && typeof cache === "object" && cache.items && typeof cache.items === "object" ? cache.items : {};
}

function isApiAvailable() {
  return apiState.available;
}

function applyThumbnailCacheIndex(cacheIndex) {
  state.artworks.forEach((artwork) => {
    artwork.localThumbnailUrl = String(cacheIndex[artwork.sourceId] || "");
  });
}

async function refreshThumbnailCacheIndexFromServer(shouldRender = true) {
  if (!window.fetch || !window.location.protocol.startsWith("http")) {
    return false;
  }

  try {
    const response = await fetch(`data/thumbnail_cache_index.json?ts=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) {
      return false;
    }
    const payload = await response.json();
    window[THUMBNAIL_CACHE_INDEX_GLOBAL_KEY] = payload;
    apiState.lastCacheGeneratedAt = String(payload.generated_at || "");
    applyThumbnailCacheIndex(getThumbnailCacheIndex());
    if (shouldRender) {
      renderAll();
    }
    return true;
  } catch {
    return false;
  }
}

async function refreshBundledDataFromServer() {
  if (!window.fetch || !window.location.protocol.startsWith("http")) {
    return false;
  }

  try {
    const [snapshotResponse, tagStatsResponse] = await Promise.all([
      fetch(`data/bookmarks_ui_snapshot.json?ts=${Date.now()}`, { cache: "no-store" }),
      fetch(`data/bookmark_tag_stats.json?ts=${Date.now()}`, { cache: "no-store" })
    ]);
    if (!snapshotResponse.ok || !tagStatsResponse.ok) {
      return false;
    }

    window[SNAPSHOT_GLOBAL_KEY] = await snapshotResponse.json();
    window[BOOKMARK_TAG_STATS_GLOBAL_KEY] = await tagStatsResponse.json();
    await refreshThumbnailCacheIndexFromServer(false);
    applyBundledSnapshot();
    renderAll();
    return true;
  } catch {
    return false;
  }
}

function getAuthSourceLabel(authSource, authValue = "") {
  if (authSource === "cookie_file") {
    return authValue ? `쿠키 파일 (${authValue})` : "쿠키 파일";
  }
  if (authSource === "raw_cookie") {
    return "raw_cookie";
  }
  if (authSource === "php_sessid") {
    return "PHPSESSID";
  }
  return "설정 없음";
}

function buildPolledStatusSignature(payload) {
  const worker = payload?.thumbnail_worker || {};
  const syncWorker = payload?.sync_apply_worker || {};
  return JSON.stringify({
    server: payload?.server || "",
    thumbnailWorker: {
      running: Boolean(worker.running),
      mode: String(worker.mode || ""),
      roundsCompleted: Number(worker.rounds_completed || 0),
      lastGeneratedAt: String((worker.last_result || {}).generated_at || ""),
      lastError: String(worker.last_error || "")
    },
    syncApplyWorker: {
      running: Boolean(syncWorker.running),
      completedActions: Number(syncWorker.completed_actions || 0),
      totalActions: Number(syncWorker.total_actions || 0),
      updatedCount: Number(syncWorker.updated_count || 0),
      skippedCount: Number(syncWorker.skipped_count || 0),
      failedCount: Number(syncWorker.failed_count || 0),
      currentArtworkId: String((syncWorker.current_action || {}).artwork_id || ""),
      lastError: String(syncWorker.last_error || "")
    }
  });
}

async function validatePixivSession(triggeredByUser = true) {
  if (!window.fetch || !window.location.protocol.startsWith("http") || !apiState.available) {
    if (triggeredByUser) {
      showToast("로컬 서버 실행 후 세션을 확인할 수 있습니다.");
    }
    return false;
  }

  apiState.session.loading = true;
  renderHeaderStatus();

  try {
    const response = await fetch(`api/session/status?ts=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) {
      throw new Error("session-status-failed");
    }

    const payload = await response.json();
    const session = payload.session || {};
    apiState.session = {
      loading: false,
      checked: true,
      authenticated: Boolean(session.authenticated),
      authMode: String(session.auth_mode || ""),
      authSource: String(session.auth_source || "none"),
      authValue: String(session.auth_value || ""),
      configuredUserId: String(session.configured_user_id || ""),
      profile: session.profile || null,
      error: String(session.error || "")
    };

    if (triggeredByUser) {
      showToast(apiState.session.authenticated ? "Pixiv 세션이 확인되었습니다." : "Pixiv 세션 확인에 실패했습니다.");
    }
    renderAll();
    return apiState.session.authenticated;
  } catch (error) {
    apiState.session = {
      ...apiState.session,
      loading: false,
      checked: true,
      authenticated: false,
      profile: null,
      error: error instanceof Error ? error.message : "session-status-failed"
    };
    if (triggeredByUser) {
      showToast("Pixiv 세션을 확인하지 못했습니다.");
    }
    renderAll();
    return false;
  }
}

function showSessionGuide() {
  window.alert([
    "이 프로그램은 앱 안에서 직접 로그인하지 않고 쿠키 기반으로 동작합니다.",
    "",
    "1. 브라우저에서 Pixiv에 로그인합니다.",
    "2. pixiv.net_cookies.txt를 준비하거나 pixiv_config.json에 raw_cookie / php_sessid를 넣습니다.",
    "3. 프로그램 상단의 '세션 확인' 버튼으로 현재 로그인 상태를 점검합니다.",
    "",
    "로그아웃하려면 pixiv_config.json의 cookie_file, raw_cookie, php_sessid 값을 비우거나 다른 쿠키 파일로 바꾸면 됩니다."
  ].join("\n"));
}

async function fetchApiStatus() {
  if (!window.fetch || !window.location.protocol.startsWith("http")) {
    const nextSignature = "offline";
    const shouldRender = apiState.lastStatusSignature !== nextSignature;
    apiState.available = false;
    apiState.worker = null;
    apiState.syncApplyWorker = null;
    apiState.lastStatusSignature = nextSignature;
    if (shouldRender) {
      renderAll();
    }
    return;
  }

  try {
    const previousSignature = apiState.lastStatusSignature;
    const response = await fetch(`api/status?ts=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) {
      throw new Error("api-status-failed");
    }
    const payload = await response.json();
    apiState.available = payload.server === "ok";
    apiState.worker = payload.thumbnail_worker || null;
    apiState.syncApplyWorker = payload.sync_apply_worker || null;

    const generatedAt = String(window[THUMBNAIL_CACHE_INDEX_GLOBAL_KEY]?.generated_at || "");
    if (apiState.available && apiState.lastCacheGeneratedAt !== generatedAt) {
      apiState.lastCacheGeneratedAt = generatedAt;
    }

    const remoteGeneratedAt = String((window[THUMBNAIL_CACHE_INDEX_GLOBAL_KEY] || {}).generated_at || "");
    const latestGeneratedAt = String((payload.thumbnail_worker?.last_result || {}).generated_at || "");
    let cacheChanged = false;
    if (latestGeneratedAt && latestGeneratedAt !== remoteGeneratedAt) {
      cacheChanged = await refreshThumbnailCacheIndexFromServer(false);
    }

    const nextSignature = buildPolledStatusSignature(payload);
    apiState.lastStatusSignature = nextSignature;

    if (apiState.available && !apiState.session.checked && !apiState.session.loading) {
      void validatePixivSession(false);
    }

    if (cacheChanged || nextSignature !== previousSignature) {
      renderAll();
    }
  } catch {
    const nextSignature = "offline";
    const shouldRender = apiState.lastStatusSignature !== nextSignature;
    apiState.available = false;
    apiState.worker = null;
    apiState.syncApplyWorker = null;
    apiState.lastStatusSignature = nextSignature;
    if (shouldRender) {
      renderAll();
    }
  }
}

function getDisplayTagName(tagName) {
  const aliases = {
    "未分類": "미분류"
  };
  return aliases[String(tagName)] || String(tagName);
}
function getPixivBookmarkTagStats() {
  const tagStats = window[BOOKMARK_TAG_STATS_GLOBAL_KEY];
  return tagStats && Array.isArray(tagStats.tags) ? tagStats.tags : [];
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function createGalleryPaginationMarkup(currentPage) {
  return `<div class="gallery-summary"></div><div class="pagination-actions"><form class="pagination-jump-form" data-action="jump-gallery-page"><span class="pagination-jump-label" aria-hidden="true">페이지 이동</span><input class="pagination-jump-input" name="page" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" placeholder="${escapeHtml(currentPage)}" aria-label="이동할 페이지 번호"><span class="pagination-jump-separator"></span><button class="ghost-button mini-button" type="submit">이동</button></form><button class="ghost-button mini-button" type="button" data-action="change-gallery-page" data-page-direction="-1">이전</button><button class="ghost-button mini-button" type="button" data-action="change-gallery-page" data-page-direction="1">다음</button></div>`;
}

function renderPaginationRow(container, currentPage, totalPages) {
  if (!container) {
    return;
  }
  if (!container.querySelector(".pagination-actions")) {
    container.innerHTML = createGalleryPaginationMarkup(currentPage);
  }

  const summary = container.querySelector(".gallery-summary");
  const pageInput = container.querySelector(".pagination-jump-input");
  const separator = container.querySelector(".pagination-jump-separator");
  const prevButton = container.querySelector('[data-action="change-gallery-page"][data-page-direction="-1"]');
  const nextButton = container.querySelector('[data-action="change-gallery-page"][data-page-direction="1"]');

  if (summary) {
    summary.textContent = `페이지 ${currentPage} / ${totalPages}`;
  }
  if (separator) {
    separator.textContent = `/ ${totalPages}`;
  }
  if (pageInput) {
    const draftValue = uiState.galleryPageJumpDraft;
    if (pageInput.value !== draftValue) {
      pageInput.value = draftValue;
    }
    pageInput.placeholder = String(currentPage);
  }
  if (prevButton instanceof HTMLButtonElement) {
    prevButton.disabled = currentPage <= 1;
  }
  if (nextButton instanceof HTMLButtonElement) {
    nextButton.disabled = currentPage >= totalPages;
  }
}

function getCurrentBookmarkTagStats() {
  if (derivedState.currentBookmarkTagStats.revision === derivedState.revisions.artworkData) {
    return derivedState.currentBookmarkTagStats.value;
  }

  const counts = new Map();

  state.artworks.forEach((artwork) => {
    const artworkTags = getArtworkAccountTags(artwork);
    if (artworkTags.length === 0) {
      const unclassifiedName = "未分類";
      if (!counts.has(unclassifiedName)) {
        counts.set(unclassifiedName, { name: unclassifiedName, public_count: 0, private_count: 0 });
      }
      const entry = counts.get(unclassifiedName);
      if (artwork.visibility === "private") {
        entry.private_count += 1;
      } else {
        entry.public_count += 1;
      }
      return;
    }

    artworkTags.forEach((tag) => {
      const name = String(tag?.name || "").trim();
      if (!name) {
        return;
      }
      if (!counts.has(name)) {
        counts.set(name, { name, public_count: 0, private_count: 0 });
      }
      const entry = counts.get(name);
      if (artwork.visibility === "private") {
        entry.private_count += 1;
      } else {
        entry.public_count += 1;
      }
    });
  });

  const value = [...counts.values()]
    .map((tag) => ({ ...tag, count: tag.public_count + tag.private_count }))
    .sort((left, right) => {
      const leftIsUnclassified = isUnclassifiedBookmarkTagName(left.name);
      const rightIsUnclassified = isUnclassifiedBookmarkTagName(right.name);
      if (leftIsUnclassified !== rightIsUnclassified) {
        return leftIsUnclassified ? -1 : 1;
      }
      const countDiff = Number(right.count || 0) - Number(left.count || 0);
      return countDiff !== 0 ? countDiff : String(left.name).localeCompare(String(right.name), "ko");
    });

  derivedState.currentBookmarkTagStats = {
    revision: derivedState.revisions.artworkData,
    value
  };

  return value;
}

function getAccountTagsSortedByPixivOrder() {
  const pixivOrder = new Map(
    getPixivBookmarkTagStats().map((tag, index) => [String(tag?.name || "").trim(), index])
  );

  return [...state.accountTags].sort((left, right) => {
    const leftOrder = pixivOrder.get(String(left?.name || "").trim());
    const rightOrder = pixivOrder.get(String(right?.name || "").trim());
    const leftHasOrder = Number.isInteger(leftOrder);
    const rightHasOrder = Number.isInteger(rightOrder);

    if (leftHasOrder && rightHasOrder && leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    if (leftHasOrder !== rightHasOrder) {
      return leftHasOrder ? -1 : 1;
    }
    return String(left?.name || "").localeCompare(String(right?.name || ""), "ko");
  });
}

function applyBundledSnapshot() {
  const snapshot = window[SNAPSHOT_GLOBAL_KEY];
  if (!snapshot || !Array.isArray(snapshot.items)) {
    return;
  }

  const cacheIndex = getThumbnailCacheIndex();
  const existingByName = new Map(state.accountTags.map((tag) => [tag.name, tag]));

  snapshot.items.forEach((item) => {
    (item.bookmark_tags || []).forEach((tagName) => {
      const name = String(tagName || "").trim();
      if (!name || existingByName.has(name)) {
        return;
      }
      existingByName.set(name, { id: createId("acct"), name, note: "Pixiv 북마크 태그에서 가져옴" });
    });
  });

  state.accountTags = [...existingByName.values()];
  normalizeAccountTagState(state);
  state.artworks = snapshot.items.map((item) => {
    const sourceId = String(item.id || "");
    const originalBookmarkTags = getNormalizedTagNames(item.bookmark_tags || []);
    const overrideBookmarkTags = Array.isArray(state.artworkOverrides[sourceId])
      ? getNormalizedTagNames(state.artworkOverrides[sourceId])
      : null;
    const effectiveBookmarkTags = overrideBookmarkTags || originalBookmarkTags;

    return {
      id: `art-${item.id}`,
      bookmarkId: item.bookmark_id || `bookmark-${item.id}`,
      sourceId,
      title: String(item.title || "제목 없음"),
      author: String(item.author || "작가 미상"),
      likes: Number(item.like_count || 0),
      thumbnailUrl: String(item.thumbnail_url || ""),
      localThumbnailUrl: String(cacheIndex[sourceId] || ""),
      visibility: item.visibility === "private" ? "private" : "public",
      isDeleted: Boolean(item.is_deleted),
      pixivTags: Array.isArray(item.pixiv_tags) ? item.pixiv_tags.map((tag) => String(tag)) : [],
      originalBookmarkTags,
      accountTagIds: effectiveBookmarkTags
        .map((tagName) => existingByName.get(String(tagName)))
        .filter(Boolean)
        .map((tag) => tag.id)
    };
  });

  const validArtworkIds = new Set(state.artworks.map((artwork) => artwork.id));
  const validSelectedIds = state.selectedArtworkIds.filter((artworkId) => validArtworkIds.has(artworkId));
  state.selectedArtworkIds = validSelectedIds;
  state.selectedDeletedArtworkIds = state.selectedDeletedArtworkIds.filter((artworkId) => validArtworkIds.has(artworkId));
  state.selectedArtworkId = validSelectedIds.includes(state.selectedArtworkId) ? state.selectedArtworkId : "";
  invalidateArtworkDerivedData();
  invalidateAccountTagDerivedData();
  state.snapshotInfo = {
    count: state.artworks.length,
    fetchedAt: String(snapshot.fetched_at || ""),
    source: "pixiv"
  };
}

function getSelectedArtworkIds() {
  const valid = new Set(state.artworks.map((artwork) => artwork.id));
  return state.selectedArtworkIds.filter((id) => valid.has(id));
}

function getSelectedArtwork() {
  return state.artworks.find((artwork) => artwork.id === state.selectedArtworkId) || null;
}

function getSelectionTargets() {
  const ids = new Set(getSelectedArtworkIds());
  return ids.size > 0 ? state.artworks.filter((artwork) => ids.has(artwork.id)) : [];
}

function getAccountTagById(tagId) {
  return state.accountTags.find((tag) => tag.id === tagId) || null;
}

function deletePixivBookmarkTag(tagName) {
  const normalizedName = String(tagName || "").trim();
  if (!normalizedName) {
    return;
  }

  const targetTag = state.accountTags.find((tag) => tag.name === normalizedName);
  if (!targetTag) {
    return;
  }

  const affectedArtworks = state.artworks.filter((artwork) => artwork.accountTagIds.includes(targetTag.id));
  if (affectedArtworks.length === 0) {
    return;
  }

  affectedArtworks.forEach((artwork) => {
    artwork.accountTagIds = artwork.accountTagIds.filter((id) => id !== targetTag.id);
  });
  syncArtworkOverrides(affectedArtworks);

  if (state.gallerySearch.trim() === normalizedName) {
    state.gallerySearch = "";
    state.galleryPage = 1;
  }

  invalidateArtworkDerivedData();
  renderAll();
}

function confirmDeletePixivBookmarkTag(tagName) {
  const normalizedName = String(tagName || "").trim();
  if (!normalizedName) {
    return;
  }
  if (!window.confirm(`정말 ${normalizedName}를 삭제하시겠습니까?`)) {
    return;
  }
  deletePixivBookmarkTag(normalizedName);
}

function getArtworkAccountTags(artwork) {
  return artwork.accountTagIds.map((id) => getAccountTagById(id)).filter(Boolean);
}

function getNormalizedTagNames(tagNames) {
  return [...new Set((tagNames || []).map((tagName) => String(tagName || "").trim()).filter(Boolean))].sort();
}

function getNormalizedArtworkAccountTagNames(artwork) {
  return getNormalizedTagNames(getArtworkAccountTags(artwork).map((tag) => tag.name));
}

function getArtworkOverrideKey(artwork) {
  return String(artwork.sourceId || "");
}

function getArtworkPixivUrl(artwork) {
  const sourceId = String(artwork?.sourceId || "").trim();
  return sourceId ? `https://www.pixiv.net/artworks/${encodeURIComponent(sourceId)}` : "#";
}

function syncArtworkOverride(artwork) {
  const key = getArtworkOverrideKey(artwork);
  if (!key) {
    return;
  }

  const currentTagNames = getNormalizedArtworkAccountTagNames(artwork);
  const originalTagNames = getNormalizedTagNames(artwork.originalBookmarkTags || []);
  if (currentTagNames.length === originalTagNames.length && currentTagNames.every((tagName, index) => tagName === originalTagNames[index])) {
    delete state.artworkOverrides[key];
    return;
  }

  state.artworkOverrides[key] = currentTagNames;
}

function syncArtworkOverrides(artworks) {
  artworks.forEach((artwork) => syncArtworkOverride(artwork));
}

function getCommonAccountTags(artworks) {
  if (artworks.length === 0) {
    return [];
  }
  const common = artworks.reduce((set, artwork, index) => {
    const ids = new Set(artwork.accountTagIds);
    if (index === 0) {
      return ids;
    }
    return new Set([...set].filter((id) => ids.has(id)));
  }, new Set());
  return [...common].map((id) => getAccountTagById(id)).filter(Boolean);
}

function getArtworkStatusLabel(artwork) {
  const labels = [];
  if (artwork.isDeleted) labels.push("삭제");
  if (artwork.visibility === "private") labels.push("비공개");
  return labels.length > 0 ? labels.join(" · ") : "정상";
}

function getArtworkIssues(artwork) {
  const issues = [];
  if (artwork.isDeleted) issues.push({ type: "deleted", label: "삭제", detail: "원본이 삭제됐거나 접근할 수 없습니다." });
  if (artwork.visibility === "private") issues.push({ type: "private", label: "비공개", detail: "비공개 북마크 작품입니다." });
  return issues;
}

function getIssueArtworks() {
  return state.artworks.map((artwork) => ({ artwork, issues: getArtworkIssues(artwork) })).filter((item) => item.issues.length > 0);
}

function getDeletedArtworks() {
  return state.artworks.filter((artwork) => artwork.isDeleted && artwork.bookmarkId);
}

function getSelectedDeletedArtworkIds() {
  const deletedArtworkIds = new Set(getDeletedArtworks().map((artwork) => artwork.id));
  return state.selectedDeletedArtworkIds.filter((artworkId) => deletedArtworkIds.has(artworkId));
}

function normalizeRecommendationText(value) {
  const cacheKey = String(value || "");
  if (derivedState.textNormalizationCache.has(cacheKey)) {
    return derivedState.textNormalizationCache.get(cacheKey);
  }

  const normalized = cacheKey
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ");

  derivedState.textNormalizationCache.set(cacheKey, normalized);
  return normalized;
}

function tokenizeRecommendationText(value) {
  const cacheKey = String(value || "");
  if (derivedState.tokenCache.has(cacheKey)) {
    return derivedState.tokenCache.get(cacheKey);
  }

  const normalized = normalizeRecommendationText(cacheKey);
  const tokens = normalized ? normalized.split(" ").filter(Boolean) : [];
  derivedState.tokenCache.set(cacheKey, tokens);
  return tokens;
}

function getCharacterBigrams(value) {
  const cacheKey = String(value || "");
  if (derivedState.bigramCache.has(cacheKey)) {
    return derivedState.bigramCache.get(cacheKey);
  }

  const normalized = normalizeRecommendationText(cacheKey).replace(/\s+/g, "");
  if (!normalized) {
    derivedState.bigramCache.set(cacheKey, []);
    return [];
  }
  if (normalized.length < 2) {
    const single = [normalized];
    derivedState.bigramCache.set(cacheKey, single);
    return single;
  }

  const bigrams = [];
  for (let index = 0; index < normalized.length - 1; index += 1) {
    bigrams.push(normalized.slice(index, index + 2));
  }
  derivedState.bigramCache.set(cacheKey, bigrams);
  return bigrams;
}

function getSetOverlapRatio(sourceValues, targetValues) {
  const source = new Set(sourceValues.filter(Boolean));
  const target = new Set(targetValues.filter(Boolean));
  if (source.size === 0 || target.size === 0) {
    return 0;
  }
  let matches = 0;
  source.forEach((value) => {
    if (target.has(value)) {
      matches += 1;
    }
  });
  return matches / Math.max(source.size, target.size);
}

function getTextSimilarity(left, right) {
  const leftBigrams = getCharacterBigrams(left);
  const rightBigrams = getCharacterBigrams(right);
  if (leftBigrams.length === 0 || rightBigrams.length === 0) {
    return 0;
  }

  const counts = new Map();
  leftBigrams.forEach((item) => counts.set(item, Number(counts.get(item) || 0) + 1));
  let matches = 0;
  rightBigrams.forEach((item) => {
    const remaining = Number(counts.get(item) || 0);
    if (remaining > 0) {
      matches += 1;
      counts.set(item, remaining - 1);
    }
  });

  return (2 * matches) / (leftBigrams.length + rightBigrams.length);
}

function buildArtworkRecommendationProfile(artwork) {
  const cacheKey = `${derivedState.revisions.artworkData}:${derivedState.revisions.accountTags}`;
  const cached = derivedState.artworkProfileCache.get(artwork?.id);
  if (cached?.key === cacheKey) {
    return cached.value;
  }

  const pixivTags = getNormalizedTagNames(artwork?.pixivTags || []);
  const pixivTagTokens = [...new Set(pixivTags.flatMap((tag) => tokenizeRecommendationText(tag)))];
  const accountTagNames = getNormalizedArtworkAccountTagNames(artwork);
  const accountTagTokens = [...new Set(accountTagNames.flatMap((tag) => tokenizeRecommendationText(tag)))];
  const titleTokens = tokenizeRecommendationText(artwork?.title || "");
  const authorTokens = tokenizeRecommendationText(artwork?.author || "");
  const combinedTokens = [...new Set([...pixivTagTokens, ...accountTagTokens, ...titleTokens, ...authorTokens])];
  const normalizedPixivTags = pixivTags.map((tag) => normalizeRecommendationText(tag));

  const profile = {
    artwork,
    pixivTags,
    normalizedPixivTags,
    normalizedPixivTagSet: new Set(normalizedPixivTags),
    pixivTagTokens,
    accountTagNames,
    accountTagTokens,
    titleTokens,
    authorTokens,
    combinedTokens
  };

  derivedState.artworkProfileCache.set(artwork?.id, { key: cacheKey, value: profile });
  return profile;
}

function buildSelectionRecommendationProfile(artworks) {
  const profiles = artworks.map((artwork) => buildArtworkRecommendationProfile(artwork));
  const pixivTags = [...new Set(profiles.flatMap((profile) => profile.pixivTags))];
  const pixivTagTokens = [...new Set(profiles.flatMap((profile) => profile.pixivTagTokens))];
  const accountTagNames = [...new Set(profiles.flatMap((profile) => profile.accountTagNames))];
  const titleTokens = [...new Set(profiles.flatMap((profile) => profile.titleTokens))];
  const authorTokens = [...new Set(profiles.flatMap((profile) => profile.authorTokens))];
  const combinedTokens = [...new Set(profiles.flatMap((profile) => profile.combinedTokens))];
  const allTextValues = [
    ...artworks.map((artwork) => artwork.title),
    ...artworks.map((artwork) => artwork.author),
    ...pixivTags
  ].filter(Boolean);

  return {
    artworks,
    profiles,
    pixivTags,
    pixivTagTokens,
    accountTagNames,
    titleTokens,
    authorTokens,
    combinedTokens,
    allTextValues
  };
}

function getArtworkSimilarityScore(sourceProfile, targetProfile) {
  const pixivTagOverlap = getSetOverlapRatio(sourceProfile.pixivTags, targetProfile.pixivTags);
  const tokenOverlap = getSetOverlapRatio(sourceProfile.combinedTokens, targetProfile.combinedTokens);
  const accountOverlap = getSetOverlapRatio(sourceProfile.accountTagNames, targetProfile.accountTagNames);
  const titleSimilarity = getTextSimilarity(sourceProfile.artwork.title, targetProfile.artwork.title);
  const authorSimilarity = getTextSimilarity(sourceProfile.artwork.author, targetProfile.artwork.author);
  return Math.min(1, (pixivTagOverlap * 0.45) + (tokenOverlap * 0.25) + (accountOverlap * 0.1) + (titleSimilarity * 0.15) + (authorSimilarity * 0.05));
}

function getRecommendationContext() {
  const selectionTargets = getSelectionTargets();
  if (selectionTargets.length > 0) {
    return {
      focusArtwork: getSelectedArtwork() || selectionTargets[0],
      selectedArtworks: selectionTargets
    };
  }

  const artwork = getSelectedArtwork();
  return artwork ? { focusArtwork: artwork, selectedArtworks: [artwork] } : { focusArtwork: null, selectedArtworks: [] };
}

function formatRecommendationReason(reason) {
  const normalizedScore = Math.max(0, Math.min(1, Number(reason?.score || 0)));
  const percent = `${Math.round(normalizedScore * 100)}%`;
  if (reason.type === "mapping") {
    return `Pixiv 태그 직접 일치 ${percent}`;
  }
  if (reason.type === "pixivTag") {
    return `학습 태그 공통 ${percent}`;
  }
  if (reason.type === "similarArtwork") {
    return `유사 작품 기반 ${percent}`;
  }
  if (reason.type === "textMatch") {
    return `글자 유사도 ${percent}`;
  }
  return reason.label || percent;
}

function getRecommendations(artworkOrArtworks) {
  const selectedArtworks = Array.isArray(artworkOrArtworks)
    ? artworkOrArtworks.filter(Boolean)
    : artworkOrArtworks
      ? [artworkOrArtworks]
      : [];
  if (selectedArtworks.length === 0) {
    return [];
  }

  const recommendationCacheKey = [
    selectedArtworks.map((artwork) => artwork.id).sort().join("|"),
    derivedState.revisions.artworkData,
    derivedState.revisions.accountTags,
    derivedState.revisions.mappings
  ].join("::");
  if (derivedState.recommendationCache.has(recommendationCacheKey)) {
    return derivedState.recommendationCache.get(recommendationCacheKey);
  }

  const selectionProfile = buildSelectionRecommendationProfile(selectedArtworks);
  const normalizedSelectionPixivTags = selectionProfile.pixivTags.map((pixivTag) => normalizeRecommendationText(pixivTag));
  const normalizedSelectionPixivTagSet = new Set(normalizedSelectionPixivTags);
  const selectedArtworkIds = new Set(selectedArtworks.map((artwork) => artwork.id));
  const fullyAssignedTagIds = new Set(
    state.accountTags
      .filter((tag) => selectedArtworks.every((artwork) => artwork.accountTagIds.includes(tag.id)))
      .map((tag) => tag.id)
  );
  const candidateScores = new Map();
  const taggedTrainingProfiles = state.artworks
    .filter((artwork) => !selectedArtworkIds.has(artwork.id) && artwork.accountTagIds.length > 0)
    .map((artwork) => buildArtworkRecommendationProfile(artwork));
  const trainingProfilesByTagId = new Map();
  taggedTrainingProfiles.forEach((profile) => {
    profile.artwork.accountTagIds.forEach((tagId) => {
      if (!trainingProfilesByTagId.has(tagId)) {
        trainingProfilesByTagId.set(tagId, []);
      }
      trainingProfilesByTagId.get(tagId).push(profile);
    });
  });
  const mappingMatchesByTagId = new Map();
  state.mappings.forEach((mapping) => {
    if (!normalizedSelectionPixivTagSet.has(normalizeRecommendationText(mapping.pixivTag))) {
      return;
    }
    mappingMatchesByTagId.set(mapping.accountTagId, Number(mappingMatchesByTagId.get(mapping.accountTagId) || 0) + 1);
  });
  const lexicalSources = [...selectionProfile.pixivTags, ...selectionProfile.allTextValues];
  const selectionCoverageByTagId = new Map();
  selectedArtworks.forEach((artwork) => {
    artwork.accountTagIds.forEach((tagId) => {
      selectionCoverageByTagId.set(tagId, Number(selectionCoverageByTagId.get(tagId) || 0) + 1);
    });
  });

  state.accountTags.forEach((tag) => {
    if (fullyAssignedTagIds.has(tag.id)) {
      return;
    }

    const tagName = String(tag.name || "").trim();
    const normalizedTagName = normalizeRecommendationText(tagName);
    const exactPixivMatches = normalizedSelectionPixivTags.filter((pixivTag) => pixivTag === normalizedTagName).length;
    const mappingMatches = Number(mappingMatchesByTagId.get(tag.id) || 0);
    const trainingProfiles = trainingProfilesByTagId.get(tag.id) || [];
    const pixivSupport = selectionProfile.pixivTags.reduce((sum, pixivTag) => {
      if (trainingProfiles.length === 0) {
        return sum;
      }
      const normalizedPixivTag = normalizeRecommendationText(pixivTag);
      const matchedCount = trainingProfiles.filter((profile) =>
        profile.normalizedPixivTagSet.has(normalizedPixivTag)
      ).length;
      return sum + (matchedCount / trainingProfiles.length);
    }, 0);
    const pixivTagScore = selectionProfile.pixivTags.length > 0 ? pixivSupport / selectionProfile.pixivTags.length : 0;

    const similarArtworkScore = trainingProfiles.length > 0
      ? selectionProfile.profiles.reduce((total, sourceProfile) => {
          const topMatches = trainingProfiles
            .map((targetProfile) => getArtworkSimilarityScore(sourceProfile, targetProfile))
            .sort((left, right) => right - left)
            .slice(0, 5);
          if (topMatches.length === 0) {
            return total;
          }
          return total + (topMatches.reduce((sum, score) => sum + score, 0) / topMatches.length);
        }, 0) / selectionProfile.profiles.length
      : 0;

    const textMatchScore = lexicalSources.length > 0
      ? Math.max(...lexicalSources.map((value) => getTextSimilarity(value, tagName)), 0)
      : 0;
    const tokenMatchScore = Math.max(
      getSetOverlapRatio(tokenizeRecommendationText(tagName), selectionProfile.pixivTagTokens),
      getSetOverlapRatio(tokenizeRecommendationText(tagName), selectionProfile.combinedTokens)
    );
    const directMatchScore = exactPixivMatches > 0 ? 1 : 0;
    const mappingScore = Math.min(1, (mappingMatches * 0.55) + (directMatchScore * 0.45));
    const score = Math.min(
      1,
      (mappingScore * 0.34) +
      (pixivTagScore * 0.28) +
      (similarArtworkScore * 0.24) +
      (Math.max(textMatchScore, tokenMatchScore) * 0.14)
    );

    if (score < 0.12) {
      return;
    }

    const reasons = [
      { type: "mapping", score: mappingScore },
      { type: "pixivTag", score: pixivTagScore },
      { type: "similarArtwork", score: similarArtworkScore },
      { type: "textMatch", score: Math.max(textMatchScore, tokenMatchScore) }
    ].filter((reason) => reason.score >= 0.18).sort((left, right) => right.score - left.score).slice(0, 2);

    candidateScores.set(tag.id, {
      tagId: tag.id,
      name: tag.name,
      probability: score,
      score,
      reasons,
      sampleSize: trainingProfiles.length,
      selectionCoverage: Number(selectionCoverageByTagId.get(tag.id) || 0)
    });
  });

  const recommendations = [...candidateScores.values()]
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (right.sampleSize !== left.sampleSize) {
        return right.sampleSize - left.sampleSize;
      }
      return left.name.localeCompare(right.name);
    })
    .slice(0, MAX_RECOMMENDATIONS);

  derivedState.recommendationCache.set(recommendationCacheKey, recommendations);
  return recommendations;
}

function getActiveBookmarkTagStat() {
  const currentSearch = state.gallerySearch.trim();
  return currentSearch ? getCurrentBookmarkTagStats().find((tag) => tag.name === currentSearch) || null : null;
}

function isUnclassifiedBookmarkTagName(tagName) {
  const normalized = String(tagName || "").trim().toLowerCase();
  return normalized === "未分類".toLowerCase() || normalized === "미분류";
}

function matchesGalleryFilter(artwork) {
  if (state.galleryFilter === "all") return true;
  if (state.galleryFilter === "unclassified") return getArtworkAccountTags(artwork).length === 0;
  if (state.galleryFilter === "issues") return getArtworkIssues(artwork).length > 0;
  return getArtworkIssues(artwork).some((issue) => issue.type === state.galleryFilter);
}

function matchesGallerySearch(artwork, context = {}) {
  const keyword = String(context.keyword ?? state.gallerySearch.trim().toLowerCase());
  if (!keyword) return true;
  if (isUnclassifiedBookmarkTagName(keyword)) {
    const selectedIds = context.selectedIds instanceof Set ? context.selectedIds : new Set(getSelectedArtworkIds());
    return getArtworkAccountTags(artwork).length === 0 || selectedIds.has(artwork.id);
  }
  const values = [artwork.title, artwork.author, ...artwork.pixivTags, ...getArtworkAccountTags(artwork).map((tag) => tag.name)];
  return values.some((value) => String(value).toLowerCase().includes(keyword));
}

function getFilteredArtworks() {
  const selectedIds = new Set(getSelectedArtworkIds());
  const searchContext = {
    keyword: state.gallerySearch.trim().toLowerCase(),
    selectedIds
  };
  return state.artworks.filter((artwork) => {
    if (selectedIds.has(artwork.id)) {
      return true;
    }
    return matchesGalleryFilter(artwork) && matchesGallerySearch(artwork, searchContext);
  });
}

function getVisibleArtworks() {
  const filtered = getFilteredArtworks();
  const totalPages = Math.max(1, Math.ceil(filtered.length / state.galleryPageSize));
  const currentPage = Math.min(state.galleryPage, totalPages);
  const startIndex = (currentPage - 1) * state.galleryPageSize;
  return filtered.slice(startIndex, startIndex + state.galleryPageSize);
}

function getVisibleArtworkIds() {
  return getVisibleArtworks().map((artwork) => artwork.sourceId).filter(Boolean);
}

function getThumbnailWorkerStatusText() {
  if (!isApiAvailable()) {
    return "\uC790\uB3D9 \uC378\uB124\uC77C\uC740 \uB85C\uCEEC \uC11C\uBC84\uC5D0\uC11C\uB9CC \uB3D9\uC791\uD569\uB2C8\uB2E4. `python -m backend.cli --config pixiv_config.json serve-ui`\uB85C \uC5F4\uC5B4\uC8FC\uC138\uC694.";
  }

  const worker = apiState.worker;
  if (!worker) {
    return "\uC790\uB3D9 \uC378\uB124\uC77C \uC900\uBE44\uB428";
  }

  const lastResult = worker.last_result || null;
  if (worker.running) {
    const roundText = worker.rounds_completed > 0 ? ` · ${worker.rounds_completed}회 처리` : "";
    return worker.mode === "repeat"
      ? `\uCC9C\uCC9C\uD788 \uACC4\uC18D \uC2E4\uD589 \uC911${roundText}. \uC0C8\uB85C \uBC1B\uC744 \uC378\uB124\uC77C\uC774 \uC5C6\uC73C\uBA74 \uC790\uB3D9\uC73C\uB85C \uBA48\uCDA5\uB2C8\uB2E4.`
      : `10개만 더 실행 중${roundText}.`;
  }

  if (worker.last_error) {
    return `실행 중 오류: ${worker.last_error}`;
  }

  if (lastResult) {
    return `마지막 실행: ${Number(lastResult.downloaded || 0).toLocaleString()}개 다운로드, ${Number(lastResult.skipped || 0).toLocaleString()}개 건너뜀.`;
  }

  return "\uC790\uB3D9 \uC378\uB124\uC77C \uC900\uBE44\uB428";
}

async function startThumbnailWorker(repeat) {
  if (!isApiAvailable()) {
    showToast("로컬 서버에 연결되지 않았습니다.");
    return;
  }

  try {
    const response = await fetch("api/thumbnail-cache/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repeat,
        limit: 10,
        sleep_seconds: 5,
        priority_artwork_ids: getVisibleArtworkIds()
      })
    });

    if (!response.ok) {
      showToast("\uC378\uB124\uC77C \uC791\uC5C5 \uC2DC\uC791\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.");
      return;
    }

    const payload = await response.json();
    apiState.worker = payload.thumbnail_worker || null;
    renderAll();
    showToast(repeat ? "천천히 계속을 시작했습니다." : "10개만 더를 시작했습니다.");
  } catch {
    showToast("\uC378\uB124\uC77C \uC791\uC5C5 \uC2DC\uC791\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.");
  }
}

async function stopThumbnailWorker() {
  if (!isApiAvailable()) {
    return;
  }

  try {
    const response = await fetch("api/thumbnail-cache/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
    if (!response.ok) {
      showToast("\uC378\uB124\uC77C \uC791\uC5C5 \uC911\uC9C0\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.");
      return;
    }

    const payload = await response.json();
    apiState.worker = payload.thumbnail_worker || null;
    renderAll();
    showToast("\uC378\uB124\uC77C \uC791\uC5C5\uC744 \uBA48\uCD94\uB3C4\uB85D \uC694\uCCAD\uD588\uC2B5\uB2C8\uB2E4.");
  } catch {
    showToast("\uC378\uB124\uC77C \uC791\uC5C5 \uC911\uC9C0\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.");
  }
}

async function refreshBookmarksFromPixiv() {
  if (!isApiAvailable()) {
    showToast("\uB85C\uCEEC \uC11C\uBC84\uC5D0 \uC5F0\uACB0\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4.");
    return;
  }
  if (apiState.refreshBusy) {
    return;
  }

  apiState.refreshBusy = true;
  const button = document.getElementById("refresh-bookmarks-button");
  if (button) {
    button.disabled = true;
    button.textContent = "\uAC31\uC2E0 \uC911...";
  }

  try {
    const response = await fetch("api/bookmarks/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ page_size: 48, cache_thumbnails_limit: 0 })
    });
    if (!response.ok) {
      throw new Error(`refresh_failed:${response.status}`);
    }

    const payload = await response.json();
    const refreshed = await refreshBundledDataFromServer();
    if (!refreshed) {
      throw new Error("refresh_bundle_failed");
    }

    showToast(`\uBD81\uB9C8\uD06C \uB370\uC774\uD130\uB97C \uB2E4\uC2DC \uAC00\uC838\uC654\uC2B5\uB2C8\uB2E4. ${Number(payload.snapshot_count || 0).toLocaleString()}\uAC1C`);
  } catch {
    showToast("\uBD81\uB9C8\uD06C \uB370\uC774\uD130 \uAC31\uC2E0\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.");
  } finally {
    apiState.refreshBusy = false;
    if (button) {
      button.disabled = false;
      button.textContent = "\uC0C8 \uBD81\uB9C8\uD06C \uAC00\uC838\uC624\uAE30";
    }
  }
}

function startApiPolling() {
  if (apiState.pollTimer || !window.location.protocol.startsWith("http")) {
    return;
  }
  fetchApiStatus();
  apiState.pollTimer = window.setInterval(fetchApiStatus, 3000);
}

function formatSyncResultLines(items, formatter) {
  if (!Array.isArray(items) || items.length === 0) {
    return "\uC544\uC9C1 \uC2E4\uD589\uD55C \uC791\uC5C5\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.";
  }
  return items.slice(0, 20).map(formatter).join("\n");
}

function setSyncActionOutput(summary, details) {
  document.getElementById("sync-action-summary").textContent = summary;
  document.getElementById("sync-action-results").textContent = details;
}

function isApplyModalOpen() {
  const modal = document.getElementById("apply-modal");
  return modal && !modal.classList.contains("is-hidden");
}

function getSelectedSourceArtworkIds() {
  return getSelectionTargets().map((artwork) => artwork.sourceId).filter(Boolean);
}

function getSyncApplySelectionIds() {
  const checkbox = document.getElementById("apply-selected-only-checkbox");
  return checkbox && checkbox.checked ? getSelectedSourceArtworkIds() : [];
}

function refreshSyncApplyUi() {
  const label = document.getElementById("apply-selected-only-label");
  const progress = document.getElementById("sync-progress-summary");
  if (!label || !progress) {
    return;
  }

  const selectedIds = getSelectedSourceArtworkIds();
  label.textContent = selectedIds.length > 0
    ? `\uC120\uD0DD \uC791\uD488\uB9CC \uC801\uC6A9 (\uD604\uC7AC ${selectedIds.length.toLocaleString()}\uAC1C)`
    : "\uC120\uD0DD \uC791\uD488\uB9CC \uC801\uC6A9";

  const worker = apiState.syncApplyWorker || null;
  if (!worker) {
    progress.textContent = "\uC544\uC9C1 \uC801\uC6A9 \uC791\uC5C5\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.";
    return;
  }

  const base = `\uC131\uACF5 ${Number(worker.updated_count || 0).toLocaleString()}\uAC74 \u00B7 \uAC74\uB108\uB700 ${Number(worker.skipped_count || 0).toLocaleString()}\uAC74 \u00B7 \uC2E4\uD328 ${Number(worker.failed_count || 0).toLocaleString()}\uAC74`;
  if (worker.running) {
    const currentTitle = worker.current_action?.title ? ` \u00B7 \uD604\uC7AC ${worker.current_action.title}` : "";
    progress.textContent = `\uC9C4\uD589 ${Number(worker.completed_actions || 0).toLocaleString()} / ${Number(worker.total_actions || 0).toLocaleString()} \u00B7 ${base}${currentTitle}`;
    if (isApplyModalOpen()) {
      setSyncActionOutput(
        `\uC2E4\uC81C \uC801\uC6A9 \uC791\uC5C5 \uC2E4\uD589 \uC911 \u00B7 \uB85C\uADF8 ${worker.log_path || "data/sync_apply_log.json"}`,
        formatSyncResultLines(worker.results, (item) => `- ${item.title} [${item.artwork_id}] ${item.status} -> ${(item.tags_to_apply || []).join(", ")}`)
      );
    }
    return;
  }

  if (Number(worker.total_actions || 0) > 0 || (worker.results || []).length > 0) {
    progress.textContent = `\uC644\uB8CC ${Number(worker.completed_actions || 0).toLocaleString()} / ${Number(worker.total_actions || 0).toLocaleString()} \u00B7 ${base}`;
    if (isApplyModalOpen()) {
      setSyncActionOutput(
        `\uC2E4\uC81C \uC801\uC6A9 \uC791\uC5C5 \uC644\uB8CC \u00B7 \uB85C\uADF8 ${worker.log_path || "data/sync_apply_log.json"}`,
        formatSyncResultLines(worker.results, (item) => `- ${item.title} [${item.artwork_id}] ${item.status} -> ${(item.tags_to_apply || []).join(", ")}`)
      );
    }
    return;
  }

  progress.textContent = "\uC544\uC9C1 \uC801\uC6A9 \uC791\uC5C5\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.";
}

function renderApplyModalActions() {
  const worker = apiState.syncApplyWorker || null;
  const isRunning = Boolean(worker?.running);
  const disabled = !isApiAvailable() || apiState.syncBusy || isRunning;
  document.getElementById("save-sync-plan-button").disabled = disabled;
  document.getElementById("run-sync-preview-button").disabled = disabled;
  document.getElementById("run-sync-apply-button").disabled = disabled;
  document.getElementById("stop-sync-apply-button").disabled = !isApiAvailable() || !isRunning;
  document.getElementById("apply-selected-only-checkbox").disabled = apiState.syncBusy || isRunning;
  refreshSyncApplyUi();
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(`request_failed:${response.status}`);
  }
  return response.json();
}

async function saveSyncPlanToServer() {
  if (!isApiAvailable()) {
    showToast("\uB85C\uCEEC \uC11C\uBC84\uC5D0 \uC5F0\uACB0\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4.");
    return null;
  }

  apiState.syncBusy = true;
  renderApplyModalActions();
  try {
    const plan = buildSyncPlan();
    const payload = await postJson("api/sync-plan/save", { plan });
    document.getElementById("sync-plan-path").textContent = payload.path || "data/tag_sync_plan.json";
    document.getElementById("sync-plan-summary").textContent = `\uB9E4\uD551 ${payload.counts.mappings}\uAC1C, \uCE58\uD658 ${payload.counts.replace_rules}\uAC1C, \uC218\uB3D9 \uBCC0\uACBD ${payload.counts.manual_overrides}\uAC1C`;
    setSyncActionOutput("\uB3D9\uAE30\uD654 \uACC4\uD68D\uC744 \uC800\uC7A5\uD588\uC2B5\uB2C8\uB2E4.", JSON.stringify(plan, null, 2));
    showToast("\uB3D9\uAE30\uD654 \uACC4\uD68D\uC744 \uC800\uC7A5\uD588\uC2B5\uB2C8\uB2E4.");
    return payload;
  } catch {
    setSyncActionOutput("\uB3D9\uAE30\uD654 \uACC4\uD68D \uC800\uC7A5\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.", "\uB85C\uCEEC \uC11C\uBC84 \uC0C1\uD0DC\uC640 \uD30C\uC77C \uC4F0\uAE30 \uAD8C\uD55C\uC744 \uD655\uC778\uD558\uC138\uC694.");
    showToast("\uB3D9\uAE30\uD654 \uACC4\uD68D \uC800\uC7A5\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.");
    return null;
  } finally {
    apiState.syncBusy = false;
    renderApplyModalActions();
  }
}

async function runSyncPreview() {
  if (!isApiAvailable()) {
    showToast("\uB85C\uCEEC \uC11C\uBC84\uC5D0 \uC5F0\uACB0\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4.");
    return;
  }

  apiState.syncBusy = true;
  renderApplyModalActions();
  try {
    const selectedArtworkIds = getSyncApplySelectionIds();
    const payload = await postJson("api/sync/preview", {
      plan: buildSyncPlan(),
      limit: 20,
      selected_artwork_ids: selectedArtworkIds
    });
    document.getElementById("sync-plan-path").textContent = payload.path || "data/tag_sync_plan.json";
    document.getElementById("sync-plan-summary").textContent = `\uB9E4\uD551 ${payload.counts.mappings}\uAC1C, \uCE58\uD658 ${payload.counts.replace_rules}\uAC1C, \uC218\uB3D9 \uBCC0\uACBD ${payload.counts.manual_overrides}\uAC1C`;
    setSyncActionOutput(
      `\uBBF8\uB9AC\uBCF4\uAE30 ${payload.total_actions.toLocaleString()}\uAC74 \uC911 \uCD5C\uB300 20\uAC74\uC744 \uD45C\uC2DC\uD569\uB2C8\uB2E4.`,
      formatSyncResultLines(payload.actions, (item) => `- ${item.title} [${item.artwork_id}] -> ${(item.merged_tags || []).join(", ")}`)
    );
    showToast("\uBBF8\uB9AC\uBCF4\uAE30\uB97C \uC2E4\uD589\uD588\uC2B5\uB2C8\uB2E4.");
  } catch {
    setSyncActionOutput("\uBBF8\uB9AC\uBCF4\uAE30\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.", "Pixiv \uC138\uC158\uACFC \uB85C\uCEEC \uC11C\uBC84 \uC0C1\uD0DC\uB97C \uD655\uC778\uD558\uC138\uC694.");
    showToast("\uBBF8\uB9AC\uBCF4\uAE30\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.");
  } finally {
    apiState.syncBusy = false;
    renderApplyModalActions();
  }
}

async function runSyncApply() {
  if (!isApiAvailable()) {
    showToast("\uB85C\uCEEC \uC11C\uBC84\uC5D0 \uC5F0\uACB0\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4.");
    return;
  }

  apiState.syncBusy = true;
  renderApplyModalActions();
  try {
    const selectedArtworkIds = getSyncApplySelectionIds();
    if (document.getElementById("apply-selected-only-checkbox").checked && selectedArtworkIds.length === 0) {
      showToast("\uC120\uD0DD\uB41C \uC791\uD488\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.");
      return;
    }
    const payload = await postJson("api/sync/apply/start", {
      plan: buildSyncPlan(),
      batch_size: 10,
      interval_seconds: 2,
      selected_artwork_ids: selectedArtworkIds
    });
    apiState.syncApplyWorker = payload.sync_apply_worker || null;
    refreshSyncApplyUi();
    setSyncActionOutput(
      "\uC2E4\uC81C \uC801\uC6A9 \uC791\uC5C5\uC744 \uC2DC\uC791\uD588\uC2B5\uB2C8\uB2E4.",
      formatSyncResultLines(apiState.syncApplyWorker?.results || [], (item) => `- ${item.title} [${item.artwork_id}] ${item.status}`)
    );
    showToast("\uC2E4\uC81C \uC801\uC6A9 10\uAC1C\uB97C 1\uAC1C\uC529 \uC2DC\uC791\uD588\uC2B5\uB2C8\uB2E4.");
  } catch {
    setSyncActionOutput("\uC2E4\uC81C \uC801\uC6A9\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.", "Pixiv \uC138\uC158\uACFC \uB85C\uCEEC \uC11C\uBC84 \uC0C1\uD0DC\uB97C \uD655\uC778\uD558\uC138\uC694.");
    showToast("\uC2E4\uC81C \uC801\uC6A9\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.");
  } finally {
    apiState.syncBusy = false;
    renderApplyModalActions();
  }
}

async function stopSyncApply() {
  if (!isApiAvailable()) {
    return;
  }
  apiState.syncBusy = true;
  renderApplyModalActions();
  try {
    const payload = await postJson("api/sync/apply/stop", {});
    apiState.syncApplyWorker = payload.sync_apply_worker || null;
    refreshSyncApplyUi();
    showToast("\uC801\uC6A9 \uC791\uC5C5 \uC911\uC9C0\uB97C \uC694\uCCAD\uD588\uC2B5\uB2C8\uB2E4.");
  } catch {
    showToast("\uC801\uC6A9 \uC791\uC5C5 \uC911\uC9C0\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.");
  } finally {
    apiState.syncBusy = false;
    renderApplyModalActions();
  }
}

function toggleDeletedArtworkSelection(artworkId) {
  const current = new Set(getSelectedDeletedArtworkIds());
  if (current.has(artworkId)) {
    current.delete(artworkId);
  } else {
    current.add(artworkId);
  }
  state.selectedDeletedArtworkIds = [...current];
  renderDeletedBookmarkPanel();
  saveState();
}

function selectAllDeletedArtworks() {
  state.selectedDeletedArtworkIds = getDeletedArtworks().map((artwork) => artwork.id);
  renderDeletedBookmarkPanel();
  saveState();
}

function clearDeletedArtworkSelection() {
  state.selectedDeletedArtworkIds = [];
  renderDeletedBookmarkPanel();
  saveState();
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function removeBookmarksForArtworks(artworkIds) {
  const targets = state.artworks.filter((item) => artworkIds.includes(item.id) && item.bookmarkId);
  if (targets.length === 0) {
    showToast("해제할 북마크가 없습니다.");
    return;
  }
  if (!isApiAvailable()) {
    showToast("로컬 서버에 연결되지 않았습니다.");
    return;
  }

  const isSingle = targets.length === 1;
  const label = isSingle ? `삭제된 작품 "${targets[0].title}" 북마크를 해제할까요?` : `삭제된 작품 ${targets.length}개의 북마크를 해제할까요?`;
  if (!window.confirm(label)) {
    return;
  }

  const batchSize = isSingle ? 1 : 10;
  const intervalMs = isSingle ? 0 : 2000;
  apiState.deletedRemoval = {
    running: true,
    total: targets.length,
    completed: 0,
    failed: 0
  };
  renderDeletedBookmarkPanel();

  try {
    const removedArtworkIds = new Set();
    let completed = 0;
    let failed = 0;
    for (let index = 0; index < targets.length; index += batchSize) {
      const batch = targets.slice(index, index + batchSize);
      const payload = await postJson("api/bookmarks/remove", {
        bookmark_ids: batch.map((artwork) => artwork.bookmarkId),
        artworks: batch.map((artwork) => ({ artwork_id: artwork.sourceId, bookmark_id: artwork.bookmarkId }))
      });
      const removedIds = new Set((payload.removed_bookmark_ids || []).map((bookmarkId) => {
        const artwork = batch.find((item) => item.bookmarkId === bookmarkId);
        return artwork?.id || "";
      }).filter(Boolean));
      batch.forEach((artwork) => {
        if (removedIds.has(artwork.id)) {
          removedArtworkIds.add(artwork.id);
        } else {
          failed += 1;
        }
      });
      completed += batch.length;
      apiState.deletedRemoval = {
        running: index + batchSize < targets.length,
        total: targets.length,
        completed,
        failed
      };
      renderDeletedBookmarkPanel();
      if (index + batchSize < targets.length && intervalMs > 0) {
        await delay(intervalMs);
      }
    }
    if (removedArtworkIds.size === 0) {
      throw new Error("bookmark-remove-empty");
    }
    const removedSourceIds = state.artworks.filter((item) => removedArtworkIds.has(item.id)).map((item) => item.sourceId).filter(Boolean);
    state.artworks = state.artworks.filter((item) => !removedArtworkIds.has(item.id));
    state.selectedArtworkIds = state.selectedArtworkIds.filter((id) => !removedArtworkIds.has(id));
    state.selectedDeletedArtworkIds = state.selectedDeletedArtworkIds.filter((id) => !removedArtworkIds.has(id));
    if (state.selectedArtworkId && removedArtworkIds.has(state.selectedArtworkId)) {
      state.selectedArtworkId = state.selectedArtworkIds[0] || state.artworks[0]?.id || "";
    }
    removedSourceIds.forEach((sourceId) => delete state.artworkOverrides[sourceId]);
    invalidateArtworkDerivedData();
    apiState.deletedRemoval = {
      running: false,
      total: targets.length,
      completed: targets.length,
      failed: targets.length - removedArtworkIds.size
    };
    renderAll();
    showToast(isSingle ? "북마크를 해제했습니다." : `${removedArtworkIds.size}개 북마크를 천천히 해제했습니다.`);
  } catch (error) {
    console.error(error);
    apiState.deletedRemoval = {
      ...apiState.deletedRemoval,
      running: false
    };
    renderDeletedBookmarkPanel();
    showToast("북마크 해제에 실패했습니다.");
  }
}

function renderHeaderStatus() {
  const title = document.getElementById("session-status-title");
  const text = document.getElementById("session-status-text");
  const dot = document.getElementById("session-status-dot");
  const checkButton = document.getElementById("session-check-button");
  const session = apiState.session;

  let nextTitle = "로그인 상태";
  let nextText = "Pixiv 연결 준비됨";
  let dotClass = "status-dot";

  if (!apiState.available) {
    nextTitle = "로컬 서버 연결 필요";
    nextText = "launch_pixivbm.py로 서버를 켠 뒤 세션을 확인하세요.";
    dotClass = "status-dot is-warning";
  } else if (session.loading) {
    nextTitle = "Pixiv 세션 확인 중";
    nextText = "쿠키 설정으로 현재 로그인 상태를 점검하고 있습니다.";
    dotClass = "status-dot is-warning";
  } else if (session.authenticated) {
    const profileName = String(session.profile?.name || "Pixiv 계정");
    const profileUserId = String(session.profile?.user_id || session.configuredUserId || "");
    nextTitle = "Pixiv 로그인됨";
    nextText = `${profileName}${profileUserId ? ` / ID ${profileUserId}` : ""} / ${getAuthSourceLabel(session.authSource, session.authValue)}`;
    dotClass = "status-dot is-success";
  } else if (session.checked) {
    nextTitle = "Pixiv 로그인 필요";
    nextText = session.error || `${getAuthSourceLabel(session.authSource, session.authValue)} 설정을 확인하세요.`;
    dotClass = "status-dot is-error";
  } else if (state.snapshotInfo?.source === "pixiv") {
    nextTitle = "Pixiv 데이터 로드됨";
    nextText = `${state.snapshotInfo.count.toLocaleString()}개 작품 불러옴 ? 세션 확인 버튼으로 로그인 상태를 점검할 수 있습니다.`;
    dotClass = "status-dot is-warning";
  }

  title.textContent = nextTitle;
  text.textContent = nextText;
  if (dot) {
    dot.className = dotClass;
  }
  if (checkButton instanceof HTMLButtonElement) {
    checkButton.disabled = !apiState.available || session.loading;
  }
}

function formatBookmarkTagCounts(tag) {
  const publicCount = Number(tag.public_count || 0);
  const privateCount = Number(tag.private_count || 0);
  return `(${publicCount.toLocaleString()} + ${privateCount.toLocaleString()})`;
}

function renderPixivBookmarkTagList() {
  const container = document.getElementById("pixiv-bookmark-tag-list");
  const status = document.getElementById("bookmark-search-status");
  const tagStats = getCurrentBookmarkTagStats();
  const currentSearch = state.gallerySearch.trim();

  if (tagStats.length === 0) {
    container.innerHTML = '<div class="empty-state">Pixiv 북마크 태그를 아직 불러오지 않았습니다.</div>';
    status.innerHTML = '<strong>태그 탐색 상태</strong><p>왼쪽 목록이 비어 있습니다.</p>';
    return;
  }

  const totalPublicCount = state.artworks.filter((artwork) => artwork.visibility !== "private").length;
  const totalPrivateCount = state.artworks.filter((artwork) => artwork.visibility === "private").length;
  const items = [{ name: "전체", public_count: totalPublicCount, private_count: totalPrivateCount, isAll: true }, ...tagStats];
  container.innerHTML = items.map((tag) => {
    const active = (tag.isAll && !currentSearch) || (!tag.isAll && currentSearch === tag.name);
    const searchAction = tag.isAll || active ? "clear-pixiv-bookmark-tag-search" : "search-pixiv-bookmark-tag";
    return `<div class="pixiv-tag-entry ${active ? "is-active" : ""}"><button class="pixiv-tag-item pixiv-tag-search-button ${active ? "is-active" : ""}" type="button" data-action="${searchAction}" data-tag-name="${tag.name}" ${tag.isAll ? "" : `data-delete-tag-name="${tag.name}"`}><strong>${getDisplayTagName(tag.name)}</strong></button><button class="pixiv-tag-add-button" type="button" data-action="${tag.isAll ? "clear-pixiv-bookmark-tag-search" : "add-account-tag-from-pixiv-tag"}" data-tag-name="${tag.name}"><span>${formatBookmarkTagCounts(tag)}</span></button></div>`;
  }).join("");

  const activeTag = getActiveBookmarkTagStat();
  status.innerHTML = activeTag
    ? `<strong>현재 탐색 태그</strong><p><span class="label-pixiv">${getDisplayTagName(activeTag.name)}</span> 기준으로 중앙 결과를 좁혀 보고 있습니다.</p>`
    : '<strong>\uC804\uCCB4 \uBCF4\uAE30</strong><p>\uC67C\uCABD Pixiv \uD0DC\uADF8\uB97C \uB204\uB974\uBA74 \uC911\uC559 \uAC80\uC0C9\uC774 \uBC14\uB85C \uBC14\uB01D\uB2D9\uB2C8\uB2E4.</p>';
}

function getAccountTagUsageCounts() {
  const revisionKey = `${derivedState.revisions.artworkData}:${derivedState.revisions.accountTags}`;
  if (derivedState.accountTagUsageCounts.revision === revisionKey) {
    return derivedState.accountTagUsageCounts.value;
  }

  const usageCounts = {};
  state.artworks.forEach((artwork) => {
    artwork.accountTagIds.forEach((tagId) => {
      usageCounts[tagId] = Number(usageCounts[tagId] || 0) + 1;
    });
  });

  derivedState.accountTagUsageCounts = {
    revision: revisionKey,
    value: usageCounts
  };

  return usageCounts;
}

function renderAccountTags() {
  const container = document.getElementById("account-tag-list");
  if (state.accountTags.length === 0) {
    container.innerHTML = '<div class="empty-state">등록된 계정 태그가 없습니다.</div>';
    return;
  }

  const usageCounts = getAccountTagUsageCounts();

  container.innerHTML = state.accountTags.map((tag) => {
    const usage = Number(usageCounts[tag.id] || 0);
    return `<article class="tag-item"><div class="tag-item-header"><div><strong>${tag.name}</strong><div class="tag-meta">사용 작품 ${usage}개</div></div><div class="item-actions"><button class="ghost-button mini-button" type="button" data-action="delete-tag" data-tag-id="${tag.id}">삭제</button></div></div><p>${tag.note || "메모 없음"}</p></article>`;
  }).join("");
}

function renderGallery() {
  const searchInput = document.getElementById("gallery-search-input");
  const pageSizeSelect = document.getElementById("gallery-page-size-select");
  const filters = document.getElementById("gallery-filters");
  const summary = document.getElementById("gallery-summary");
  const grid = document.getElementById("gallery-grid");
  const pagination = document.getElementById("gallery-pagination");
  const topPagination = document.getElementById("gallery-top-pagination");
  const quickSummary = document.getElementById("selection-quick-summary");
  const quickSelectionCount = document.getElementById("quick-selection-count");
  const quickSelectionContext = document.getElementById("quick-selection-context");
  const selectedIds = new Set(getSelectedArtworkIds());
  const filtered = getFilteredArtworks();
  const activeTag = getActiveBookmarkTagStat();
  const worker = apiState.worker || null;
  const cachedThumbnailCount = state.artworks.filter((artwork) => artwork.localThumbnailUrl).length;

  searchInput.value = state.gallerySearch;
  pageSizeSelect.value = String(state.galleryPageSize);

  filters.innerHTML = [
    { id: "all", label: "전체" },
    { id: "unclassified", label: "미분류" },
    { id: "issues", label: "문제 작품" },
    { id: "private", label: "비공개" },
    { id: "deleted", label: "삭제" }
  ].map((filter) => `<button class="filter-button ${state.galleryFilter === filter.id ? "is-active" : ""}" type="button" data-action="set-gallery-filter" data-filter-id="${filter.id}">${filter.label}</button>`).join("");

  quickSelectionCount.textContent = `${selectedIds.size.toLocaleString()}개`;
  quickSelectionContext.textContent = activeTag ? activeTag.name : (state.gallerySearch.trim() ? `"${state.gallerySearch.trim()}" 검색` : "전체 보기");
  quickSummary.textContent = selectedIds.size > 0 ? "선택된 작품에 계정 태그를 바로 추가하거나 기존 태그를 새 태그로 바꿉니다." : "왼쪽 태그나 검색으로 작품을 모은 뒤 체크 또는 전체 선택을 먼저 해주세요.";
  document.getElementById("thumbnail-cache-summary").textContent = `\uD604\uC7AC ${cachedThumbnailCount.toLocaleString()}\uAC1C / ${state.artworks.length.toLocaleString()}\uAC1C \uC378\uB124\uC77C\uC774 \uB85C\uCEEC\uC5D0 \uCE90\uC2DC\uB418\uC5B4 \uC788\uC2B5\uB2C8\uB2E4.`;
  document.getElementById("thumbnail-worker-status").textContent = getThumbnailWorkerStatusText();
  const repeatButton = document.getElementById("thumbnail-repeat-button");
  const onceButton = document.getElementById("thumbnail-once-button");
  repeatButton.textContent = worker?.running && worker.mode === "repeat" ? "천천히 계속 중지" : "천천히 계속";
  repeatButton.disabled = !isApiAvailable();
  onceButton.textContent = "10개만 더";
  onceButton.disabled = !isApiAvailable() || Boolean(worker?.running);

  const sortedAccountTags = getAccountTagsSortedByPixivOrder();
  const optionValues = sortedAccountTags.map((tag) => tag.id);
  const options = sortedAccountTags.map((tag) => `<option value="${tag.id}">${tag.name}</option>`).join("") || '<option value="">계정 태그 없음</option>';
  ["quick-add-tag-select", "quick-replace-source-select", "account-tag-select", "assign-tag-select", "replace-source-tag-select", "replace-target-tag-select"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    const previousValue = el.value;
    el.innerHTML = options;
    if (optionValues.includes(previousValue)) {
      el.value = previousValue;
    }
  });

  const quickReplaceTargetSelect = document.getElementById("quick-replace-target-select");
  if (quickReplaceTargetSelect) {
    const previousValue = quickReplaceTargetSelect.value;
    quickReplaceTargetSelect.innerHTML = `${options}<option value="${QUICK_REPLACE_DELETE_VALUE}">지우기</option>`;
    if (optionValues.includes(previousValue) || previousValue === QUICK_REPLACE_DELETE_VALUE) {
      quickReplaceTargetSelect.value = previousValue;
    }
  }

  const totalPages = Math.max(1, Math.ceil(filtered.length / state.galleryPageSize));
  state.galleryPage = Math.min(state.galleryPage, totalPages);
  const startIndex = (state.galleryPage - 1) * state.galleryPageSize;
  const visible = filtered.slice(startIndex, startIndex + state.galleryPageSize);

  summary.textContent = filtered.length > 0
    ? `${filtered.length.toLocaleString()}개 결과 중 ${startIndex + 1}-${Math.min(filtered.length, startIndex + visible.length)} 표시 · 선택 ${selectedIds.size.toLocaleString()}개`
    : `0개 결과 · 선택 ${selectedIds.size.toLocaleString()}개`;

  if (visible.length === 0) {
    grid.innerHTML = '<div class="empty-state">현재 필터에 맞는 작품이 없습니다.</div>';
    pagination.innerHTML = "";
    topPagination.innerHTML = "";
    return;
  }

  grid.innerHTML = visible.map((artwork) => {
    const checked = selectedIds.has(artwork.id);
    const thumb = artwork.localThumbnailUrl ? `<img src="${artwork.localThumbnailUrl}" alt="${artwork.title}">` : `<div class="art-thumb-fallback">${artwork.title}</div>`;
    const accountTags = getArtworkAccountTags(artwork);
    const pixivUrl = getArtworkPixivUrl(artwork);
    return `<article class="art-card ${artwork.id === state.selectedArtworkId ? "active-card" : ""} ${checked ? "is-checked" : ""}" data-action="toggle-artwork-selection" data-artwork-id="${artwork.id}"><button class="art-check ${checked ? "is-checked" : ""}" type="button" data-action="toggle-artwork-selection" data-artwork-id="${artwork.id}" aria-label="${escapeHtml(artwork.title)} 선택"><span>${checked ? "✓" : ""}</span></button><div class="art-thumb">${thumb}</div><div class="art-body"><h3><span class="art-title-text">${escapeHtml(artwork.title)}</span><a class="art-title-link art-inline-link" href="${pixivUrl}" target="_blank" rel="noreferrer noopener" aria-label="${escapeHtml(artwork.title)} Pixiv에서 열기">🔗</a></h3><div class="work-meta">작가 ${escapeHtml(artwork.author)} · 좋아요 ${artwork.likes.toLocaleString()} · ${escapeHtml(getArtworkStatusLabel(artwork))}</div><div class="chip-row">${(accountTags.length > 0 ? accountTags : [{ name: "태그 없음" }]).map((tag) => `<span class="chip">${escapeHtml(tag.name)}</span>`).join("")}</div></div></article>`;
  }).join("");

  renderPaginationRow(pagination, state.galleryPage, totalPages);
  renderPaginationRow(topPagination, state.galleryPage, totalPages);
}

function jumpGalleryPage(pageNumber) {
  const totalPages = Math.max(1, Math.ceil(getFilteredArtworks().length / state.galleryPageSize));
  const nextPage = Math.min(Math.max(pageNumber, 1), totalPages);
  if (!Number.isFinite(nextPage) || nextPage === state.galleryPage) {
    return;
  }
  uiState.galleryPageJumpDraft = "";
  state.galleryPage = nextPage;
  renderGalleryPanels();
}

function renderSelectedWork() {
  const container = document.getElementById("selected-work");
  const { focusArtwork, selectedArtworks } = getRecommendationContext();
  if (!focusArtwork) {
    container.innerHTML = '<div class="empty-state">작품을 선택하면 태그 작업을 시작할 수 있습니다.</div>';
    return;
  }
  const visibleTags = selectedArtworks.length > 1 ? getCommonAccountTags(selectedArtworks) : getArtworkAccountTags(focusArtwork);
  const recs = getRecommendations(selectedArtworks);
  const issues = selectedArtworks.length > 1
    ? [...new Set(selectedArtworks.flatMap((artwork) => getArtworkIssues(artwork).map((issue) => issue.label)))]
    : getArtworkIssues(focusArtwork).map((issue) => issue.label);
  container.innerHTML = `<section class="selected-box"><strong>${selectedArtworks.length > 1 ? `선택된 작품 ${selectedArtworks.length}개` : "선택된 작품"}</strong><h3>${focusArtwork.title}</h3><p class="work-meta">작가 ${focusArtwork.author} · 좋아요 ${focusArtwork.likes.toLocaleString()} · ${getArtworkStatusLabel(focusArtwork)}</p></section><section class="selected-box"><strong>${selectedArtworks.length > 1 ? "선택 작품 Pixiv 태그 묶음" : "Pixiv 태그"}</strong><div class="chip-row">${[...new Set(selectedArtworks.flatMap((artwork) => artwork.pixivTags))].map((tag) => `<button class="chip chip-button" type="button" data-action="search-gallery-keyword" data-tag-name="${tag}">${tag}</button>`).join("") || '<span class="chip">없음</span>'}</div></section><section class="selected-box"><strong>${selectedArtworks.length > 1 ? "공통 계정 태그" : "계정 태그"}</strong><div class="chip-row">${visibleTags.map((tag) => `<button class="ghost-button mini-button" type="button" data-action="remove-account-tag" data-tag-id="${tag.id}">${tag.name} 삭제</button>`).join("") || '<span class="chip">없음</span>'}</div></section><section class="selected-box"><strong>추천 요약</strong><div class="chip-row">${recs.map((item) => `<button class="chip chip-button" type="button" data-action="apply-recommendation" data-tag-id="${item.tagId}">${item.name} ${Math.round(item.probability * 100)}%</button>`).join("") || '<span class="chip">추천 없음</span>'}</div><div class="recommendation-summary-list">${recs.map((item) => `<p><strong>${item.name}</strong> · ${item.sampleSize.toLocaleString()}개 학습작품 · ${item.reasons.map((reason) => formatRecommendationReason(reason)).join(" / ") || "유사 작품 기반 점수"}</p>`).join("") || '<p>선택 작품과 비슷한 태그 패턴을 아직 찾지 못했습니다.</p>'}</div></section><section class="selected-box"><strong>문제 작품 감지</strong><div class="chip-row">${issues.map((label) => `<span class="chip issue-chip">${label}</span>`).join("") || '<span class="chip">문제 없음</span>'}</div></section>`;
}

function renderMappingPanel() {
  const artwork = getSelectedArtwork();
  const list = document.getElementById("mapping-list");
  const pixivSelect = document.getElementById("pixiv-tag-select");
  const pixivInput = document.getElementById("pixiv-tag-input");
  pixivInput.placeholder = artwork ? `현재 작품 태그 예: ${artwork.pixivTags[0] || ""}` : "Pixiv 태그 직접 입력";
  pixivSelect.innerHTML = artwork && artwork.pixivTags.length > 0 ? artwork.pixivTags.map((tag) => `<option value="${tag}">${tag}</option>`).join("") : '<option value="">선택된 작품 태그 없음</option>';
  list.innerHTML = state.mappings.length > 0 ? state.mappings.map((mapping) => `<div class="mapping-item"><div class="mapping-copy"><strong>${mapping.pixivTag} -> ${getAccountTagById(mapping.accountTagId)?.name || "삭제된 태그"}</strong></div><button class="ghost-button mini-button" type="button" data-action="delete-mapping" data-mapping-id="${mapping.id}">삭제</button></div>`).join("") : '<div class="empty-state">등록된 매핑이 없습니다.</div>';
}

function renderAssignPanel() {
  const list = document.getElementById("selected-account-tags");
  const artwork = getSelectedArtwork();
  const selected = getSelectionTargets();
  if (!artwork) {
    list.innerHTML = '<div class="empty-state">작품을 선택하면 계정 태그를 붙일 수 있습니다.</div>';
    return;
  }
  const tags = selected.length > 1 ? getCommonAccountTags(selected) : getArtworkAccountTags(artwork);
  list.innerHTML = tags.length > 0 ? tags.map((tag) => `<div class="mapping-item"><div class="mapping-copy"><strong>${tag.name}</strong><p>${tag.note || "설명 없음"}</p></div><button class="ghost-button mini-button" type="button" data-action="remove-account-tag" data-tag-id="${tag.id}">제거</button></div>`).join("") : '<div class="empty-state">현재 붙은 계정 태그가 없습니다.</div>';
}

function renderReplaceRulePanel() {
  const list = document.getElementById("replace-rule-list");
  list.innerHTML = state.replaceRules.length > 0 ? state.replaceRules.map((rule) => `<div class="mapping-item"><div class="mapping-copy"><strong>${rule.sourceTagName} -> ${getAccountTagById(rule.targetTagId)?.name || "삭제된 태그"}</strong></div><button class="ghost-button mini-button" type="button" data-action="delete-replace-rule" data-replace-rule-id="${rule.id}">삭제</button></div>`).join("") : '<div class="empty-state">등록된 치환 규칙이 없습니다.</div>';
}

function renderRecommendations() {
  const { focusArtwork, selectedArtworks } = getRecommendationContext();
  const container = document.getElementById("recommendation-list");
  if (!focusArtwork) {
    container.innerHTML = '<div class="empty-state">작품을 선택하면 추천 태그를 계산합니다.</div>';
    return;
  }
  const recs = getRecommendations(selectedArtworks);
  container.innerHTML = recs.length > 0
    ? recs.map((item) => `<div class="recommendation-item"><div class="mapping-copy"><strong>${item.name}</strong><p>추천 확률 ${Math.round(item.probability * 100)}% · 학습 작품 ${item.sampleSize.toLocaleString()}개</p><p>${item.reasons.map((reason) => formatRecommendationReason(reason)).join(" / ") || "유사 작품 패턴을 바탕으로 계산"}</p></div><button class="ghost-button mini-button" type="button" data-action="apply-recommendation" data-tag-id="${item.tagId}">적용</button></div>`).join("")
    : '<div class="empty-state">추천 태그가 없습니다.</div>';
}

function renderDeletedBookmarkPanel() {
  const list = document.getElementById("deleted-bookmark-list");
  const status = document.getElementById("deleted-bookmark-status");
  const removeButton = document.getElementById("remove-selected-deleted-button");
  const selectAllButton = document.getElementById("select-all-deleted-button");
  const clearButton = document.getElementById("clear-deleted-selection-button");
  if (!list || !status) {
    return;
  }

  const deletedArtworks = getDeletedArtworks();
  const selectedIds = new Set(getSelectedDeletedArtworkIds());
  const removal = apiState.deletedRemoval || { running: false, total: 0, completed: 0, failed: 0 };
  if (removeButton) {
    removeButton.disabled = removal.running || selectedIds.size === 0 || !isApiAvailable();
  }
  if (selectAllButton) {
    selectAllButton.disabled = removal.running || deletedArtworks.length === 0;
  }
  if (clearButton) {
    clearButton.disabled = removal.running || selectedIds.size === 0;
  }

  status.textContent = removal.running
    ? `천천히 해제 중 ${removal.completed} / ${removal.total} · 실패 ${removal.failed}`
    : (deletedArtworks.length > 0
      ? `${selectedIds.size}개 선택 / 삭제 작품 ${deletedArtworks.length}개`
      : "삭제된 작품 북마크가 없습니다.");

  list.innerHTML = deletedArtworks.length > 0 ? deletedArtworks.map((artwork) => `
    <div class="issue-item align-start selectable-item">
      <input class="selection-checkbox" type="checkbox" data-action="toggle-deleted-artwork-selection" data-artwork-id="${artwork.id}" ${selectedIds.has(artwork.id) ? "checked" : ""}>
      <div class="mapping-copy">
        <strong>${artwork.title}</strong>
        <p>${artwork.author}</p>
      </div>
      <div class="item-actions">
        <button class="ghost-button mini-button" type="button" data-action="focus-artwork" data-artwork-id="${artwork.id}">보기</button>
        <button class="ghost-button mini-button" type="button" data-action="remove-bookmark" data-artwork-id="${artwork.id}">북마크 해제</button>
      </div>
    </div>
  `).join("") : '<div class="empty-state">삭제된 작품 북마크가 없습니다.</div>';
}

function renderIssueList() {
  const container = document.getElementById("issue-list");
  const issues = getIssueArtworks().filter(({ artwork, issues: artworkIssues }) => !artwork.isDeleted || artworkIssues.some((item) => item.type !== "deleted"));
  container.innerHTML = issues.length > 0 ? issues.map(({ artwork, issues: artworkIssues }) => {
    return `<div class="issue-item align-start"><div class="mapping-copy"><strong>${artwork.title}</strong><p>${artworkIssues.map((item) => item.label).join(" · ")}</p></div><div class="item-actions"><button class="ghost-button mini-button" type="button" data-action="focus-artwork" data-artwork-id="${artwork.id}">보기</button></div></div>`;
  }).join("") : '<div class="empty-state">문제 작품이 없습니다.</div>';
}

function buildSyncPlan() {
  return {
    generated_at: new Date().toISOString(),
    snapshot_fetched_at: state.snapshotInfo?.fetchedAt || "",
    mappings: state.mappings.map((mapping) => ({ pixiv_tag: mapping.pixivTag, account_tag: getAccountTagById(mapping.accountTagId)?.name || "" })).filter((item) => item.account_tag),
    replace_rules: state.replaceRules.map((rule) => ({ source_account_tag: rule.sourceTagName, target_account_tag: getAccountTagById(rule.targetTagId)?.name || "" })).filter((item) => item.target_account_tag),
    manual_overrides: state.artworks
      .filter((artwork) => Boolean(state.artworkOverrides[getArtworkOverrideKey(artwork)]))
      .map((artwork) => ({ artwork_id: artwork.sourceId, bookmark_id: artwork.bookmarkId, bookmark_tags: getNormalizedArtworkAccountTagNames(artwork) }))
  };
}

function openApplyModal() {
  const modal = document.getElementById("apply-modal");
  const plan = buildSyncPlan();
  document.getElementById("apply-modal-summary").textContent = `\uD604\uC7AC \uB85C\uCEEC \uC791\uC5C5 \uAE30\uC900\uC73C\uB85C ${state.artworks.length.toLocaleString()}\uAC1C \uC791\uD488\uC744 \uBCF4\uACE0 \uC788\uC2B5\uB2C8\uB2E4.`;
  document.getElementById("sync-plan-path").textContent = "data/tag_sync_plan.json";
  document.getElementById("sync-plan-summary").textContent = `\uB9E4\uD551 ${plan.mappings.length}\uAC1C, \uCE58\uD658 ${plan.replace_rules.length}\uAC1C, \uC218\uB3D9 \uBCC0\uACBD ${plan.manual_overrides.length}\uAC1C`;
  document.getElementById("apply-selected-only-checkbox").checked = false;
  setSyncActionOutput("\uB85C\uCEEC \uC11C\uBC84\uC5D0\uC11C \uACC4\uD68D \uC800\uC7A5\uACFC \uBBF8\uB9AC\uBCF4\uAE30, \uC18C\uB7C9 \uC801\uC6A9\uC744 \uC2E4\uD589\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.", "\uC544\uC9C1 \uC2E4\uD589\uD55C \uC791\uC5C5\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.");
  renderApplyModalActions();
  modal.classList.remove("is-hidden");
}

function closeApplyModal() {
  document.getElementById("apply-modal").classList.add("is-hidden");
}

function renderSelectionPanels() {
  renderGallery();
  renderSelectedWork();
  renderMappingPanel();
  renderAssignPanel();
  renderRecommendations();
  refreshSyncApplyUi();
  finalizeRender();
}

function renderArtworkTagPanels() {
  renderPixivBookmarkTagList();
  renderAccountTags();
  renderGallery();
  renderSelectedWork();
  renderAssignPanel();
  renderRecommendations();
  refreshSyncApplyUi();
  finalizeRender();
}

function renderGalleryPanels() {
  renderPixivBookmarkTagList();
  renderGallery();
  refreshSyncApplyUi();
  finalizeRender();
}

function renderAll() {
  renderHeaderStatus();
  renderPixivBookmarkTagList();
  renderAccountTags();
  renderGallery();
  renderSelectedWork();
  renderMappingPanel();
  renderAssignPanel();
  renderReplaceRulePanel();
  renderRecommendations();
  renderDeletedBookmarkPanel();
  renderIssueList();
  refreshSyncApplyUi();
  finalizeRender();
}

function selectAllFilteredArtworks() {
  const ids = getFilteredArtworks().map((artwork) => artwork.id);
  state.selectedArtworkIds = ids;
  state.selectedArtworkId = ids[0] || "";
  renderSelectionPanels();
}

function clearArtworkSelection() {
  state.selectedArtworkId = "";
  state.selectedArtworkIds = [];
}

function bindSelectWheelGuard(selectIds) {
  selectIds.forEach((id) => {
    const select = document.getElementById(id);
    if (!(select instanceof HTMLSelectElement)) {
      return;
    }
    select.addEventListener("wheel", (event) => {
      if (document.activeElement !== select) {
        return;
      }
      event.preventDefault();
      select.blur();
    }, { passive: false });
  });
}

function focusArtwork(artworkId) {
  state.selectedArtworkId = artworkId;
  if (!getSelectedArtworkIds().includes(artworkId)) {
    state.selectedArtworkIds = [...getSelectedArtworkIds(), artworkId];
  }
  renderSelectionPanels();
}

function toggleArtworkSelection(artworkId) {
  const selected = new Set(getSelectedArtworkIds());
  if (selected.has(artworkId)) {
    selected.delete(artworkId);
  } else {
    selected.add(artworkId);
  }
  state.selectedArtworkIds = [...selected];
  if (!state.selectedArtworkIds.includes(state.selectedArtworkId)) {
    state.selectedArtworkId = state.selectedArtworkIds[0] || "";
  }
  renderSelectionPanels();
}

function addAccountTag(name, note) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return "invalid";
  if (state.accountTags.some((tag) => tag.name === trimmed)) {
    return "duplicate";
  }
  state.accountTags.push({ id: createId("acct"), name: trimmed, note: String(note || "").trim() });
  invalidateAccountTagDerivedData();
  renderAll();
  return "created";
}

function quickAddAccountTagFromPixivTag(tagName) {
  const trimmed = String(tagName || "").trim();
  if (!trimmed || trimmed === "전체") return;
  const result = addAccountTag(trimmed, "Pixiv 북마크 태그에서 가져옴");
  if (result === "created") {
    showToast(`계정 태그에 ${trimmed} 추가됨`);
    return;
  }
  if (result === "duplicate") {
    showToast(`계정 태그에 ${trimmed} 이미 있음`);
  }
}

function deleteAccountTag(tagId) {
  state.accountTags = state.accountTags.filter((tag) => tag.id !== tagId);
  state.artworks.forEach((artwork) => {
    artwork.accountTagIds = artwork.accountTagIds.filter((id) => id !== tagId);
  });
  syncArtworkOverrides(state.artworks);
  state.mappings = state.mappings.filter((mapping) => mapping.accountTagId !== tagId);
  state.replaceRules = state.replaceRules.filter((rule) => rule.sourceTagId !== tagId && rule.targetTagId !== tagId);
  invalidateArtworkDerivedData();
  invalidateAccountTagDerivedData();
  invalidateMappingDerivedData();
  renderAll();
}

function assignTagToSelectedArtwork(tagId) {
  assignTagsToSelectedArtworks([tagId]);
}

function assignTagsToSelectedArtworks(tagIds) {
  const targets = getSelectionTargets();
  const normalizedTagIds = [...new Set((tagIds || []).filter(Boolean))];
  if (targets.length === 0 || normalizedTagIds.length === 0) {
    return;
  }
  targets.forEach((artwork) => {
    normalizedTagIds.forEach((tagId) => {
      if (!artwork.accountTagIds.includes(tagId)) {
        artwork.accountTagIds.push(tagId);
      }
    });
  });
  syncArtworkOverrides(targets);
  invalidateArtworkDerivedData();
  renderArtworkTagPanels();
}

function removeTagFromSelectedArtwork(tagId) {
  const targets = getSelectionTargets();
  targets.forEach((artwork) => {
    artwork.accountTagIds = artwork.accountTagIds.filter((id) => id !== tagId);
  });
  syncArtworkOverrides(targets);
  invalidateArtworkDerivedData();
  renderArtworkTagPanels();
}

function addMapping(pixivTag, accountTagId) {
  const source = String(pixivTag || "").trim();
  if (!source) {
    showToast("Pixiv 태그를 입력하거나 선택하세요.");
    return;
  }
  if (state.mappings.some((mapping) => mapping.pixivTag === source && mapping.accountTagId === accountTagId)) {
    return;
  }
  state.mappings.push({ id: createId("map"), pixivTag: source, accountTagId });
  invalidateMappingDerivedData();
  renderAll();
}

function addReplaceRule(sourceTagId, targetTagId) {
  if (!sourceTagId || !targetTagId || sourceTagId === targetTagId) {
    showToast("서로 다른 두 계정 태그를 선택하세요.");
    return;
  }
  const sourceTag = getAccountTagById(sourceTagId);
  if (!sourceTag) return;
  state.replaceRules.push({ id: createId("replace"), sourceTagId, sourceTagName: sourceTag.name, targetTagId });
  renderAll();
}

function replaceTagOnSelectedArtworks(sourceTagId, targetTagId) {
  const targets = getSelectionTargets();
  targets.forEach((artwork) => {
    if (artwork.accountTagIds.includes(sourceTagId)) {
      if (targetTagId === QUICK_REPLACE_DELETE_VALUE) {
        artwork.accountTagIds = artwork.accountTagIds.filter((id) => id !== sourceTagId);
      } else {
        artwork.accountTagIds = artwork.accountTagIds.map((id) => id === sourceTagId ? targetTagId : id);
        artwork.accountTagIds = [...new Set(artwork.accountTagIds)];
      }
    }
  });
  syncArtworkOverrides(targets);
  invalidateArtworkDerivedData();
  renderArtworkTagPanels();
}

function bindEvents() {
  let pixivTagLongPressTimer = null;
  bindSelectWheelGuard([
    "gallery-page-size-select",
    "quick-add-tag-select",
    "quick-replace-source-select",
    "quick-replace-target-select",
    "pixiv-tag-select",
    "account-tag-select",
    "assign-tag-select",
    "replace-source-tag-select",
    "replace-target-tag-select"
  ]);

  function clearPixivTagLongPressTimer() {
    if (pixivTagLongPressTimer) {
      clearTimeout(pixivTagLongPressTimer);
      pixivTagLongPressTimer = null;
    }
  }

  document.querySelectorAll("[data-scroll-target]").forEach((button) => {
    button.addEventListener("click", () => {
      const targetId = button.getAttribute("data-scroll-target");
      if (!targetId) {
        return;
      }
      document.getElementById(targetId)?.scrollIntoView({ block: "start" });
    });
  });

  document.getElementById("add-tag-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    addAccountTag(formData.get("tagName"), formData.get("tagNote"));
    event.currentTarget.reset();
  });

  document.getElementById("mapping-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    addMapping(String(formData.get("pixivTagInput") || formData.get("pixivTag") || ""), String(formData.get("accountTag") || ""));
    document.getElementById("pixiv-tag-input").value = "";
  });

  document.getElementById("assign-tag-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    assignTagToSelectedArtwork(String(formData.get("assignTag") || ""));
  });

  document.getElementById("replace-rule-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    addReplaceRule(String(formData.get("replaceSourceTag") || ""), String(formData.get("replaceTargetTag") || ""));
  });

  document.getElementById("quick-add-tag-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    assignTagToSelectedArtwork(String(formData.get("quickAddTag") || ""));
  });

  document.getElementById("quick-replace-tag-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    replaceTagOnSelectedArtworks(String(formData.get("quickReplaceSource") || ""), String(formData.get("quickReplaceTarget") || ""));
  });

  document.getElementById("thumbnail-repeat-button").addEventListener("click", async () => {
    const worker = apiState.worker || null;
    if (worker?.running && worker.mode === "repeat") {
      await stopThumbnailWorker();
      return;
    }
    await startThumbnailWorker(true);
  });

  document.getElementById("thumbnail-once-button").addEventListener("click", async () => {
    await startThumbnailWorker(false);
  });

  document.getElementById("save-local-button").addEventListener("click", () => {
    saveState();
    showToast("현재 작업 상태를 저장했습니다.");
  });

  document.getElementById("session-check-button").addEventListener("click", () => {
    void validatePixivSession(true);
  });
  document.getElementById("session-guide-button").addEventListener("click", showSessionGuide);
  document.getElementById("refresh-bookmarks-button").addEventListener("click", refreshBookmarksFromPixiv);
  document.getElementById("select-all-deleted-button").addEventListener("click", selectAllDeletedArtworks);
  document.getElementById("clear-deleted-selection-button").addEventListener("click", clearDeletedArtworkSelection);
  document.getElementById("remove-selected-deleted-button").addEventListener("click", () => removeBookmarksForArtworks(getSelectedDeletedArtworkIds()));

  document.getElementById("reset-data-button").addEventListener("click", () => {
    state = structuredClone(initialState);
    applyBundledSnapshot();
    renderAll();
  });

  document.getElementById("open-apply-modal-button").addEventListener("click", openApplyModal);
  document.getElementById("close-apply-modal-button").addEventListener("click", closeApplyModal);
  document.getElementById("save-sync-plan-button").addEventListener("click", saveSyncPlanToServer);
  document.getElementById("run-sync-preview-button").addEventListener("click", runSyncPreview);
  document.getElementById("run-sync-apply-button").addEventListener("click", runSyncApply);
  document.getElementById("stop-sync-apply-button").addEventListener("click", stopSyncApply);
  document.getElementById("apply-selected-only-checkbox").addEventListener("change", refreshSyncApplyUi);
  document.getElementById("apply-recommendations-button").addEventListener("click", () => {
    const { selectedArtworks } = getRecommendationContext();
    if (selectedArtworks.length === 0) return;
    assignTagsToSelectedArtworks(getRecommendations(selectedArtworks).map((item) => item.tagId));
  });
  document.getElementById("clear-selection-button").addEventListener("click", () => {
    clearArtworkSelection();
    renderSelectionPanels();
  });
  document.getElementById("select-all-button").addEventListener("click", selectAllFilteredArtworks);
  document.getElementById("clear-tag-search-button").addEventListener("click", () => {
    state.gallerySearch = "";
    state.galleryPage = 1;
    renderGalleryPanels();
  });
  document.getElementById("gallery-search-input").addEventListener("input", (event) => {
    state.gallerySearch = event.currentTarget.value;
    state.galleryPage = 1;
    renderGalleryPanels();
  });
  document.getElementById("gallery-page-size-select").addEventListener("change", (event) => {
    state.galleryPageSize = Number(event.currentTarget.value);
    state.galleryPage = 1;
    renderGalleryPanels();
  });

  document.addEventListener("pointerdown", (event) => {
    const button = event.target.closest(".pixiv-tag-search-button[data-delete-tag-name]");
    if (!button) return;
    clearPixivTagLongPressTimer();
    pixivTagLongPressTimer = window.setTimeout(() => {
      button.dataset.longPressTriggered = "true";
      clearPixivTagLongPressTimer();
      confirmDeletePixivBookmarkTag(button.dataset.deleteTagName || "");
    }, LONG_PRESS_DURATION_MS);
  });

  ["pointerup", "pointercancel", "pointerleave", "pointerout", "dragstart"].forEach((eventName) => {
    document.addEventListener(eventName, () => {
      clearPixivTagLongPressTimer();
    });
  });

  document.addEventListener("contextmenu", (event) => {
    const button = event.target.closest(".pixiv-tag-search-button[data-delete-tag-name]");
    if (!button) return;
    event.preventDefault();
  });

  document.addEventListener("click", (event) => {
    if (event.target.closest("a[href]")) {
      return;
    }
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const { action, artworkId, tagId, mappingId, replaceRuleId, filterId, pageDirection, tagName } = button.dataset;
    if (action === "focus-artwork") focusArtwork(artworkId);
    if (action === "remove-bookmark") {
      removeBookmarksForArtworks([artworkId]);
      return;
    }
    if (action === "toggle-deleted-artwork-selection") {
      toggleDeletedArtworkSelection(artworkId);
      return;
    }
    if (action === "toggle-artwork-selection") toggleArtworkSelection(artworkId);
    if (action === "delete-tag") deleteAccountTag(tagId);
    if (action === "remove-account-tag") removeTagFromSelectedArtwork(tagId);
    if (action === "delete-mapping") {
      state.mappings = state.mappings.filter((mapping) => mapping.id !== mappingId);
      invalidateMappingDerivedData();
      renderAll();
    }
    if (action === "delete-replace-rule") {
      state.replaceRules = state.replaceRules.filter((rule) => rule.id !== replaceRuleId);
      renderAll();
    }
    if (action === "apply-recommendation") assignTagToSelectedArtwork(tagId);
    if (action === "set-gallery-filter") {
      state.galleryFilter = filterId;
      state.galleryPage = 1;
      renderGalleryPanels();
    }
    if (action === "change-gallery-page") {
      jumpGalleryPage(state.galleryPage + Number(pageDirection));
    }
    if (action === "search-gallery-keyword") {
      state.gallerySearch = tagName || "";
      state.galleryPage = 1;
      renderGalleryPanels();
    }
    if (action === "search-pixiv-bookmark-tag") {
      if (button.dataset.longPressTriggered === "true") {
        button.dataset.longPressTriggered = "";
        return;
      }
      if (isUnclassifiedBookmarkTagName(tagName)) {
        clearArtworkSelection();
      }
      state.gallerySearch = tagName || "";
      state.galleryPage = 1;
      renderGalleryPanels();
    }
    if (action === "add-account-tag-from-pixiv-tag") quickAddAccountTagFromPixivTag(tagName);
    if (action === "clear-pixiv-bookmark-tag-search") {
      state.gallerySearch = "";
      state.galleryPage = 1;
      renderGalleryPanels();
    }
  });

  document.addEventListener("submit", (event) => {
    const form = event.target.closest('[data-action="jump-gallery-page"]');
    if (!form) return;
    event.preventDefault();
    const pageInput = form.elements.namedItem("page");
    if (!(pageInput instanceof HTMLInputElement)) {
      return;
    }
    const rawValue = pageInput.value.trim();
    if (!/^\d+$/.test(rawValue)) {
      return;
    }
    jumpGalleryPage(Number.parseInt(rawValue, 10));
  });

  document.addEventListener("input", (event) => {
    const pageInput = event.target.closest(".pagination-jump-input");
    if (!(pageInput instanceof HTMLInputElement)) {
      return;
    }
    const sanitizedValue = pageInput.value.replace(/\D+/g, "");
    if (pageInput.value !== sanitizedValue) {
      pageInput.value = sanitizedValue;
    }
    uiState.galleryPageJumpDraft = sanitizedValue;
  });

  document.getElementById("apply-modal").addEventListener("click", (event) => {
    if (event.target.id === "apply-modal") {
      closeApplyModal();
    }
  });
}

bindEvents();
renderAll();
startApiPolling();



