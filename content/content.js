// Content script for YouTube pages
// Detects VOD pages with chat replay, extracts continuation tokens,
// and performs API fetches (runs in YouTube's origin for cookie access)

(function () {
  'use strict';

  let lastVideoId = null;
  let fetchAbortController = null;
  let isFetching = false;

  function getVideoId() {
    const params = new URLSearchParams(window.location.search);
    return params.get('v');
  }

  // ─── ytInitialData Extraction ───

  function extractYtInitialData() {
    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
      const text = script.textContent;
      const match = text.match(/var\s+ytInitialData\s*=\s*(\{.+\})\s*;/s);
      if (match) {
        try {
          return JSON.parse(match[1]);
        } catch (e) {
          console.error('[YT Chat Downloader] Failed to parse ytInitialData:', e);
        }
      }
    }
    return null;
  }

  function extractContinuationToken(ytInitialData) {
    if (!ytInitialData) return null;
    try {
      const liveChatRenderer =
        ytInitialData?.contents?.twoColumnWatchNextResults?.conversationBar
          ?.liveChatRenderer;
      if (!liveChatRenderer) return null;

      const continuations = liveChatRenderer.continuations;
      if (!continuations || continuations.length === 0) return null;

      for (const cont of continuations) {
        if (cont.reloadContinuationData) {
          return cont.reloadContinuationData.continuation;
        }
      }
      for (const cont of continuations) {
        const data =
          cont.invalidationContinuationData ||
          cont.timedContinuationData ||
          cont.liveChatReplayContinuationData;
        if (data?.continuation) return data.continuation;
      }
    } catch (e) {
      console.error('[YT Chat Downloader] Error extracting continuation:', e);
    }
    return null;
  }

  function extractVideoInfo(ytInitialData) {
    const info = { title: '', channelName: '', videoId: getVideoId() };
    try {
      const contents =
        ytInitialData?.contents?.twoColumnWatchNextResults?.results?.results?.contents;
      if (contents) {
        for (const content of contents) {
          const primary = content.videoPrimaryInfoRenderer;
          if (primary?.title?.runs) {
            info.title = primary.title.runs.map((r) => r.text).join('');
          }
          const secondary = content.videoSecondaryInfoRenderer;
          if (secondary?.owner?.videoOwnerRenderer?.title?.runs) {
            info.channelName = secondary.owner.videoOwnerRenderer.title.runs
              .map((r) => r.text).join('');
          }
        }
      }
    } catch (e) {
      console.error('[YT Chat Downloader] Error extracting video info:', e);
    }
    if (!info.title) {
      const titleEl = document.querySelector('h1.ytd-watch-metadata yt-formatted-string');
      if (titleEl) info.title = titleEl.textContent.trim();
    }
    return info;
  }

  // ─── ytcfg Extraction via Injection ───

  let cachedInnertubeConfig = null;

  function extractViaInjection() {
    const script = document.createElement('script');
    script.textContent = `
      (function() {
        var payload = {};
        if (window.ytInitialData) {
          payload.ytInitialData = window.ytInitialData;
        }
        if (window.ytcfg && window.ytcfg.get) {
          payload.innertubeConfig = {
            apiKey: window.ytcfg.get('INNERTUBE_API_KEY'),
            clientName: window.ytcfg.get('INNERTUBE_CLIENT_NAME'),
            clientVersion: window.ytcfg.get('INNERTUBE_CLIENT_VERSION'),
            visitorData: window.ytcfg.get('VISITOR_DATA'),
          };
        }
        if (payload.ytInitialData || payload.innertubeConfig) {
          window.postMessage({
            type: '__YT_CHAT_DL_INITIAL_DATA__',
            data: JSON.stringify(payload)
          }, '*');
        }
      })();
    `;
    document.documentElement.appendChild(script);
    script.remove();
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.type !== '__YT_CHAT_DL_INITIAL_DATA__') return;

    try {
      const payload = JSON.parse(event.data.data);
      const ytInitialData = payload.ytInitialData;
      cachedInnertubeConfig = payload.innertubeConfig || cachedInnertubeConfig;

      const continuationToken = extractContinuationToken(ytInitialData);
      const videoInfo = extractVideoInfo(ytInitialData);
      const videoId = getVideoId();

      if (continuationToken && videoId !== lastVideoId) {
        lastVideoId = videoId;
        chrome.runtime.sendMessage({
          type: 'CHAT_REPLAY_DETECTED',
          data: {
            continuationToken,
            videoId,
            title: videoInfo.title,
            channelName: videoInfo.channelName,
          },
        }).catch(() => {});
      }
    } catch (e) {
      console.error('[YT Chat Downloader] Error parsing injected data:', e);
    }
  });

  function checkForChatReplay() {
    const videoId = getVideoId();
    if (!videoId || videoId === lastVideoId) return;
    lastVideoId = videoId;

    const ytInitialData = extractYtInitialData();
    const continuationToken = extractContinuationToken(ytInitialData);
    const videoInfo = extractVideoInfo(ytInitialData);

    if (continuationToken) {
      chrome.runtime.sendMessage({
        type: 'CHAT_REPLAY_DETECTED',
        data: {
          continuationToken,
          videoId,
          title: videoInfo.title,
          channelName: videoInfo.channelName,
        },
      }).catch(() => {});
    } else {
      chrome.runtime.sendMessage({
        type: 'NO_CHAT_REPLAY',
        data: { videoId, title: videoInfo.title },
      }).catch(() => {});
    }
  }

  // ─── Chat Fetching (runs here for YouTube cookie access) ───

  async function fetchAllMessages(initialContinuation) {
    if (isFetching) return;
    isFetching = true;
    fetchAbortController = new AbortController();

    let continuation = initialContinuation;
    let retryCount = 0;
    const maxRetries = 3;

    while (continuation && isFetching) {
      try {
        const result = await fetchChatPage(continuation, fetchAbortController.signal);

        if (!result) {
          retryCount++;
          if (retryCount >= maxRetries) {
            isFetching = false;
            chrome.runtime.sendMessage({
              type: 'FETCH_PAGE_ERROR',
              data: { error: 'Failed to fetch chat data after multiple retries' },
            }).catch(() => {});
            return;
          }
          await sleep(1000 * Math.pow(2, retryCount));
          continue;
        }

        retryCount = 0;
        const { messages, nextContinuation } = result;

        if (messages.length > 0) {
          chrome.runtime.sendMessage({
            type: 'FETCH_PAGE_RESULT',
            data: { messages },
          }).catch(() => {});
        }

        continuation = nextContinuation;

        if (!continuation) {
          isFetching = false;
          chrome.runtime.sendMessage({
            type: 'FETCH_PAGE_DONE',
          }).catch(() => {});
          return;
        }

        await sleep(150);
      } catch (e) {
        if (e.name === 'AbortError') {
          isFetching = false;
          return;
        }

        console.error('[YT Chat Downloader] Fetch error:', e);

        if (e.message?.includes('429') || e.message?.includes('rate')) {
          chrome.runtime.sendMessage({
            type: 'FETCH_PAGE_RATE_LIMITED',
          }).catch(() => {});
          try {
            await abortableSleep(30000, fetchAbortController.signal);
          } catch (abortErr) {
            isFetching = false;
            return;
          }
          continue;
        }

        retryCount++;
        if (retryCount >= maxRetries) {
          isFetching = false;
          chrome.runtime.sendMessage({
            type: 'FETCH_PAGE_ERROR',
            data: { error: e.message || 'Unknown error' },
          }).catch(() => {});
          return;
        }
        await sleep(1000 * Math.pow(2, retryCount));
      }
    }

    isFetching = false;
  }

  async function fetchChatPage(continuation, signal) {
    const cfg = cachedInnertubeConfig || {};
    const apiKey = cfg.apiKey || 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
    const clientVersion = cfg.clientVersion || '2.20260205.01.00';
    const visitorData = cfg.visitorData || '';

    const apiUrl = `https://www.youtube.com/youtubei/v1/live_chat/get_live_chat_replay?key=${apiKey}&prettyPrint=false`;

    const clientContext = {
      clientName: 'WEB',
      clientVersion,
    };
    if (visitorData) clientContext.visitorData = visitorData;

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        context: { client: clientContext },
        continuation,
      }),
      signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    return parseChatResponse(data);
  }

  function parseChatResponse(data) {
    const messages = [];
    let nextContinuation = null;

    try {
      const liveChatContinuation = data?.continuationContents?.liveChatContinuation;
      if (!liveChatContinuation) return null;

      const continuations = liveChatContinuation.continuations;
      if (continuations) {
        for (const cont of continuations) {
          const contData =
            cont.liveChatReplayContinuationData ||
            cont.timedContinuationData ||
            cont.invalidationContinuationData;
          if (contData?.continuation) {
            nextContinuation = contData.continuation;
            break;
          }
        }
      }

      const actions = liveChatContinuation.actions || [];
      for (const action of actions) {
        const replayAction = action.replayChatItemAction;
        if (!replayAction) continue;

        const actions2 = replayAction.actions || [];
        for (const action2 of actions2) {
          const item = action2.addChatItemAction?.item;
          if (!item) continue;

          const parsed = parseChatItem(item, replayAction.videoOffsetTimeMsec);
          if (parsed) messages.push(parsed);
        }
      }
    } catch (e) {
      console.error('[YT Chat Downloader] Parse error:', e);
    }

    return { messages, nextContinuation };
  }

  function parseChatItem(item, offsetMs) {
    let renderer = null;
    let messageType = 'text';

    if (item.liveChatTextMessageRenderer) {
      renderer = item.liveChatTextMessageRenderer;
    } else if (item.liveChatPaidMessageRenderer) {
      renderer = item.liveChatPaidMessageRenderer;
      messageType = 'superchat';
    } else if (item.liveChatMembershipItemRenderer) {
      renderer = item.liveChatMembershipItemRenderer;
      messageType = 'membership';
    } else if (item.liveChatPaidStickerRenderer) {
      renderer = item.liveChatPaidStickerRenderer;
      messageType = 'supersticker';
    } else if (item.liveChatSponsorshipsGiftPurchaseAnnouncementRenderer) {
      renderer = item.liveChatSponsorshipsGiftPurchaseAnnouncementRenderer;
      messageType = 'membership';
    } else if (item.liveChatSponsorshipsGiftRedemptionAnnouncementRenderer) {
      renderer = item.liveChatSponsorshipsGiftRedemptionAnnouncementRenderer;
      messageType = 'membership';
    }

    if (!renderer) return null;

    let messageText = '';
    const messageRuns = renderer.message?.runs;
    if (messageRuns) {
      messageText = messageRuns.map((run) => {
        if (run.text) return run.text;
        if (run.emoji) return run.emoji.shortcuts?.[0] || run.emoji.emojiId || '';
        return '';
      }).join('');
    }
    if (!messageText && renderer.headerSubtext?.runs) {
      messageText = renderer.headerSubtext.runs.map((r) => r.text || '').join('');
    }
    if (!messageText && renderer.header?.liveChatSponsorshipsHeaderRenderer) {
      const h = renderer.header.liveChatSponsorshipsHeaderRenderer;
      if (h.primaryText?.runs) messageText = h.primaryText.runs.map((r) => r.text || '').join('');
    }

    const badges = [];
    for (const badge of (renderer.authorBadges || [])) {
      const br = badge.liveChatAuthorBadgeRenderer;
      if (br) {
        const iconType = br.icon?.iconType;
        if (iconType === 'OWNER') badges.push('owner');
        else if (iconType === 'MODERATOR') badges.push('moderator');
        else if (iconType === 'VERIFIED') badges.push('verified');
        else if (br.customThumbnail) badges.push('member');
      }
    }

    let profileImage = '';
    const thumbnails = renderer.authorPhoto?.thumbnails;
    if (thumbnails?.length > 0) profileImage = thumbnails[thumbnails.length - 1].url;

    let superchatAmount = '';
    if (renderer.purchaseAmountText?.simpleText) {
      superchatAmount = renderer.purchaseAmountText.simpleText;
    } else if (renderer.purchaseAmountText?.runs) {
      superchatAmount = renderer.purchaseAmountText.runs.map((r) => r.text).join('');
    }

    const offsetMsNum = parseInt(offsetMs, 10) || 0;

    return {
      timestamp_ms: offsetMsNum,
      timestamp_text: formatTimestamp(offsetMsNum),
      author_name: renderer.authorName?.simpleText || '',
      author_channel_id: renderer.authorExternalChannelId || '',
      author_profile_image: profileImage,
      message: messageText,
      message_type: messageType,
      is_owner: badges.includes('owner'),
      is_moderator: badges.includes('moderator'),
      is_member: badges.includes('member'),
      is_verified: badges.includes('verified'),
      badges: badges.join(','),
      superchat_amount: superchatAmount,
    };
  }

  function formatTimestamp(ms) {
    const totalSeconds = Math.floor(Math.abs(ms) / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const sign = ms < 0 ? '-' : '';
    if (hours > 0) {
      return `${sign}${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
    return `${sign}${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function abortableSleep(ms, signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    });
  }

  // ─── Message Listener ───

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'CHECK_FOR_CHAT_REPLAY') {
      lastVideoId = null;
      extractViaInjection();
      setTimeout(() => checkForChatReplay(), 500);
      sendResponse({ status: 'checking' });
    } else if (message.type === 'START_FETCH_FROM_CONTENT') {
      if (message.continuation) {
        // Ensure we have ytcfg before fetching
        extractViaInjection();
        setTimeout(() => {
          fetchAllMessages(message.continuation);
        }, 300);
      }
      sendResponse({ status: 'ok' });
    } else if (message.type === 'STOP_FETCH_FROM_CONTENT') {
      isFetching = false;
      if (fetchAbortController) {
        fetchAbortController.abort();
        fetchAbortController = null;
      }
      sendResponse({ status: 'ok' });
    }
    return true;
  });

  // ─── Initial Check ───

  checkForChatReplay();
  if (!lastVideoId) {
    extractViaInjection();
  }

  // Watch for YouTube SPA navigation
  const observer = new MutationObserver(() => {
    const currentVideoId = getVideoId();
    if (currentVideoId && currentVideoId !== lastVideoId) {
      setTimeout(() => {
        extractViaInjection();
        setTimeout(checkForChatReplay, 500);
      }, 1500);
    }
  });

  observer.observe(document.querySelector('title') || document.head, {
    childList: true,
    subtree: true,
  });
})();
