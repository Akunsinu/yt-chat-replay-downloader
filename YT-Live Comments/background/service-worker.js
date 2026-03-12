// Background service worker
// Routes messages, collects chat/comments data from content script, handles exports and archive orchestration

let currentVideoData = null;
let chatMessages = [];
let fetchState = 'idle'; // idle, ready, fetching, complete, stopped, error
let fetchProgress = { current: 0, total: 0 };
let activeTabId = null;

// New state for full archiver
let videoMetadata = null;
let regularComments = [];
let commentsFetchState = 'idle'; // idle, fetching, complete, error
let commentsFetchProgress = { topLevel: 0, replies: 0 };
let archiveSteps = {
  metadata: 'pending',
  comments: 'pending',
  liveChat: 'pending',
  video: 'pending',
};
let nativeDownloadPort = null; // native messaging port for yt-dlp video download
let isArchiving = false;

// Load html2canvas source for embedding in generated HTML files
const html2canvasSrcPromise = fetch(chrome.runtime.getURL('lib/html2canvas.min.js'))
  .then(r => r.text())
  .catch(e => { console.error('[YT Archiver] Failed to load html2canvas:', e); return ''; });

// Open side panel when extension icon is clicked
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// ─── State Persistence ───

async function saveState() {
  try {
    await chrome.storage.session.set({
      _sw_state: {
        currentVideoData,
        chatMessages,
        fetchState: fetchState === 'fetching' ? 'stopped' : fetchState,
        fetchProgress,
        videoMetadata,
        regularComments: regularComments.length <= 5000 ? regularComments : [],
        commentsFetchState: commentsFetchState === 'fetching' ? 'idle' : commentsFetchState,
        commentsFetchProgress,
        archiveSteps,
        activeTabId,
        commentCountBackup: regularComments.length,
      },
    });
  } catch (e) {
    try {
      await chrome.storage.session.set({
        _sw_state: {
          currentVideoData,
          chatMessages: [],
          fetchState: fetchState === 'fetching' ? 'stopped' : fetchState,
          fetchProgress,
          videoMetadata,
          regularComments: [],
          commentsFetchState: commentsFetchState === 'fetching' ? 'idle' : commentsFetchState,
          commentsFetchProgress,
          archiveSteps,
          activeTabId,
          messageCountLost: chatMessages.length,
          commentCountLost: regularComments.length,
        },
      });
    } catch (e2) {
      console.error('[YT Archiver] Failed to save state:', e2);
    }
  }
}

async function restoreState() {
  try {
    const result = await chrome.storage.session.get('_sw_state');
    if (result._sw_state) {
      const s = result._sw_state;
      currentVideoData = s.currentVideoData || null;
      chatMessages = s.chatMessages || [];
      fetchState = s.fetchState || 'idle';
      fetchProgress = s.fetchProgress || { current: 0, total: 0 };
      videoMetadata = s.videoMetadata || null;
      regularComments = s.regularComments || [];
      commentsFetchState = s.commentsFetchState || 'idle';
      commentsFetchProgress = s.commentsFetchProgress || { topLevel: 0, replies: 0 };
      archiveSteps = s.archiveSteps || { metadata: 'pending', comments: 'pending', liveChat: 'pending', video: 'pending' };
      activeTabId = s.activeTabId || null;
    }
  } catch (e) {
    console.error('[YT Archiver] Failed to restore state:', e);
  }
}

const stateReady = restoreState();

// ─── Message Routing ───

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender, sendResponse);
  return true;
});

async function handleMessage(message, sender, sendResponse) {
  try {
  await stateReady;
  console.log('[YT Archiver SW] Received:', message.type, '| videoData:', !!currentVideoData, '| activeTab:', activeTabId);
  switch (message.type) {
    // From content script: video page detected (unified message)
    case 'VIDEO_PAGE_DETECTED': {
      const d = message.data;
      const isNewVideo = !currentVideoData || currentVideoData.videoId !== d.videoId;

      currentVideoData = {
        videoId: d.videoId,
        title: d.title,
        channelName: d.channelName,
        chatContinuationToken: d.chatContinuationToken,
        commentsContinuationToken: d.commentsContinuationToken,
        hasStreams: d.hasStreams,
        streamingSummary: d.streamingSummary,
      };

      // Update metadata if we have richer data (injection path sends full metadata)
      if (d.metadata && Object.keys(d.metadata).length > 0) {
        videoMetadata = d.metadata;
      } else if (isNewVideo) {
        videoMetadata = {};
      }

      // Only clear collected data when navigating to a different video
      if (isNewVideo) {
        chatMessages = [];
        regularComments = [];
        fetchState = d.chatContinuationToken ? 'ready' : 'idle';
        fetchProgress = { current: 0, total: 0 };
        commentsFetchState = 'idle';
        commentsFetchProgress = { topLevel: 0, replies: 0 };
        archiveSteps = {
          metadata: (videoMetadata && Object.keys(videoMetadata).length > 0) ? 'complete' : 'pending',
          comments: d.commentsContinuationToken ? 'pending' : 'skipped',
          liveChat: d.chatContinuationToken ? 'pending' : 'skipped',
          video: d.hasStreams ? 'pending' : 'skipped',
        };
        isArchiving = false;
        if (nativeDownloadPort) {
          nativeDownloadPort.disconnect();
          nativeDownloadPort = null;
        }
      } else {
        // Same video re-detected (e.g. re-check) - update capabilities without clearing data
        // Update steps for newly available capabilities
        if (archiveSteps.metadata !== 'complete' && videoMetadata && Object.keys(videoMetadata).length > 0) {
          archiveSteps.metadata = 'complete';
        }
        if (archiveSteps.comments === 'skipped' && d.commentsContinuationToken) {
          archiveSteps.comments = 'pending';
        }
        if (archiveSteps.liveChat === 'skipped' && d.chatContinuationToken) {
          archiveSteps.liveChat = 'pending';
        }
        if (archiveSteps.video === 'skipped' && d.hasStreams) {
          archiveSteps.video = 'pending';
        }
      }

      if (sender.tab) activeTabId = sender.tab.id;
      saveState();
      broadcastToSidePanel({
        type: 'VIDEO_PAGE_DETECTED',
        data: {
          ...currentVideoData,
          metadata: videoMetadata,
          archiveSteps,
        },
      });
      sendResponse({ status: 'ok' });
      break;
    }

    // Backward compat: old content scripts
    case 'CHAT_REPLAY_DETECTED':
      currentVideoData = message.data;
      chatMessages = [];
      fetchState = 'ready';
      fetchProgress = { current: 0, total: 0 };
      if (sender.tab) activeTabId = sender.tab.id;
      saveState();
      broadcastToSidePanel({ type: 'VIDEO_PAGE_DETECTED', data: { ...currentVideoData, archiveSteps } });
      sendResponse({ status: 'ok' });
      break;

    case 'NO_CHAT_REPLAY':
      currentVideoData = { ...message.data, noChatReplay: true };
      fetchState = 'idle';
      saveState();
      broadcastToSidePanel({ type: 'VIDEO_PAGE_DETECTED', data: { ...currentVideoData, archiveSteps } });
      sendResponse({ status: 'ok' });
      break;

    // From side panel: get current state
    case 'GET_STATE':
      sendResponse({
        videoData: currentVideoData,
        fetchState,
        fetchProgress,
        messageCount: chatMessages.length,
        metadata: videoMetadata,
        commentCount: regularComments.length,
        commentsFetchState,
        commentsFetchProgress,
        archiveSteps,
      });
      break;

    // From side panel: start full archive
    case 'START_ARCHIVE':
      sendResponse({ status: 'ok' });
      console.log('[YT Archiver SW] Starting full archive...');
      try {
        await startFullArchive();
      } catch (e) {
        console.error('[YT Archiver SW] startFullArchive error:', e);
        broadcastToSidePanel({ type: 'FETCH_ERROR', data: { error: 'Archive failed: ' + e.message } });
      }
      break;

    // From side panel: stop all fetching
    case 'STOP_ARCHIVE':
      sendResponse({ status: 'ok' });
      await stopAllFetching();
      break;

    // From side panel: start fetching chat (delegates to content script)
    case 'START_FETCH': {
      sendResponse({ status: 'ok' });
      const token = currentVideoData?.chatContinuationToken || currentVideoData?.continuationToken;
      if (token) {
        fetchState = 'fetching';
        chatMessages = [];
        fetchProgress = { current: 0, total: 0 };
        archiveSteps.liveChat = 'fetching';
        broadcastToSidePanel({ type: 'FETCH_STARTED' });
        broadcastToSidePanel({ type: 'ARCHIVE_STEP_UPDATE', data: { archiveSteps } });

        const tabId = await resolveActiveTab();
        if (tabId) {
          try {
            await chrome.tabs.sendMessage(tabId, {
              type: 'START_FETCH_FROM_CONTENT',
              continuation: token,
            });
          } catch (err) {
            console.error('[YT Archiver] Failed to start fetch in content script:', err);
            fetchState = 'error';
            archiveSteps.liveChat = 'error';
            broadcastToSidePanel({
              type: 'FETCH_ERROR',
              data: { error: 'Could not communicate with YouTube page. Try refreshing.' },
            });
            broadcastToSidePanel({ type: 'ARCHIVE_STEP_UPDATE', data: { archiveSteps } });
          }
        } else {
          fetchState = 'error';
          archiveSteps.liveChat = 'error';
          broadcastToSidePanel({
            type: 'FETCH_ERROR',
            data: { error: 'No active YouTube tab found. Try refreshing.' },
          });
          broadcastToSidePanel({ type: 'ARCHIVE_STEP_UPDATE', data: { archiveSteps } });
        }
      } else {
        console.log('[YT Archiver SW] START_FETCH: no chat token available');
      }
      break;
    }

    // From side panel: stop fetching chat
    case 'STOP_FETCH':
      fetchState = 'stopped';
      archiveSteps.liveChat = chatMessages.length > 0 ? 'complete' : 'pending';
      if (activeTabId) {
        chrome.tabs.sendMessage(activeTabId, { type: 'STOP_FETCH_FROM_CONTENT' }).catch(() => {});
      }
      saveState();
      broadcastToSidePanel({
        type: 'FETCH_STOPPED',
        data: { messageCount: chatMessages.length },
      });
      broadcastToSidePanel({ type: 'ARCHIVE_STEP_UPDATE', data: { archiveSteps } });
      sendResponse({ status: 'ok' });
      break;

    // From side panel: start comments fetch
    case 'START_COMMENTS_FETCH': {
      sendResponse({ status: 'ok' });
      // Check if this is from the content script (has continuation) or from panel
      const token = message.continuation || currentVideoData?.commentsContinuationToken;
      console.log('[YT Archiver SW] START_COMMENTS_FETCH: token length:', token?.length, 'from:', sender.tab ? 'tab' : 'panel');
      if (token && !sender.tab) {
        // From panel: need to forward to content script
        commentsFetchState = 'fetching';
        regularComments = [];
        commentsFetchProgress = { topLevel: 0, replies: 0 };
        archiveSteps.comments = 'fetching';
        broadcastToSidePanel({ type: 'COMMENTS_FETCH_STARTED' });
        broadcastToSidePanel({ type: 'ARCHIVE_STEP_UPDATE', data: { archiveSteps } });

        const tabId = await resolveActiveTab();
        if (tabId) {
          try {
            await chrome.tabs.sendMessage(tabId, {
              type: 'START_COMMENTS_FETCH',
              continuation: token,
            });
          } catch (err) {
            console.error('[YT Archiver] Failed to start comments fetch:', err);
            commentsFetchState = 'error';
            archiveSteps.comments = 'error';
            broadcastToSidePanel({
              type: 'COMMENTS_FETCH_ERROR_MSG',
              data: { error: 'Could not communicate with YouTube page. Try refreshing.' },
            });
            broadcastToSidePanel({ type: 'ARCHIVE_STEP_UPDATE', data: { archiveSteps } });
          }
        } else {
          commentsFetchState = 'error';
          archiveSteps.comments = 'error';
          broadcastToSidePanel({
            type: 'COMMENTS_FETCH_ERROR_MSG',
            data: { error: 'No active YouTube tab found. Try refreshing.' },
          });
          broadcastToSidePanel({ type: 'ARCHIVE_STEP_UPDATE', data: { archiveSteps } });
        }
      } else if (!token) {
        console.log('[YT Archiver SW] START_COMMENTS_FETCH: no comments token available');
      }
      break;
    }

    // From side panel: stop comments fetch
    case 'STOP_COMMENTS_FETCH':
      commentsFetchState = regularComments.length > 0 ? 'complete' : 'idle';
      archiveSteps.comments = regularComments.length > 0 ? 'complete' : 'pending';
      if (activeTabId) {
        chrome.tabs.sendMessage(activeTabId, { type: 'STOP_COMMENTS_FETCH' }).catch(() => {});
      }
      saveState();
      broadcastToSidePanel({ type: 'ARCHIVE_STEP_UPDATE', data: { archiveSteps } });
      sendResponse({ status: 'ok' });
      break;

    // From content script: batch of comments received
    case 'COMMENTS_PAGE_RESULT':
      if (message.data?.comments?.length > 0) {
        regularComments.push(...message.data.comments);
        commentsFetchProgress = {
          topLevel: message.data.topLevel || commentsFetchProgress.topLevel,
          replies: message.data.replies || commentsFetchProgress.replies,
        };
        broadcastToSidePanel({
          type: 'COMMENTS_PROGRESS',
          data: {
            commentCount: regularComments.length,
            topLevel: commentsFetchProgress.topLevel,
            replies: commentsFetchProgress.replies,
          },
        });
        if (regularComments.length % 500 < message.data.comments.length) {
          saveState();
        }
      }
      sendResponse({ status: 'ok' });
      break;

    // From content script: comments fetching complete
    case 'COMMENTS_FETCH_DONE':
      commentsFetchState = 'complete';
      archiveSteps.comments = 'complete';
      commentsFetchProgress = {
        topLevel: message.data?.topLevel || commentsFetchProgress.topLevel,
        replies: message.data?.replies || commentsFetchProgress.replies,
      };
      saveState();
      broadcastToSidePanel({
        type: 'COMMENTS_FETCH_COMPLETE',
        data: { commentCount: regularComments.length, ...commentsFetchProgress },
      });
      broadcastToSidePanel({ type: 'ARCHIVE_STEP_UPDATE', data: { archiveSteps } });
      // If archiving, move to next step
      if (isArchiving) continueArchive('comments');
      sendResponse({ status: 'ok' });
      break;

    // From content script: comments fetch error
    case 'COMMENTS_FETCH_ERROR':
      commentsFetchState = 'error';
      archiveSteps.comments = regularComments.length > 0 ? 'complete' : 'error';
      saveState();
      broadcastToSidePanel({
        type: 'COMMENTS_FETCH_ERROR_MSG',
        data: {
          error: message.data?.error || 'Unknown error',
          commentCount: regularComments.length,
        },
      });
      broadcastToSidePanel({ type: 'ARCHIVE_STEP_UPDATE', data: { archiveSteps } });
      if (isArchiving) continueArchive('comments');
      sendResponse({ status: 'ok' });
      break;

    case 'COMMENTS_RATE_LIMITED':
      broadcastToSidePanel({ type: 'COMMENTS_RATE_LIMITED' });
      sendResponse({ status: 'ok' });
      break;

    // From content script: batch of chat messages received
    case 'FETCH_PAGE_RESULT':
      if (message.data?.messages?.length > 0) {
        chatMessages.push(...message.data.messages);
        fetchProgress.current = chatMessages.length;

        broadcastToSidePanel({
          type: 'FETCH_PROGRESS',
          data: {
            messageCount: chatMessages.length,
            lastMessages: message.data.messages.slice(-5),
          },
        });

        if (chatMessages.length % 500 < message.data.messages.length) {
          saveState();
        }
      }
      sendResponse({ status: 'ok' });
      break;

    // From content script: chat fetching complete
    case 'FETCH_PAGE_DONE':
      fetchState = 'complete';
      archiveSteps.liveChat = 'complete';
      saveState();
      broadcastToSidePanel({
        type: 'FETCH_COMPLETE',
        data: { messageCount: chatMessages.length },
      });
      broadcastToSidePanel({ type: 'ARCHIVE_STEP_UPDATE', data: { archiveSteps } });
      if (isArchiving) continueArchive('liveChat');
      sendResponse({ status: 'ok' });
      break;

    // From content script: chat fetch error
    case 'FETCH_PAGE_ERROR':
      fetchState = 'error';
      archiveSteps.liveChat = chatMessages.length > 0 ? 'complete' : 'error';
      saveState();
      broadcastToSidePanel({
        type: 'FETCH_ERROR',
        data: {
          error: message.data?.error || 'Unknown error',
          messageCount: chatMessages.length,
        },
      });
      broadcastToSidePanel({ type: 'ARCHIVE_STEP_UPDATE', data: { archiveSteps } });
      if (isArchiving) continueArchive('liveChat');
      sendResponse({ status: 'ok' });
      break;

    // From content script: rate limited
    case 'FETCH_PAGE_RATE_LIMITED':
      broadcastToSidePanel({
        type: 'FETCH_RATE_LIMITED',
        data: { messageCount: chatMessages.length },
      });
      sendResponse({ status: 'ok' });
      break;

    // ─── Export handlers ───
    case 'EXPORT_CSV':
      exportChatCSV(message.data?.filters);
      sendResponse({ status: 'ok' });
      break;

    case 'EXPORT_HTML':
      exportChatHTML(message.data?.theme, message.data?.filters);
      sendResponse({ status: 'ok' });
      break;

    case 'EXPORT_METADATA_CSV':
      exportMetadataCSV();
      sendResponse({ status: 'ok' });
      break;

    case 'EXPORT_COMMENTS_CSV':
      exportCommentsCSV();
      sendResponse({ status: 'ok' });
      break;

    case 'EXPORT_COMMENTS_HTML':
      exportCommentsHTML(message.data?.theme);
      sendResponse({ status: 'ok' });
      break;

    case 'EXPORT_YOUTUBE_CLONE':
      exportYouTubeClone(message.data?.theme);
      sendResponse({ status: 'ok' });
      break;

    case 'START_VIDEO_DOWNLOAD':
      downloadVideo();
      sendResponse({ status: 'ok' });
      break;

    case 'EXPORT_ALL':
      exportAll(message.data?.theme, message.data?.selected);
      sendResponse({ status: 'ok' });
      break;

    // From side panel: re-check page
    case 'CHECK_PAGE':
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          activeTabId = tabs[0].id;
          chrome.tabs.sendMessage(tabs[0].id, { type: 'CHECK_FOR_CHAT_REPLAY' }, () => {
            if (chrome.runtime.lastError) {
              broadcastToSidePanel({ type: 'NOT_YOUTUBE' });
            }
          });
        }
      });
      sendResponse({ status: 'ok' });
      break;

    case 'SCREENSHOT_PROGRESS':
      broadcastToSidePanel(message);
      sendResponse({ status: 'ok' });
      break;

    default:
      break;
  }
  } catch (e) {
    console.error('[YT Archiver SW] FATAL error handling', message?.type, ':', e);
    try { broadcastToSidePanel({ type: 'FETCH_ERROR', data: { error: 'Internal error: ' + e.message } }); } catch (_) {}
  }
}

function broadcastToSidePanel(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

// ─── Helpers ───

async function resolveActiveTab() {
  if (activeTabId) return activeTabId;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]) {
      activeTabId = tabs[0].id;
      return activeTabId;
    }
  } catch (e) {
    console.error('[YT Archiver] resolveActiveTab error:', e);
  }
  return null;
}

// ─── Archive Orchestration ───

async function startFullArchive() {
  isArchiving = true;

  // Ensure we have an active tab
  await resolveActiveTab();
  console.log('[YT Archiver] startFullArchive: activeTabId=', activeTabId, 'videoData=', !!currentVideoData);

  // Re-detect video data from the page to ensure fresh tokens and metadata
  if (activeTabId) {
    try {
      console.log('[YT Archiver] startFullArchive: re-detecting video data...');
      await chrome.tabs.sendMessage(activeTabId, { type: 'CHECK_FOR_CHAT_REPLAY' });
      // Wait for the content script to process and send back VIDEO_PAGE_DETECTED
      await new Promise(resolve => setTimeout(resolve, 2500));
      console.log('[YT Archiver] startFullArchive: re-detection complete, videoData=', !!currentVideoData,
        'comments token:', !!currentVideoData?.commentsContinuationToken,
        'chat token:', !!currentVideoData?.chatContinuationToken,
        'hasStreams:', !!currentVideoData?.hasStreams);
    } catch (e) {
      console.warn('[YT Archiver] startFullArchive: re-detection failed, proceeding with existing data:', e.message);
    }
  }

  // Reset all steps for fresh archive (supports Re-Archive)
  chatMessages = [];
  regularComments = [];
  fetchState = 'idle';
  fetchProgress = { current: 0, total: 0 };
  commentsFetchState = 'idle';
  commentsFetchProgress = { topLevel: 0, replies: 0 };
  if (nativeDownloadPort) {
    nativeDownloadPort.disconnect();
    nativeDownloadPort = null;
  }

  archiveSteps = {
    metadata: videoMetadata && Object.keys(videoMetadata).length > 0 ? 'complete' : 'skipped',
    comments: currentVideoData?.commentsContinuationToken ? 'pending' : 'skipped',
    liveChat: currentVideoData?.chatContinuationToken ? 'pending' : 'skipped',
    video: currentVideoData?.hasStreams ? 'pending' : 'skipped',
  };
  broadcastToSidePanel({ type: 'ARCHIVE_STEP_UPDATE', data: { archiveSteps } });

  // Step 2: Start comments fetch
  if (archiveSteps.comments === 'pending' && activeTabId) {
    commentsFetchState = 'fetching';
    archiveSteps.comments = 'fetching';
    broadcastToSidePanel({ type: 'ARCHIVE_STEP_UPDATE', data: { archiveSteps } });

    chrome.tabs.sendMessage(activeTabId, {
      type: 'START_COMMENTS_FETCH',
      continuation: currentVideoData.commentsContinuationToken,
    }).catch(() => {
      archiveSteps.comments = 'error';
      broadcastToSidePanel({ type: 'ARCHIVE_STEP_UPDATE', data: { archiveSteps } });
      if (isArchiving) continueArchive('comments');
    });
  } else if (archiveSteps.comments !== 'skipped') {
    // No tab available
    archiveSteps.comments = 'error';
    broadcastToSidePanel({ type: 'ARCHIVE_STEP_UPDATE', data: { archiveSteps } });
    continueArchive('comments');
  } else {
    // Comments skipped, move to next step
    continueArchive('comments');
  }
}

async function continueArchive(completedStep) {
  console.log('[YT Archiver] continueArchive:', completedStep);

  // After comments complete, start live chat
  if (completedStep === 'comments') {
    const token = currentVideoData?.chatContinuationToken;
    const tabId = await resolveActiveTab();
    if (archiveSteps.liveChat === 'pending' && token && tabId) {
      fetchState = 'fetching';
      chatMessages = [];
      fetchProgress = { current: 0, total: 0 };
      archiveSteps.liveChat = 'fetching';
      broadcastToSidePanel({ type: 'FETCH_STARTED' });
      broadcastToSidePanel({ type: 'ARCHIVE_STEP_UPDATE', data: { archiveSteps } });

      chrome.tabs.sendMessage(tabId, {
        type: 'START_FETCH_FROM_CONTENT',
        continuation: token,
      }).catch(() => {
        archiveSteps.liveChat = 'error';
        broadcastToSidePanel({ type: 'ARCHIVE_STEP_UPDATE', data: { archiveSteps } });
        checkArchiveComplete();
      });
    } else if (archiveSteps.liveChat === 'pending') {
      archiveSteps.liveChat = 'skipped';
      broadcastToSidePanel({ type: 'ARCHIVE_STEP_UPDATE', data: { archiveSteps } });
      checkArchiveComplete();
    } else {
      checkArchiveComplete();
    }
  }

  if (completedStep === 'liveChat') {
    // Start video download after comments+chat are done (so comment count in folder name is accurate)
    if (archiveSteps.video === 'pending' && currentVideoData?.hasStreams) {
      downloadVideo();
    }
    checkArchiveComplete();
  }
}

function checkArchiveComplete() {
  const steps = Object.values(archiveSteps);
  const allDone = steps.every(s => s === 'complete' || s === 'skipped' || s === 'error');
  if (allDone) {
    isArchiving = false;
    broadcastToSidePanel({ type: 'ARCHIVE_COMPLETE', data: { archiveSteps } });
  }
}

async function stopAllFetching() {
  isArchiving = false;
  const tabId = await resolveActiveTab();

  // Stop chat
  if (fetchState === 'fetching') {
    fetchState = 'stopped';
    archiveSteps.liveChat = chatMessages.length > 0 ? 'complete' : 'pending';
    if (tabId) {
      chrome.tabs.sendMessage(tabId, { type: 'STOP_FETCH_FROM_CONTENT' }).catch(() => {});
    }
  }

  // Stop comments
  if (commentsFetchState === 'fetching') {
    commentsFetchState = regularComments.length > 0 ? 'complete' : 'idle';
    archiveSteps.comments = regularComments.length > 0 ? 'complete' : 'pending';
    if (tabId) {
      chrome.tabs.sendMessage(tabId, { type: 'STOP_COMMENTS_FETCH' }).catch(() => {});
    }
  }

  // Stop video download
  if (nativeDownloadPort) {
    nativeDownloadPort.disconnect();
    nativeDownloadPort = null;
    archiveSteps.video = 'pending';
  }

  saveState();
  broadcastToSidePanel({ type: 'ARCHIVE_STOPPED', data: { archiveSteps } });
  broadcastToSidePanel({ type: 'ARCHIVE_STEP_UPDATE', data: { archiveSteps } });
}

// ─── Video Download (via yt-dlp native messaging) ───

function downloadVideo() {
  // Guard against duplicate downloads
  if (archiveSteps.video === 'downloading' && nativeDownloadPort) {
    console.log('[YT Archiver] Download already in progress, skipping');
    return;
  }

  const videoId = currentVideoData?.videoId;
  if (!videoId) {
    archiveSteps.video = 'error';
    broadcastToSidePanel({ type: 'ARCHIVE_STEP_UPDATE', data: { archiveSteps } });
    broadcastToSidePanel({ type: 'VIDEO_DOWNLOAD_ERROR', data: { error: 'No video ID found.' } });
    return;
  }

  archiveSteps.video = 'downloading';
  broadcastToSidePanel({ type: 'ARCHIVE_STEP_UPDATE', data: { archiveSteps } });

  const prefix = buildFolderPrefix();
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  try {
    const port = chrome.runtime.connectNative('com.ytarchiver.downloader');
    nativeDownloadPort = port;

    port.onMessage.addListener((message) => {
      console.log('[YT Archiver] yt-dlp:', message.type, message.percent || message.message || '');
      switch (message.type) {
        case 'progress':
          broadcastToSidePanel({
            type: 'VIDEO_DOWNLOAD_PROGRESS',
            data: {
              percent: message.percent,
              speed: message.speed,
              eta: message.eta,
              totalSize: message.totalSize,
            },
          });
          break;
        case 'status':
          // Status messages (merging, starting, etc.)
          break;
        case 'complete':
          archiveSteps.video = 'complete';
          saveState();
          broadcastToSidePanel({ type: 'ARCHIVE_STEP_UPDATE', data: { archiveSteps } });
          broadcastToSidePanel({ type: 'VIDEO_DOWNLOAD_COMPLETE', data: { files: message.files } });
          nativeDownloadPort = null;
          if (isArchiving) checkArchiveComplete();
          break;
        case 'error':
          archiveSteps.video = 'error';
          broadcastToSidePanel({ type: 'ARCHIVE_STEP_UPDATE', data: { archiveSteps } });
          broadcastToSidePanel({ type: 'VIDEO_DOWNLOAD_ERROR', data: { error: message.message } });
          nativeDownloadPort = null;
          if (isArchiving) checkArchiveComplete();
          break;
      }
    });

    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      if (err && archiveSteps.video === 'downloading') {
        console.error('[YT Archiver] Native host disconnected:', err.message);
        archiveSteps.video = 'error';
        broadcastToSidePanel({ type: 'ARCHIVE_STEP_UPDATE', data: { archiveSteps } });
        broadcastToSidePanel({
          type: 'VIDEO_DOWNLOAD_ERROR',
          data: { error: 'yt-dlp host error: ' + err.message + '. Run install_host.sh to set up.' },
        });
        if (isArchiving) checkArchiveComplete();
      }
      nativeDownloadPort = null;
    });

    // Send download command
    port.postMessage({
      action: 'download',
      videoUrl,
      outputDir: `~/Downloads/YT-Archive/${prefix}`,
      title: prefix,
      maxQuality: '1080',
    });

  } catch (err) {
    console.error('[YT Archiver] Video download error:', err);
    archiveSteps.video = 'error';
    broadcastToSidePanel({ type: 'ARCHIVE_STEP_UPDATE', data: { archiveSteps } });
    broadcastToSidePanel({
      type: 'VIDEO_DOWNLOAD_ERROR',
      data: { error: err.message || 'Failed to connect to yt-dlp host.' },
    });
  }
}

// ─── Export Functions ───

function filterMessages(filters) {
  if (!filters || filters.length === 0) return chatMessages;
  return chatMessages.filter((msg) => filters.includes(msg.message_type));
}

function archiveFilename(suffix) {
  const prefix = buildFolderPrefix();
  return `YT-Archive/${prefix}/${prefix}_${suffix}`;
}

function downloadBlob(content, mimeType, filename) {
  console.log('[YT Archiver SW] downloadBlob:', filename, 'size:', content.length);
  // MV3 service workers don't support URL.createObjectURL — use data URL instead
  const encoder = new TextEncoder();
  const bytes = encoder.encode(content);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  const base64 = btoa(binary);
  const dataUrl = `data:${mimeType};base64,${base64}`;
  chrome.downloads.download({ url: dataUrl, filename, saveAs: false }, (downloadId) => {
    if (chrome.runtime.lastError) {
      console.error('[YT Archiver SW] Download failed:', chrome.runtime.lastError.message);
    } else {
      console.log('[YT Archiver SW] Download started:', downloadId, filename);
    }
  });
}

function escapeCSVField(val) {
  const str = String(val ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

// ─── Metadata CSV ───

function exportMetadataCSV() {
  if (!videoMetadata) return;

  let csv = '\uFEFF';
  csv += 'Field,Value\n';

  const fields = [
    'videoId', 'title', 'author', 'channelId', 'publishDate', 'uploadDate',
    'description', 'category', 'lengthSeconds', 'viewCount', 'viewCountText',
    'likeCount', 'subscriberCount', 'dateText', 'keywords',
    'isFamilySafe', 'isUnlisted', 'isLiveContent', 'thumbnail',
    'ownerChannelName', 'ownerProfileUrl', 'externalChannelId', 'channelAvatar',
  ];

  for (const field of fields) {
    if (videoMetadata[field] !== undefined && videoMetadata[field] !== '') {
      csv += `${escapeCSVField(field)},${escapeCSVField(videoMetadata[field])}\n`;
    }
  }

  const filename = archiveFilename('metadata.csv');
  downloadBlob(csv, 'text/csv;charset=utf-8', filename);
}

// ─── Chat CSV ───

function exportChatCSV(filters) {
  const messages = filterMessages(filters);
  const headers = [
    'timestamp_ms', 'timestamp_text', 'author_name', 'author_channel_id',
    'author_profile_image', 'message', 'message_type', 'is_owner',
    'is_moderator', 'is_member', 'is_verified', 'badges', 'superchat_amount',
  ];

  let csv = '\uFEFF';
  csv += headers.join(',') + '\n';
  for (const msg of messages) {
    csv += headers.map((h) => escapeCSVField(msg[h])).join(',') + '\n';
  }

  const filename = archiveFilename('live_chat.csv');
  downloadBlob(csv, 'text/csv;charset=utf-8', filename);
}

// ─── Comments CSV ───

function exportCommentsCSV() {
  const headers = [
    'comment_id', 'parent_comment_id', 'author_display_name', 'author_channel_id',
    'author_profile_image', 'text', 'published_time_text', 'like_count',
    'reply_count', 'is_channel_owner', 'is_pinned', 'is_hearted',
  ];

  let csv = '\uFEFF';
  csv += headers.join(',') + '\n';
  for (const c of regularComments) {
    csv += headers.map((h) => escapeCSVField(c[h])).join(',') + '\n';
  }

  const filename = archiveFilename('comments.csv');
  downloadBlob(csv, 'text/csv;charset=utf-8', filename);
}

// ─── Chat HTML (existing, refactored) ───

async function exportChatHTML(theme = 'dark', filters) {
  const messages = filterMessages(filters);
  const title = currentVideoData?.title || 'Chat Replay';
  const channelName = currentVideoData?.channelName || '';
  const h2cSrc = await html2canvasSrcPromise;
  const html = generateChatHTML(messages, title, channelName, theme, h2cSrc);
  const filename = archiveFilename(`live_chat_${theme}.html`);
  downloadBlob(html, 'text/html;charset=utf-8', filename);
}

// ─── Comments HTML ───

async function exportCommentsHTML(theme = 'dark') {
  const title = currentVideoData?.title || 'Comments';
  const channelName = currentVideoData?.channelName || '';
  const h2cSrc = await html2canvasSrcPromise;
  const html = generateCommentsHTML(regularComments, title, channelName, theme, h2cSrc);
  const filename = archiveFilename(`comments_${theme}.html`);
  downloadBlob(html, 'text/html;charset=utf-8', filename);
}

// ─── YouTube Clone HTML ───

async function exportYouTubeClone(theme = 'dark') {
  const h2cSrc = await html2canvasSrcPromise;
  const html = generateYouTubeCloneHTML(theme, h2cSrc);
  const filename = archiveFilename('archive.html');
  downloadBlob(html, 'text/html;charset=utf-8', filename);
}

// ─── Comment Screenshots (via offscreen document → zip) ───

async function exportCommentScreenshots(theme = 'dark') {
  if (regularComments.length === 0 && chatMessages.length === 0) {
    broadcastToSidePanel({ type: 'SCREENSHOT_ERROR', data: { error: 'No comments or chat messages to screenshot.' } });
    return;
  }

  // Signal start so panel shows progress bar
  broadcastToSidePanel({ type: 'SCREENSHOT_PROGRESS', data: { current: 0, total: 0 } });

  const prefix = buildFolderPrefix();

  // Build regular comment threads for rendering
  const topLevel = regularComments.filter(x => !x.parent_comment_id);
  const repliesByParent = {};
  for (const r of regularComments.filter(x => x.parent_comment_id)) {
    if (!repliesByParent[r.parent_comment_id]) repliesByParent[r.parent_comment_id] = [];
    repliesByParent[r.parent_comment_id].push(r);
  }
  const comments = topLevel.map(cm => ({
    id: cm.comment_id,
    a: cm.author_display_name,
    img: cm.author_profile_image,
    t: cm.text,
    time: cm.published_time_text,
    fat: cm.fetched_at_ms || Date.now(),
    likes: cm.like_count,
    rc: cm.reply_count,
    own: cm.is_channel_owner,
    pin: cm.is_pinned,
    heart: cm.is_hearted,
    replies: (repliesByParent[cm.comment_id] || []).map(r => ({
      id: r.comment_id,
      a: r.author_display_name,
      img: r.author_profile_image,
      t: r.text,
      time: r.published_time_text,
      fat: r.fetched_at_ms || Date.now(),
      likes: r.like_count,
      own: r.is_channel_owner,
      heart: r.is_hearted,
    })),
  }));

  // Build live chat messages for rendering
  const chat = chatMessages.map(m => ({
    id: String(m.timestamp_ms || ''),
    ts: m.timestamp_text,
    a: m.author_name,
    m: m.message,
    t: m.message_type,
    o: m.is_owner,
    mod: m.is_moderator,
    mem: m.is_member,
    v: m.is_verified,
    sc: m.superchat_amount,
    img: m.author_profile_image,
  }));

  // Create offscreen document
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['DOM_PARSER'],
      justification: 'Render comment screenshots with html2canvas',
    });
  } catch (e) {
    // Already exists — that's fine
    if (!e.message?.includes('already exists')) {
      broadcastToSidePanel({ type: 'FETCH_ERROR', data: { error: 'Failed to create offscreen document: ' + e.message } });
      return;
    }
  }

  try {
    const result = await chrome.runtime.sendMessage({
      type: 'RENDER_COMMENT_SCREENSHOTS',
      data: { comments, chat, theme, folderPrefix: prefix, dateStr: getVideoDateStr() },
    });

    if (result?.error) {
      broadcastToSidePanel({ type: 'SCREENSHOT_ERROR', data: { error: 'Screenshot rendering failed: ' + result.error } });
      return;
    }

    if (result?.base64) {
      const filename = archiveFilename('comment_screenshots.zip');
      const dataUrl = 'data:application/zip;base64,' + result.base64;
      chrome.downloads.download({ url: dataUrl, filename, saveAs: false }, (downloadId) => {
        if (chrome.runtime.lastError) {
          console.error('[YT Archiver] Screenshot zip download failed:', chrome.runtime.lastError.message);
          broadcastToSidePanel({ type: 'SCREENSHOT_ERROR', data: { error: 'Download failed: ' + chrome.runtime.lastError.message } });
        } else {
          console.log('[YT Archiver] Screenshot zip downloaded:', downloadId, filename);
          broadcastToSidePanel({ type: 'SCREENSHOT_COMPLETE' });
        }
      });
    }
  } catch (e) {
    console.error('[YT Archiver] exportCommentScreenshots error:', e);
    broadcastToSidePanel({ type: 'SCREENSHOT_ERROR', data: { error: 'Screenshot export failed: ' + e.message } });
  } finally {
    chrome.offscreen.closeDocument().catch(() => {});
  }
}

// ─── Export All ───

async function exportAll(theme = 'dark', selected = {}) {
  console.log('[YT Archiver] exportAll called, selected:', JSON.stringify(selected), 'theme:', theme,
    '| metadata keys:', videoMetadata ? Object.keys(videoMetadata).length : 0,
    '| comments:', regularComments.length,
    '| chat:', chatMessages.length);

  let exportCount = 0;
  const skipped = [];

  try {
    if (selected.metadataCSV) {
      if (videoMetadata && Object.keys(videoMetadata).length > 0) {
        exportMetadataCSV();
        exportCount++;
      } else {
        skipped.push('Metadata CSV (no metadata available)');
      }
    }
    if (selected.commentsCSV) {
      if (regularComments.length > 0) {
        exportCommentsCSV();
        exportCount++;
      } else {
        skipped.push('Comments CSV (no comments fetched)');
      }
    }
    if (selected.commentsHTML) {
      if (regularComments.length > 0) {
        await exportCommentsHTML(theme);
        exportCount++;
      } else {
        skipped.push('Comments HTML (no comments fetched)');
      }
    }
    if (selected.liveChatCSV) {
      if (chatMessages.length > 0) {
        exportChatCSV([]);
        exportCount++;
      } else {
        skipped.push('Live Chat CSV (no chat messages)');
      }
    }
    if (selected.liveChatHTML) {
      if (chatMessages.length > 0) {
        await exportChatHTML(theme, []);
        exportCount++;
      } else {
        skipped.push('Live Chat HTML (no chat messages)');
      }
    }
    if (selected.youtubeClone) {
      await exportYouTubeClone(theme);
      exportCount++;
    }
    if (selected.commentScreenshots) {
      if (regularComments.length > 0 || chatMessages.length > 0) {
        await exportCommentScreenshots(theme);
        exportCount++;
      } else {
        skipped.push('Screenshots (no comments or chat messages)');
      }
    }
  } catch (e) {
    console.error('[YT Archiver] exportAll error:', e);
    broadcastToSidePanel({ type: 'FETCH_ERROR', data: { error: 'Export error: ' + e.message } });
    return;
  }

  if (exportCount === 0 && skipped.length > 0) {
    broadcastToSidePanel({
      type: 'FETCH_ERROR',
      data: { error: 'Nothing to export. ' + skipped.join('; ') },
    });
  }
  console.log('[YT Archiver] exportAll done: exported', exportCount, 'skipped:', skipped);
}

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*'`!\x00-\x1f]/g, '_').replace(/\s+/g, '_').substring(0, 200);
}

function getVideoDateStr() {
  let dateStr = 'unknown';
  const pd = videoMetadata?.publishDate || videoMetadata?.uploadDate;
  if (pd) {
    const match = pd.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (match) dateStr = match[1] + match[2] + match[3];
  }
  if (dateStr === 'unknown' && videoMetadata?.dateText) {
    const dt = new Date(videoMetadata.dateText);
    if (!isNaN(dt.getTime())) {
      dateStr = dt.getFullYear() + String(dt.getMonth() + 1).padStart(2, '0') + String(dt.getDate()).padStart(2, '0');
    }
  }
  return dateStr;
}

function buildFolderPrefix() {
  const videoId = currentVideoData?.videoId || 'unknown';
  const rawTitle = currentVideoData?.title || videoMetadata?.title || videoId;
  const title = sanitizeFilename(rawTitle).substring(0, 80);
  const rawUploader = videoMetadata?.author || videoMetadata?.ownerChannelName || currentVideoData?.channelName || 'unknown';
  const uploader = sanitizeFilename(rawUploader).substring(0, 40);
  const dateStr = getVideoDateStr();
  const commentCount = regularComments.length;
  return `YT_${title}_${videoId}_${uploader}_${dateStr}_${commentCount}`;
}

// ─── HTML Generators ───

function esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function getThemeColors(theme) {
  const isDark = theme === 'dark';
  return {
    isDark,
    bgColor: isDark ? '#0f0f0f' : '#ffffff',
    textColor: isDark ? '#ffffff' : '#0f0f0f',
    secondaryText: isDark ? '#aaaaaa' : '#606060',
    messageBg: isDark ? '#272727' : '#f2f2f2',
    borderColor: isDark ? '#3f3f3f' : '#e0e0e0',
    headerBg: isDark ? '#212121' : '#f9f9f9',
    cardBg: isDark ? '#1a1a1a' : '#f9f9f9',
    inputBg: isDark ? '#272727' : '#f2f2f2',
    accentColor: '#3ea6ff',
    barBg: isDark ? '#333333' : '#e0e0e0',
  };
}

function generateChatHTML(messages, title, channelName, theme, h2cSrc) {
  const c = getThemeColors(theme);
  const totalMessages = messages.length;
  const typeCounts = { text: 0, superchat: 0, membership: 0, supersticker: 0 };
  const authorCounts = {};
  const timelineBuckets = {};
  let totalSuperChatValue = 0;
  let superChatCount = 0;
  let uniqueAuthors = new Set();
  let maxTimestampMs = 0;

  for (const msg of messages) {
    typeCounts[msg.message_type] = (typeCounts[msg.message_type] || 0) + 1;
    authorCounts[msg.author_name] = (authorCounts[msg.author_name] || 0) + 1;
    uniqueAuthors.add(msg.author_name);
    if (msg.timestamp_ms > maxTimestampMs) maxTimestampMs = msg.timestamp_ms;
    const bucketMin = Math.floor(Math.max(0, msg.timestamp_ms) / 300000) * 5;
    timelineBuckets[bucketMin] = (timelineBuckets[bucketMin] || 0) + 1;
    if (msg.message_type === 'superchat' || msg.message_type === 'supersticker') {
      superChatCount++;
      const amount = parseFloat(String(msg.superchat_amount).replace(/[^0-9.]/g, ''));
      if (!isNaN(amount)) totalSuperChatValue += amount;
    }
  }

  const topChatters = Object.entries(authorCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const topChatterMax = topChatters.length > 0 ? topChatters[0][1] : 1;

  const timelineEntries = Object.entries(timelineBuckets).map(([min, count]) => [parseInt(min), count]).sort((a, b) => a[0] - b[0]);
  const timelineMax = timelineEntries.length > 0 ? Math.max(...timelineEntries.map(e => e[1])) : 1;

  const durationSec = Math.floor(maxTimestampMs / 1000);
  const durH = Math.floor(durationSec / 3600);
  const durM = Math.floor((durationSec % 3600) / 60);
  const durationStr = durH > 0 ? `${durH}h ${durM}m` : `${durM}m`;

  const scMsg = messages.find(m => m.superchat_amount);
  const currencySymbol = scMsg ? String(scMsg.superchat_amount).replace(/[0-9.,\s]/g, '').trim() || '$' : '$';

  const topChattersHTML = topChatters.map(([name, count]) => {
    const pct = Math.round((count / topChatterMax) * 100);
    return `<div class="chatter-row"><span class="chatter-name">${esc(name)}</span><div class="chatter-bar-wrap"><div class="chatter-bar" style="width:${pct}%"></div></div><span class="chatter-count">${count}</span></div>`;
  }).join('');

  const timelineHTML = timelineEntries.map(([min, count]) => {
    const pct = Math.round((count / timelineMax) * 100);
    const h = Math.floor(min / 60);
    const m = min % 60;
    const label = h > 0 ? `${h}:${String(m).padStart(2,'0')}` : `${m}m`;
    return `<div class="tl-bar-wrap" title="${label}: ${count} msgs"><div class="tl-bar" style="height:${pct}%"></div><div class="tl-label">${label}</div></div>`;
  }).join('');

  // Build messages as JSON for pagination
  const messagesJSON = JSON.stringify(messages.map(msg => ({
    id: String(msg.timestamp_ms || ''),
    ts: msg.timestamp_text,
    a: msg.author_name,
    m: msg.message,
    t: msg.message_type,
    o: msg.is_owner,
    mod: msg.is_moderator,
    mem: msg.is_member,
    v: msg.is_verified,
    sc: msg.superchat_amount,
    img: msg.author_profile_image,
  })));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)} - Chat Replay</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Roboto','YouTube Sans',Arial,sans-serif;background:${c.bgColor};color:${c.textColor};line-height:1.4}
.header{background:${c.headerBg};border-bottom:1px solid ${c.borderColor};padding:16px 20px;position:sticky;top:0;z-index:10}
.header h1{font-size:18px;font-weight:500;margin-bottom:4px}
.header .meta{font-size:12px;color:${c.secondaryText}}
.tabs{display:flex;gap:0;border-bottom:1px solid ${c.borderColor};background:${c.headerBg};position:sticky;top:56px;z-index:9}
.tab{padding:10px 24px;cursor:pointer;font-size:14px;font-weight:500;color:${c.secondaryText};border-bottom:2px solid transparent;transition:all .2s;user-select:none}
.tab:hover{color:${c.textColor}}
.tab.active{color:${c.accentColor};border-bottom-color:${c.accentColor}}
.tab-content{display:none}
.tab-content.active{display:block}
.search-bar{max-width:800px;margin:16px auto;padding:0 20px;display:flex;gap:8px;align-items:center}
.search-bar input{flex:1;padding:10px 16px;border-radius:20px;border:1px solid ${c.borderColor};background:${c.inputBg};color:${c.textColor};font-size:14px;outline:none}
.search-bar input:focus{border-color:${c.accentColor}}
.search-info{max-width:800px;margin:0 auto;padding:0 20px;font-size:12px;color:${c.secondaryText};min-height:20px}
.filter-chips{max-width:800px;margin:8px auto;padding:0 20px;display:flex;gap:6px;flex-wrap:wrap}
.chip{padding:4px 12px;border-radius:16px;font-size:12px;cursor:pointer;border:1px solid ${c.borderColor};background:transparent;color:${c.secondaryText};transition:all .2s;user-select:none}
.chip.active{background:${c.accentColor};color:#0f0f0f;border-color:${c.accentColor}}
.messages-container{max-width:800px;margin:0 auto}
.message{padding:8px 20px;display:flex;flex-direction:column}
.message.hidden{display:none}
.message:hover{background:${c.messageBg}}
.message-body{display:flex;align-items:flex-start;gap:12px}
.avatar{width:24px;height:24px;border-radius:50%;flex-shrink:0;margin-top:2px}
.avatar-placeholder{width:24px;height:24px;border-radius:50%;background:${c.secondaryText};flex-shrink:0;margin-top:2px}
.message-content{flex:1;min-width:0}
.timestamp{color:${c.secondaryText};font-size:11px;margin-right:8px}
.author{font-size:13px;font-weight:500;margin-right:4px}
.text{font-size:13px;word-break:break-word}
.badge{display:inline-block;font-size:10px;padding:1px 4px;border-radius:2px;margin-right:4px;font-weight:500;vertical-align:middle}
.badge.owner{background:#ffd600;color:#0f0f0f}
.badge.moderator{background:#5e84f1;color:#fff}
.badge.member{background:#2ba640;color:#fff}
.badge.verified{background:${c.secondaryText};color:${c.bgColor}}
.superchat{background:${c.isDark?'#1a3a1a':'#e8f5e9'};border-left:3px solid #ffd600;margin:4px 0;border-radius:4px;padding:12px 20px}
.superchat-amount{font-weight:700;color:#ffd600;font-size:14px;margin-bottom:4px}
.membership{background:${c.isDark?'#1a2a1a':'#e8f5e9'};border-left:3px solid #2ba640;margin:4px 0;border-radius:4px;padding:12px 20px}
.supersticker{background:${c.isDark?'#2a2a1a':'#fff8e1'};border-left:3px solid #ff6f00;margin:4px 0;border-radius:4px;padding:12px 20px}
.analytics{max-width:800px;margin:0 auto;padding:20px}
.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:24px}
.stat-card{background:${c.cardBg};border:1px solid ${c.borderColor};border-radius:12px;padding:16px;text-align:center}
.stat-value{font-size:28px;font-weight:700;color:${c.accentColor}}
.stat-label{font-size:12px;color:${c.secondaryText};margin-top:4px;text-transform:uppercase;letter-spacing:.5px}
.analytics-section{background:${c.cardBg};border:1px solid ${c.borderColor};border-radius:12px;padding:20px;margin-bottom:16px}
.analytics-section h3{font-size:14px;font-weight:500;margin-bottom:16px;color:${c.textColor}}
.type-bars{display:flex;flex-direction:column;gap:10px}
.type-row{display:flex;align-items:center;gap:12px}
.type-label{width:100px;font-size:13px;color:${c.secondaryText};text-align:right}
.type-bar-wrap{flex:1;height:24px;background:${c.barBg};border-radius:4px;overflow:hidden}
.type-bar{height:100%;border-radius:4px;display:flex;align-items:center;padding-left:8px;font-size:11px;font-weight:500;color:#fff;min-width:fit-content}
.type-bar.text-bar{background:${c.accentColor}}
.type-bar.superchat-bar{background:#ffd600;color:#0f0f0f}
.type-bar.membership-bar{background:#2ba640}
.type-bar.supersticker-bar{background:#ff6f00}
.type-count{width:60px;font-size:13px;color:${c.secondaryText}}
.chatter-row{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.chatter-name{width:140px;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right;color:${c.textColor}}
.chatter-bar-wrap{flex:1;height:20px;background:${c.barBg};border-radius:4px;overflow:hidden}
.chatter-bar{height:100%;background:${c.accentColor};border-radius:4px}
.chatter-count{width:40px;font-size:12px;color:${c.secondaryText}}
.timeline{display:flex;align-items:flex-end;gap:2px;height:120px;overflow-x:auto;padding-bottom:20px;position:relative}
.tl-bar-wrap{display:flex;flex-direction:column;align-items:center;flex:1;min-width:8px;max-width:24px;height:100%;justify-content:flex-end;position:relative}
.tl-bar{width:100%;background:${c.accentColor};border-radius:2px 2px 0 0;min-height:2px;transition:opacity .2s}
.tl-bar-wrap:hover .tl-bar{opacity:.7}
.tl-label{font-size:9px;color:${c.secondaryText};position:absolute;bottom:-16px;white-space:nowrap;display:none}
.tl-bar-wrap:nth-child(6n+1) .tl-label{display:block}
.screenshot-btn{cursor:pointer;opacity:0.5;transition:opacity .2s;background:none;border:none;font-size:14px;padding:2px 4px;color:${c.secondaryText};margin-left:auto}
.screenshot-btn:hover{opacity:1}
.load-more{text-align:center;padding:16px}
.load-more button{padding:8px 24px;border-radius:20px;border:1px solid ${c.borderColor};background:${c.inputBg};color:${c.textColor};cursor:pointer;font-size:13px}
</style>
</head>
<body>
<div class="header">
<h1>${esc(title)}</h1>
<div class="meta">${totalMessages.toLocaleString()} messages${channelName ? ' &bull; ' + esc(channelName) : ''} &bull; ${durationStr}</div>
</div>
<div class="tabs">
<div class="tab active" data-tab="chat">Chat</div>
<div class="tab" data-tab="analytics">Analytics</div>
</div>
<div class="tab-content active" id="tab-chat">
<div class="search-bar"><input type="text" id="searchInput" placeholder="Search messages or @username..." /><select id="sortSelect" style="padding:8px 12px;border-radius:20px;border:1px solid ${c.borderColor};background:${c.inputBg};color:${c.textColor};font-size:13px;cursor:pointer;outline:none"><option value="default">Default Order</option><option value="user">Sort by User</option></select></div>
<div class="filter-chips">
<div class="chip active" data-filter="all">All</div>
<div class="chip" data-filter="text">Text (${typeCounts.text.toLocaleString()})</div>
<div class="chip" data-filter="superchat">Super Chat (${(typeCounts.superchat||0).toLocaleString()})</div>
<div class="chip" data-filter="membership">Membership (${(typeCounts.membership||0).toLocaleString()})</div>
<div class="chip" data-filter="supersticker">Sticker (${(typeCounts.supersticker||0).toLocaleString()})</div>
</div>
<div class="search-info" id="searchInfo"></div>
<div class="messages-container" id="messagesContainer"></div>
<div class="load-more" id="loadMore" style="display:none"><button id="btnLoadMore">Load More</button></div>
</div>
<div class="tab-content" id="tab-analytics">
<div class="analytics">
<div class="stats-grid">
<div class="stat-card"><div class="stat-value">${totalMessages.toLocaleString()}</div><div class="stat-label">Total Messages</div></div>
<div class="stat-card"><div class="stat-value">${uniqueAuthors.size.toLocaleString()}</div><div class="stat-label">Unique Chatters</div></div>
<div class="stat-card"><div class="stat-value">${superChatCount}</div><div class="stat-label">Super Chats</div></div>
<div class="stat-card"><div class="stat-value">${totalSuperChatValue>0?currencySymbol+totalSuperChatValue.toFixed(2):'-'}</div><div class="stat-label">Super Chat Total</div></div>
<div class="stat-card"><div class="stat-value">${durationStr}</div><div class="stat-label">Duration</div></div>
<div class="stat-card"><div class="stat-value">${durationSec>0?(totalMessages/(durationSec/60)).toFixed(1):'0'}</div><div class="stat-label">Msgs / Minute</div></div>
</div>
<div class="analytics-section"><h3>Message Types</h3><div class="type-bars">
<div class="type-row"><span class="type-label">Text</span><div class="type-bar-wrap"><div class="type-bar text-bar" style="width:${totalMessages>0?Math.max(1,(typeCounts.text/totalMessages)*100):0}%">${typeCounts.text>0?Math.round((typeCounts.text/totalMessages)*100)+'%':''}</div></div><span class="type-count">${typeCounts.text.toLocaleString()}</span></div>
<div class="type-row"><span class="type-label">Super Chat</span><div class="type-bar-wrap"><div class="type-bar superchat-bar" style="width:${totalMessages>0?Math.max((typeCounts.superchat||0)>0?1:0,((typeCounts.superchat||0)/totalMessages)*100):0}%">${(typeCounts.superchat||0)>0?Math.round(((typeCounts.superchat||0)/totalMessages)*100)+'%':''}</div></div><span class="type-count">${(typeCounts.superchat||0).toLocaleString()}</span></div>
<div class="type-row"><span class="type-label">Membership</span><div class="type-bar-wrap"><div class="type-bar membership-bar" style="width:${totalMessages>0?Math.max((typeCounts.membership||0)>0?1:0,((typeCounts.membership||0)/totalMessages)*100):0}%">${(typeCounts.membership||0)>0?Math.round(((typeCounts.membership||0)/totalMessages)*100)+'%':''}</div></div><span class="type-count">${(typeCounts.membership||0).toLocaleString()}</span></div>
<div class="type-row"><span class="type-label">Sticker</span><div class="type-bar-wrap"><div class="type-bar supersticker-bar" style="width:${totalMessages>0?Math.max((typeCounts.supersticker||0)>0?1:0,((typeCounts.supersticker||0)/totalMessages)*100):0}%">${(typeCounts.supersticker||0)>0?Math.round(((typeCounts.supersticker||0)/totalMessages)*100)+'%':''}</div></div><span class="type-count">${(typeCounts.supersticker||0).toLocaleString()}</span></div>
</div></div>
<div class="analytics-section"><h3>Activity Over Time (5-min intervals)</h3><div class="timeline">${timelineHTML}</div></div>
<div class="analytics-section"><h3>Top 10 Chatters</h3>${topChattersHTML}</div>
</div>
</div>
<script>
(function(){
var allMessages=${messagesJSON};
var totalMessages=allMessages.length;
var videoDate=${JSON.stringify(getVideoDateStr())};
var PAGE_SIZE=500;
var currentPage=0;
var filtered=allMessages;
var activeFilter='all';
var searchTerm='';
var container=document.getElementById('messagesContainer');
var loadMoreDiv=document.getElementById('loadMore');

function escH(s){var d=document.createElement('div');d.textContent=s;return d.innerHTML}
function safeName(s){return s.replace(/[<>:"\\/|?*\\x00-\\x1f]/g,'_').replace(/\\s+/g,'_').substring(0,60)}
function pad4(n){return String(n).padStart(4,'0')}

function renderMessage(msg,idx){
var nameColor='${c.textColor}';
var badges='';
if(msg.o){nameColor='${c.isDark?"#ffd600":"#c69000"}';badges+='<span class="badge owner">Owner</span>';}
if(msg.mod){nameColor='${c.isDark?"#5e84f1":"#2962ff"}';badges+='<span class="badge moderator">Mod</span>';}
if(msg.mem){badges+='<span class="badge member">Member</span>';}
if(msg.v){badges+='<span class="badge verified">&#10003;</span>';}
var cls='message';var scHeader='';
if(msg.t==='superchat'){cls+=' superchat';scHeader='<div class="superchat-amount">'+escH(msg.sc)+'</div>';}
else if(msg.t==='membership'){cls+=' membership';}
else if(msg.t==='supersticker'){cls+=' supersticker';scHeader='<div class="superchat-amount">'+escH(msg.sc)+'</div>';}
var img=msg.img?'<img class="avatar" src="'+escH(msg.img)+'" alt="" loading="lazy" />':'<div class="avatar-placeholder"></div>';
var ssBtn=${h2cSrc ? "'<button class=\"screenshot-btn\" title=\"Screenshot\" onclick=\"screenshotChat(this)\">&#128247;</button>'" : "''"};
return '<div class="'+cls+'" data-msg-id="'+escH(msg.id)+'" data-author="'+escH(msg.a)+'" data-idx="'+idx+'">'+scHeader+'<div class="message-body">'+img+'<div class="message-content"><span class="timestamp">'+escH(msg.ts)+'</span><span class="author" style="color:'+nameColor+'">'+escH(msg.a)+'</span>'+badges+'<span class="text">'+escH(msg.m)+'</span>'+ssBtn+'</div></div></div>';
}

var currentSort='default';
function applyFilters(){
searchTerm=document.getElementById('searchInput').value.toLowerCase().trim();
var isAuthor=searchTerm.startsWith('@');
var term=isAuthor?searchTerm.slice(1):searchTerm;
filtered=allMessages.filter(function(msg){
var matchType=activeFilter==='all'||msg.t===activeFilter;
var matchSearch=true;
if(term){
if(isAuthor){matchSearch=msg.a.toLowerCase().indexOf(term)!==-1;}
else{matchSearch=msg.m.toLowerCase().indexOf(term)!==-1||msg.a.toLowerCase().indexOf(term)!==-1;}
}
return matchType&&matchSearch;
});
if(currentSort==='user'){filtered.sort(function(a,b){return a.a.toLowerCase().localeCompare(b.a.toLowerCase());});}
currentPage=0;
container.innerHTML='';
renderPage();
var info=(searchTerm||activeFilter!=='all'||currentSort!=='default')?'Showing '+filtered.length.toLocaleString()+' of '+allMessages.length.toLocaleString()+' messages':'';
if(currentSort!=='default'&&info)info+=' (sorted by user)';
document.getElementById('searchInfo').textContent=info;
}

function renderPage(){
var start=currentPage*PAGE_SIZE;
var end=Math.min(start+PAGE_SIZE,filtered.length);
var html='';
for(var i=start;i<end;i++){html+=renderMessage(filtered[i],i);}
container.insertAdjacentHTML('beforeend',html);
currentPage++;
loadMoreDiv.style.display=end<filtered.length?'block':'none';
}

renderPage();

document.getElementById('btnLoadMore').addEventListener('click',renderPage);
document.getElementById('searchInput').addEventListener('input',applyFilters);
document.getElementById('sortSelect').addEventListener('change',function(){currentSort=this.value;applyFilters();});
document.querySelectorAll('.chip').forEach(function(chip){
chip.addEventListener('click',function(){
document.querySelectorAll('.chip').forEach(function(c){c.classList.remove('active');});
chip.classList.add('active');
activeFilter=chip.dataset.filter;
applyFilters();
});
});
document.querySelectorAll('.tab').forEach(function(tab){
tab.addEventListener('click',function(){
document.querySelectorAll('.tab').forEach(function(t){t.classList.remove('active');});
document.querySelectorAll('.tab-content').forEach(function(tc){tc.classList.remove('active');});
tab.classList.add('active');
document.getElementById('tab-'+tab.dataset.tab).classList.add('active');
});
});
${h2cSrc ? `
window.screenshotChat=function(btn){
var msgEl=btn.closest('.message');
if(!msgEl||typeof html2canvas==='undefined')return;
var allBtns=msgEl.querySelectorAll('.screenshot-btn');
allBtns.forEach(function(b){b.style.display='none';});
html2canvas(msgEl,{backgroundColor:'${c.bgColor}',scale:2,useCORS:true}).then(function(canvas){
allBtns.forEach(function(b){b.style.display='';});
var author=safeName(msgEl.dataset.author||'chat');
var mid=msgEl.dataset.msgId||'unknown';
var idx=parseInt(msgEl.dataset.idx||'0',10);
var link=document.createElement('a');
link.download=author+'_YT_Live_Chat_'+pad4(idx+1)+'-'+pad4(totalMessages)+'_'+videoDate+'_'+mid+'.png';
link.href=canvas.toDataURL('image/png');
link.click();
}).catch(function(e){
allBtns.forEach(function(b){b.style.display='';});
console.error('Screenshot failed:',e);
});
};
` : ''}
})();
</script>
${h2cSrc ? '<script>' + h2cSrc + '<\/script>' : ''}
</body>
</html>`;
}

// ─── Comments HTML Generator ───

function generateCommentsHTML(comments, title, channelName, theme, h2cSrc) {
  const c = getThemeColors(theme);
  const totalComments = comments.length;
  const topLevel = comments.filter(x => !x.parent_comment_id);
  const replies = comments.filter(x => x.parent_comment_id);

  // Build comment threads
  const repliesByParent = {};
  for (const r of replies) {
    if (!repliesByParent[r.parent_comment_id]) repliesByParent[r.parent_comment_id] = [];
    repliesByParent[r.parent_comment_id].push(r);
  }

  // Analytics
  const authorCounts = {};
  let pinnedCount = 0;
  let heartedCount = 0;
  let ownerCount = 0;
  for (const cm of comments) {
    authorCounts[cm.author_display_name] = (authorCounts[cm.author_display_name] || 0) + 1;
    if (cm.is_pinned) pinnedCount++;
    if (cm.is_hearted) heartedCount++;
    if (cm.is_channel_owner) ownerCount++;
  }
  const topCommenters = Object.entries(authorCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const topMax = topCommenters.length > 0 ? topCommenters[0][1] : 1;

  const commentsJSON = JSON.stringify(topLevel.map(cm => ({
    id: cm.comment_id,
    a: cm.author_display_name,
    ch: cm.author_channel_id,
    img: cm.author_profile_image,
    t: cm.text,
    time: cm.published_time_text,
    fat: cm.fetched_at_ms || Date.now(),
    likes: cm.like_count,
    rc: cm.reply_count,
    own: cm.is_channel_owner,
    pin: cm.is_pinned,
    heart: cm.is_hearted,
    replies: (repliesByParent[cm.comment_id] || []).map(r => ({
      id: r.comment_id,
      a: r.author_display_name,
      img: r.author_profile_image,
      t: r.text,
      time: r.published_time_text,
      fat: r.fetched_at_ms || Date.now(),
      likes: r.like_count,
      own: r.is_channel_owner,
      heart: r.is_hearted,
    })),
  })));

  const topCommentersHTML = topCommenters.map(([name, count]) => {
    const pct = Math.round((count / topMax) * 100);
    return `<div class="chatter-row"><span class="chatter-name">${esc(name)}</span><div class="chatter-bar-wrap"><div class="chatter-bar" style="width:${pct}%"></div></div><span class="chatter-count">${count}</span></div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)} - Comments</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Roboto','YouTube Sans',Arial,sans-serif;background:${c.bgColor};color:${c.textColor};line-height:1.4}
.header{background:${c.headerBg};border-bottom:1px solid ${c.borderColor};padding:16px 20px;position:sticky;top:0;z-index:10}
.header h1{font-size:18px;font-weight:500;margin-bottom:4px}
.header .meta{font-size:12px;color:${c.secondaryText}}
.tabs{display:flex;gap:0;border-bottom:1px solid ${c.borderColor};background:${c.headerBg};position:sticky;top:56px;z-index:9}
.tab{padding:10px 24px;cursor:pointer;font-size:14px;font-weight:500;color:${c.secondaryText};border-bottom:2px solid transparent;transition:all .2s;user-select:none}
.tab:hover{color:${c.textColor}}
.tab.active{color:${c.accentColor};border-bottom-color:${c.accentColor}}
.tab-content{display:none}
.tab-content.active{display:block}
.search-bar{max-width:800px;margin:16px auto;padding:0 20px;display:flex;gap:8px}
.search-bar input{flex:1;padding:10px 16px;border-radius:20px;border:1px solid ${c.borderColor};background:${c.inputBg};color:${c.textColor};font-size:14px;outline:none}
.search-bar input:focus{border-color:${c.accentColor}}
.search-info{max-width:800px;margin:0 auto;padding:0 20px;font-size:12px;color:${c.secondaryText};min-height:20px}
.comments-container{max-width:800px;margin:0 auto;padding:0 20px}
.comment{padding:12px 0;border-bottom:1px solid ${c.borderColor}}
.comment-main{display:flex;gap:12px}
.comment .avatar{width:40px;height:40px;border-radius:50%;flex-shrink:0}
.comment-body{flex:1;min-width:0}
.comment-header{display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap}
.comment-author{font-size:13px;font-weight:500}
.comment-author.owner{background:${c.isDark?'#272727':'#f0f0f0'};padding:1px 6px;border-radius:12px}
.comment-time{font-size:12px;color:${c.secondaryText}}
.comment-badges{display:flex;gap:4px}
.pin-badge{font-size:11px;color:${c.secondaryText}}
.heart-badge{color:#ff0000;font-size:12px}
.comment-text{font-size:14px;white-space:pre-wrap;word-break:break-word;margin-bottom:4px}
.comment-actions{font-size:12px;color:${c.secondaryText};display:flex;gap:12px;align-items:center}
.screenshot-btn{cursor:pointer;opacity:0.5;transition:opacity .2s;background:none;border:none;font-size:14px;padding:2px 4px;color:${c.secondaryText}}
.screenshot-btn:hover{opacity:1}
.replies{margin-left:52px;padding-left:0}
.reply{padding:8px 0;display:flex;gap:10px}
.reply .avatar{width:24px;height:24px}
.reply .comment-body{flex:1}
.reply .comment-text{font-size:13px}
.load-more{text-align:center;padding:16px}
.load-more button{padding:8px 24px;border-radius:20px;border:1px solid ${c.borderColor};background:${c.inputBg};color:${c.textColor};cursor:pointer;font-size:13px}
.analytics{max-width:800px;margin:0 auto;padding:20px}
.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:24px}
.stat-card{background:${c.cardBg};border:1px solid ${c.borderColor};border-radius:12px;padding:16px;text-align:center}
.stat-value{font-size:28px;font-weight:700;color:${c.accentColor}}
.stat-label{font-size:12px;color:${c.secondaryText};margin-top:4px;text-transform:uppercase;letter-spacing:.5px}
.analytics-section{background:${c.cardBg};border:1px solid ${c.borderColor};border-radius:12px;padding:20px;margin-bottom:16px}
.analytics-section h3{font-size:14px;font-weight:500;margin-bottom:16px}
.chatter-row{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.chatter-name{width:140px;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right}
.chatter-bar-wrap{flex:1;height:20px;background:${c.barBg};border-radius:4px;overflow:hidden}
.chatter-bar{height:100%;background:${c.accentColor};border-radius:4px}
.chatter-count{width:40px;font-size:12px;color:${c.secondaryText}}
</style>
</head>
<body>
<div class="header">
<h1>${esc(title)}</h1>
<div class="meta">${totalComments.toLocaleString()} comments (${topLevel.length} top-level, ${replies.length} replies)${channelName ? ' &bull; ' + esc(channelName) : ''}</div>
</div>
<div class="tabs">
<div class="tab active" data-tab="comments">Comments</div>
<div class="tab" data-tab="analytics">Analytics</div>
</div>
<div class="tab-content active" id="tab-comments">
<div class="search-bar"><input type="text" id="searchInput" placeholder="Search comments or @username..." /><select id="sortSelect" style="padding:8px 12px;border-radius:20px;border:1px solid ${c.borderColor};background:${c.inputBg};color:${c.textColor};font-size:13px;cursor:pointer;outline:none"><option value="default">Default Order</option><option value="user">Sort by User</option><option value="likes">Most Liked</option><option value="replies">Most Replies</option></select></div>
<div class="search-info" id="searchInfo"></div>
<div class="comments-container" id="commentsContainer"></div>
<div class="load-more" id="loadMore" style="display:none"><button id="btnLoadMore">Load More</button></div>
</div>
<div class="tab-content" id="tab-analytics">
<div class="analytics">
<div class="stats-grid">
<div class="stat-card"><div class="stat-value">${totalComments.toLocaleString()}</div><div class="stat-label">Total Comments</div></div>
<div class="stat-card"><div class="stat-value">${topLevel.length.toLocaleString()}</div><div class="stat-label">Top-Level</div></div>
<div class="stat-card"><div class="stat-value">${replies.length.toLocaleString()}</div><div class="stat-label">Replies</div></div>
<div class="stat-card"><div class="stat-value">${pinnedCount}</div><div class="stat-label">Pinned</div></div>
<div class="stat-card"><div class="stat-value">${heartedCount}</div><div class="stat-label">Hearted</div></div>
<div class="stat-card"><div class="stat-value">${ownerCount}</div><div class="stat-label">Creator</div></div>
</div>
<div class="analytics-section"><h3>Top 10 Commenters</h3>${topCommentersHTML}</div>
</div>
</div>
${h2cSrc ? '<script>' + h2cSrc + '<\/script>' : ''}
<script>
(function(){
var allComments=${commentsJSON};
var totalComments=allComments.length;
var videoDate=${JSON.stringify(getVideoDateStr())};
var PAGE_SIZE=100;
var currentPage=0;
var filtered=allComments;
var container=document.getElementById('commentsContainer');
var loadMoreDiv=document.getElementById('loadMore');

function escH(s){var d=document.createElement('div');d.textContent=s;return d.innerHTML}
function safeName(s){return s.replace(/[<>:"\\/|?*\\x00-\\x1f]/g,'_').replace(/\\s+/g,'_').substring(0,60)}
function pad4(n){return String(n).padStart(4,'0')}
function resolveDate(rel,fat){
if(!rel||!fat)return rel||'';
var edited=/\(edited\)/i.test(rel);
var t=rel.replace(/\s*\(edited\)\s*/i,'').toLowerCase().trim();
var m=t.match(/^(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/);
if(m){var amt=parseInt(m[1],10);var u=m[2];var d=new Date(fat);
if(u==='second')d.setSeconds(d.getSeconds()-amt);
else if(u==='minute')d.setMinutes(d.getMinutes()-amt);
else if(u==='hour')d.setHours(d.getHours()-amt);
else if(u==='day')d.setDate(d.getDate()-amt);
else if(u==='week')d.setDate(d.getDate()-amt*7);
else if(u==='month')d.setMonth(d.getMonth()-amt);
else if(u==='year')d.setFullYear(d.getFullYear()-amt);
return fmtDate(d)+(edited?' (edited)':'');}
if(t==='just now'||t.indexOf('moment')!==-1)return fmtDate(new Date(fat))+(edited?' (edited)':'');
return rel;
}
function fmtDate(d){
var mo=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
var h=d.getHours();var ap=h>=12?'PM':'AM';var h12=h%12||12;
var min=String(d.getMinutes()).padStart(2,'0');
return mo[d.getMonth()]+' '+d.getDate()+', '+d.getFullYear()+' '+h12+':'+min+' '+ap;
}

function renderComment(cm,idx){
var badges='';
if(cm.pin)badges+='<span class="pin-badge">&#128204; Pinned</span>';
if(cm.heart)badges+='<span class="heart-badge">&#10084;</span>';
var authorCls=cm.own?'comment-author owner':'comment-author';
var displayTime=resolveDate(cm.time,cm.fat);
var html='<div class="comment" data-comment-id="'+escH(cm.id)+'" data-author="'+escH(cm.a)+'" data-idx="'+idx+'"><div class="comment-main">';
html+=cm.img?'<img class="avatar" src="'+escH(cm.img)+'" alt="" loading="lazy" />':'<div class="avatar" style="background:#666;border-radius:50%"></div>';
html+='<div class="comment-body"><div class="comment-header"><span class="'+authorCls+'">'+escH(cm.a)+'</span><span class="comment-time">'+escH(displayTime)+'</span>'+badges+'</div>';
html+='<div class="comment-text">'+escH(cm.t)+'</div>';
html+='<div class="comment-actions">';
if(cm.likes>0)html+='<span>&#128077; '+cm.likes+'</span>';
if(cm.rc>0)html+='<span>'+cm.rc+' replies</span>';
${h2cSrc ? "html+='<button class=\"screenshot-btn\" title=\"Screenshot comment\" onclick=\"screenshotComment(this)\">&#128247;</button>';" : ''}
html+='</div></div></div>';
if(cm.replies&&cm.replies.length>0){
html+='<div class="replies">';
for(var i=0;i<cm.replies.length;i++){
var r=cm.replies[i];
var rBadges=r.heart?'<span class="heart-badge">&#10084;</span>':'';
var rAuthorCls=r.own?'comment-author owner':'comment-author';
var rDisplayTime=resolveDate(r.time,r.fat);
html+='<div class="reply">';
html+=r.img?'<img class="avatar" src="'+escH(r.img)+'" alt="" loading="lazy" />':'<div class="avatar" style="background:#666;border-radius:50%;width:24px;height:24px"></div>';
html+='<div class="comment-body"><div class="comment-header"><span class="'+rAuthorCls+'">'+escH(r.a)+'</span><span class="comment-time">'+escH(rDisplayTime)+'</span>'+rBadges+'</div>';
html+='<div class="comment-text">'+escH(r.t)+'</div>';
if(r.likes>0)html+='<div class="comment-actions"><span>&#128077; '+r.likes+'</span></div>';
html+='</div></div>';
}
html+='</div>';
}
html+='</div>';
return html;
}

function renderPage(){
var start=currentPage*PAGE_SIZE;
var end=Math.min(start+PAGE_SIZE,filtered.length);
var html='';
for(var i=start;i<end;i++)html+=renderComment(filtered[i],i);
container.insertAdjacentHTML('beforeend',html);
currentPage++;
loadMoreDiv.style.display=end<filtered.length?'block':'none';
}
renderPage();

document.getElementById('btnLoadMore').addEventListener('click',renderPage);
var currentSort='default';
function applyFiltersAndSort(){
var q=document.getElementById('searchInput').value.toLowerCase().trim();
var isAuthor=q.startsWith('@');
var term=isAuthor?q.slice(1):q;
if(!term){filtered=allComments.slice();}else{
filtered=allComments.filter(function(cm){
var match=isAuthor?cm.a.toLowerCase().indexOf(term)!==-1:cm.t.toLowerCase().indexOf(term)!==-1||cm.a.toLowerCase().indexOf(term)!==-1;
if(!match&&cm.replies){
for(var i=0;i<cm.replies.length;i++){
var r=cm.replies[i];
if(isAuthor?r.a.toLowerCase().indexOf(term)!==-1:r.t.toLowerCase().indexOf(term)!==-1||r.a.toLowerCase().indexOf(term)!==-1){match=true;break;}
}
}
return match;
});
}
if(currentSort==='user'){filtered.sort(function(a,b){return a.a.toLowerCase().localeCompare(b.a.toLowerCase());});}
else if(currentSort==='likes'){filtered.sort(function(a,b){return (b.likes||0)-(a.likes||0);});}
else if(currentSort==='replies'){filtered.sort(function(a,b){return (b.rc||0)-(a.rc||0);});}
currentPage=0;container.innerHTML='';renderPage();
document.getElementById('searchInfo').textContent=(q||currentSort!=='default')?'Showing '+filtered.length+' of '+allComments.length+' comments'+(currentSort!=='default'?' (sorted by '+currentSort+')':''):'';
}
document.getElementById('searchInput').addEventListener('input',applyFiltersAndSort);
document.getElementById('sortSelect').addEventListener('change',function(){currentSort=this.value;applyFiltersAndSort();});
document.querySelectorAll('.tab').forEach(function(tab){
tab.addEventListener('click',function(){
document.querySelectorAll('.tab').forEach(function(t){t.classList.remove('active');});
document.querySelectorAll('.tab-content').forEach(function(tc){tc.classList.remove('active');});
tab.classList.add('active');document.getElementById('tab-'+tab.dataset.tab).classList.add('active');
});
});

${h2cSrc ? `
window.screenshotComment=function(btn){
var commentEl=btn.closest('.comment');
if(!commentEl||typeof html2canvas==='undefined')return;
var allBtns=commentEl.querySelectorAll('.screenshot-btn');
allBtns.forEach(function(b){b.style.display='none';});
html2canvas(commentEl,{backgroundColor:document.body.style.backgroundColor||'${c.bgColor}',scale:2,useCORS:true}).then(function(canvas){
allBtns.forEach(function(b){b.style.display='';});
var author=safeName(commentEl.dataset.author||'comment');
var cid=commentEl.dataset.commentId||'unknown';
var idx=parseInt(commentEl.dataset.idx||'0',10);
var link=document.createElement('a');
link.download=author+'_YT_RC_'+pad4(idx+1)+'-'+pad4(totalComments)+'_'+videoDate+'_'+cid+'.png';
link.href=canvas.toDataURL('image/png');
link.click();
}).catch(function(e){
allBtns.forEach(function(b){b.style.display='';});
console.error('Screenshot failed:',e);
});
};
` : ''}
})();
</script>
</body>
</html>`;
}

// ─── YouTube Clone HTML Generator ───

function generateYouTubeCloneHTML(theme, h2cSrc) {
  const c = getThemeColors(theme);
  const meta = videoMetadata || {};
  const title = meta.title || currentVideoData?.title || 'Video';
  const channel = meta.author || meta.ownerChannelName || currentVideoData?.channelName || '';
  const videoId = meta.videoId || currentVideoData?.videoId || '';

  // Figure out local video filename (matches buildFolderPrefix output)
  const videoPrefix = buildFolderPrefix();
  const videoFilename = `${videoPrefix}.mp4`;

  // Prepare data for embedding
  const metaJSON = JSON.stringify(meta);
  const chatJSON = JSON.stringify(chatMessages.slice(0, 10000).map(m => ({
    ts: m.timestamp_text,
    a: m.author_name,
    m: m.message,
    t: m.message_type,
    o: m.is_owner,
    sc: m.superchat_amount,
    img: m.author_profile_image,
  })));
  const commentsJSON = JSON.stringify(regularComments.slice(0, 5000).map(cm => ({
    id: cm.comment_id,
    pid: cm.parent_comment_id,
    a: cm.author_display_name,
    img: cm.author_profile_image,
    t: cm.text,
    time: cm.published_time_text,
    fat: cm.fetched_at_ms || Date.now(),
    likes: cm.like_count,
    rc: cm.reply_count,
    own: cm.is_channel_owner,
    pin: cm.is_pinned,
    heart: cm.is_hearted,
  })));

  const description = esc(meta.description || meta.shortDescription || '').replace(/\n/g, '<br>');
  const viewCount = meta.viewCountText || (meta.viewCount ? parseInt(meta.viewCount).toLocaleString() + ' views' : '');
  const publishDate = meta.dateText || meta.publishDate || '';
  const likeCount = meta.likeCount || '';
  const subscriberCount = meta.subscriberCount || '';
  const channelAvatar = meta.channelAvatar || '';
  const thumbnail = meta.thumbnail || '';
  const hasChatData = chatMessages.length > 0;
  const hasCommentData = regularComments.length > 0;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)} - YouTube Archive</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Roboto','YouTube Sans',Arial,sans-serif;background:${c.bgColor};color:${c.textColor};line-height:1.4}
a{color:${c.accentColor};text-decoration:none}
.page{display:flex;max-width:1400px;margin:0 auto;padding:24px;gap:24px}
.main{flex:1;min-width:0}
.sidebar{width:400px;flex-shrink:0}
@media(max-width:1024px){.page{flex-direction:column}.sidebar{width:100%}}

/* Video Player */
.player-wrap{position:relative;width:100%;padding-bottom:56.25%;background:#000;border-radius:12px;overflow:hidden;margin-bottom:12px}
.player-wrap video,.player-wrap img{position:absolute;top:0;left:0;width:100%;height:100%;object-fit:contain}
.no-video{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#aaa;text-align:center;font-size:16px}

/* Video Info */
.video-title{font-size:20px;font-weight:600;margin-bottom:8px}
.video-actions{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid ${c.borderColor}}
.video-stats{font-size:14px;color:${c.secondaryText}}
.like-btn{padding:6px 16px;border-radius:20px;background:${c.messageBg};color:${c.textColor};font-size:14px;border:none;cursor:default;display:inline-flex;align-items:center;gap:6px}

/* Channel */
.channel-row{display:flex;align-items:center;gap:12px;margin-bottom:16px;padding-bottom:16px;border-bottom:1px solid ${c.borderColor}}
.channel-avatar{width:40px;height:40px;border-radius:50%;background:${c.secondaryText}}
.channel-info .name{font-size:16px;font-weight:500}
.channel-info .subs{font-size:12px;color:${c.secondaryText}}

/* Description */
.description{background:${c.messageBg};border-radius:12px;padding:12px;margin-bottom:24px;font-size:14px;cursor:pointer;max-height:80px;overflow:hidden;transition:max-height .3s}
.description.expanded{max-height:none}
.description .desc-header{font-size:13px;color:${c.secondaryText};margin-bottom:4px}
.desc-text{white-space:pre-wrap;word-break:break-word}
.show-more{color:${c.secondaryText};font-size:13px;font-weight:500;margin-top:4px;display:inline-block}

/* Comments */
.comments-section{margin-top:24px}
.comments-header{font-size:16px;font-weight:500;margin-bottom:16px}
.comment{display:flex;gap:12px;margin-bottom:16px}
.comment .avatar{width:40px;height:40px;border-radius:50%;flex-shrink:0}
.comment .body{flex:1}
.comment .cm-header{display:flex;gap:8px;align-items:center;margin-bottom:2px;flex-wrap:wrap}
.comment .cm-author{font-size:13px;font-weight:500}
.comment .cm-author.owner{background:${c.isDark?'#272727':'#f0f0f0'};padding:1px 6px;border-radius:12px}
.comment .cm-time{font-size:12px;color:${c.secondaryText}}
.comment .cm-text{font-size:14px;white-space:pre-wrap;word-break:break-word}
.comment .cm-actions{font-size:12px;color:${c.secondaryText};margin-top:4px;display:flex;gap:10px}
.screenshot-btn{cursor:pointer;opacity:0.5;transition:opacity .2s;background:none;border:none;font-size:14px;padding:2px 4px;color:${c.secondaryText}}
.screenshot-btn:hover{opacity:1}
.cm-pin{font-size:11px;color:${c.secondaryText}}
.cm-heart{color:#ff0000;font-size:12px}
.reply-group{margin-left:52px}
.reply{display:flex;gap:10px;margin-bottom:10px}
.reply .avatar{width:24px;height:24px}
.load-more-comments{text-align:center;padding:16px}
.load-more-comments button{padding:8px 24px;border-radius:20px;border:1px solid ${c.borderColor};background:${c.inputBg};color:${c.textColor};cursor:pointer;font-size:13px}

/* Chat Sidebar */
.chat-box{background:${c.messageBg};border-radius:12px;height:600px;display:flex;flex-direction:column;overflow:hidden}
.chat-header{padding:12px 16px;border-bottom:1px solid ${c.borderColor};font-size:14px;font-weight:500}
.chat-messages{flex:1;overflow-y:auto;padding:8px}
.chat-msg{padding:4px 8px;font-size:13px;display:flex;gap:6px;align-items:flex-start}
.chat-msg:hover{background:${c.isDark?'rgba(255,255,255,0.05)':'rgba(0,0,0,0.05)'};border-radius:4px}
.chat-msg .chat-ts{color:${c.secondaryText};font-size:11px;flex-shrink:0;min-width:50px}
.chat-msg .chat-author{font-weight:500;font-size:13px;flex-shrink:0}
.chat-msg .chat-text{font-size:13px;word-break:break-word}
.chat-msg.superchat{border-left:2px solid #ffd600;padding-left:6px;background:${c.isDark?'rgba(255,214,0,0.05)':'rgba(255,214,0,0.1)'}}
.chat-msg .sc-amount{color:#ffd600;font-weight:700;font-size:12px;margin-right:4px}
.no-chat{padding:20px;text-align:center;color:${c.secondaryText}}

/* Archive info */
.archive-banner{background:${c.headerBg};border:1px solid ${c.borderColor};border-radius:12px;padding:12px 16px;margin-bottom:16px;font-size:12px;color:${c.secondaryText}}
.archive-banner strong{color:${c.textColor}}
</style>
</head>
<body>
<div class="page">
<div class="main">
<div class="player-wrap">
<video controls poster="${esc(thumbnail)}" preload="metadata">
<source src="${esc(videoFilename)}">
</video>
<div class="no-video" id="noVideo" style="display:none">Video file not found. Place <strong>${esc(videoFilename)}</strong> in the same directory.</div>
</div>

<div class="video-title">${esc(title)}</div>

<div class="video-actions">
<div class="video-stats">${esc(viewCount)}${publishDate ? ' &bull; ' + esc(publishDate) : ''}</div>
${likeCount ? '<div class="like-btn">&#128077; ' + esc(likeCount) + '</div>' : ''}
</div>

<div class="channel-row">
${channelAvatar ? '<img class="channel-avatar" src="' + esc(channelAvatar) + '" alt="" />' : '<div class="channel-avatar"></div>'}
<div class="channel-info">
<div class="name">${esc(channel)}</div>
${subscriberCount ? '<div class="subs">' + esc(subscriberCount) + '</div>' : ''}
</div>
</div>

<div class="description" id="description" onclick="this.classList.toggle('expanded')">
<div class="desc-header">${esc(viewCount)} ${esc(publishDate)}</div>
<div class="desc-text">${description}</div>
<span class="show-more">Show more</span>
</div>

<div class="archive-banner">
<strong>Archived</strong> &bull; This is a locally archived copy of <a href="https://www.youtube.com/watch?v=${esc(videoId)}" target="_blank">youtube.com/watch?v=${esc(videoId)}</a>
&bull; ${regularComments.length.toLocaleString()} comments &bull; ${chatMessages.length.toLocaleString()} chat messages
</div>

${hasCommentData ? '<div class="comments-section"><div class="comments-header">' + regularComments.length.toLocaleString() + ' Comments</div><div id="commentsContainer"></div><div class="load-more-comments" id="loadMoreComments" style="display:none"><button id="btnLoadMoreComments">Load More Comments</button></div></div>' : ''}
</div>

<div class="sidebar">
${hasChatData ? '<div class="chat-box"><div class="chat-header">Chat Replay &bull; ' + chatMessages.length.toLocaleString() + ' messages</div><div class="chat-messages" id="chatMessages"></div></div>' : '<div class="chat-box"><div class="no-chat">No live chat data available</div></div>'}
</div>
</div>

<script>
(function(){
var escH=function(s){var d=document.createElement('div');d.textContent=s;return d.innerHTML};
function resolveDate(rel,fat){
if(!rel||!fat)return rel||'';
var t=rel.toLowerCase().trim();
var m=t.match(/^(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/);
if(m){var amt=parseInt(m[1],10);var u=m[2];var d=new Date(fat);
if(u==='second')d.setSeconds(d.getSeconds()-amt);
else if(u==='minute')d.setMinutes(d.getMinutes()-amt);
else if(u==='hour')d.setHours(d.getHours()-amt);
else if(u==='day')d.setDate(d.getDate()-amt);
else if(u==='week')d.setDate(d.getDate()-amt*7);
else if(u==='month')d.setMonth(d.getMonth()-amt);
else if(u==='year')d.setFullYear(d.getFullYear()-amt);
return fmtDate(d);}
if(t==='just now'||t.indexOf('moment')!==-1)return fmtDate(new Date(fat));
return rel;
}
function fmtDate(d){
var mo=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
var h=d.getHours();var ap=h>=12?'PM':'AM';var h12=h%12||12;
var min=String(d.getMinutes()).padStart(2,'0');
return mo[d.getMonth()]+' '+d.getDate()+', '+d.getFullYear()+' '+h12+':'+min+' '+ap;
}

// Video error handling
var vid=document.querySelector('video');
if(vid){vid.addEventListener('error',function(){
document.getElementById('noVideo').style.display='block';
});}

// Chat rendering
var chatData=${chatJSON};
var chatContainer=document.getElementById('chatMessages');
if(chatContainer&&chatData.length>0){
var html='';
for(var i=0;i<chatData.length;i++){
var m=chatData[i];
var cls='chat-msg';if(m.t==='superchat')cls+=' superchat';
var authorColor=m.o?'${c.isDark?"#ffd600":"#c69000"}':'${c.accentColor}';
html+='<div class="'+cls+'"><span class="chat-ts">'+escH(m.ts)+'</span>';
if(m.sc)html+='<span class="sc-amount">'+escH(m.sc)+'</span>';
html+='<span class="chat-author" style="color:'+authorColor+'">'+escH(m.a)+'</span>';
html+='<span class="chat-text">'+escH(m.m)+'</span></div>';
}
chatContainer.innerHTML=html;
}

// Comments rendering
var commentsData=${commentsJSON};
var commentsContainer=document.getElementById('commentsContainer');
var loadMoreBtn=document.getElementById('loadMoreComments');
if(commentsContainer&&commentsData.length>0){
var topLevel=commentsData.filter(function(c){return !c.pid;});
var repliesByParent={};
commentsData.forEach(function(c){if(c.pid){if(!repliesByParent[c.pid])repliesByParent[c.pid]=[];repliesByParent[c.pid].push(c);}});

var cmPage=0;var CM_PAGE_SIZE=50;
function renderCommentPage(){
var start=cmPage*CM_PAGE_SIZE;var end=Math.min(start+CM_PAGE_SIZE,topLevel.length);
var html='';
for(var i=start;i<end;i++){
var cm=topLevel[i];
var badges='';
if(cm.pin)badges+='<span class="cm-pin">&#128204; Pinned</span>';
if(cm.heart)badges+='<span class="cm-heart">&#10084;</span>';
var authorCls=cm.own?'cm-author owner':'cm-author';
var displayTime=resolveDate(cm.time,cm.fat);
html+='<div class="comment" data-comment-id="'+escH(cm.id)+'" data-author="'+escH(cm.a)+'" data-idx="'+i+'" data-total="'+topLevel.length+'">';
html+=cm.img?'<img class="avatar" src="'+escH(cm.img)+'" alt="" loading="lazy" />':'<div class="avatar" style="background:#666"></div>';
html+='<div class="body"><div class="cm-header"><span class="'+authorCls+'">'+escH(cm.a)+'</span><span class="cm-time">'+escH(displayTime)+'</span>'+badges+'</div>';
html+='<div class="cm-text">'+escH(cm.t)+'</div>';
html+='<div class="cm-actions">';
if(cm.likes>0)html+='<span>&#128077; '+cm.likes+'</span>';
if(cm.rc>0)html+='<span>'+cm.rc+' replies</span>';
${h2cSrc ? "html+='<button class=\"screenshot-btn\" title=\"Screenshot comment\" onclick=\"screenshotComment(this)\">&#128247;</button>';" : ''}
html+='</div></div></div>';
var reps=repliesByParent[cm.id];
if(reps&&reps.length>0){
html+='<div class="reply-group">';
for(var j=0;j<reps.length;j++){
var r=reps[j];
var rAuthorCls=r.own?'cm-author owner':'cm-author';
var rDisplayTime=resolveDate(r.time,r.fat);
html+='<div class="reply">';
html+=r.img?'<img class="avatar" src="'+escH(r.img)+'" alt="" loading="lazy" />':'<div class="avatar" style="background:#666;width:24px;height:24px"></div>';
html+='<div class="body"><div class="cm-header"><span class="'+rAuthorCls+'">'+escH(r.a)+'</span><span class="cm-time">'+escH(rDisplayTime)+'</span>'+(r.heart?'<span class="cm-heart">&#10084;</span>':'')+'</div>';
html+='<div class="cm-text">'+escH(r.t)+'</div>';
if(r.likes>0)html+='<div class="cm-actions"><span>&#128077; '+r.likes+'</span></div>';
html+='</div></div>';
}
html+='</div>';
}
}
commentsContainer.insertAdjacentHTML('beforeend',html);
cmPage++;
if(loadMoreBtn)loadMoreBtn.style.display=end<topLevel.length?'block':'none';
}
renderCommentPage();
if(loadMoreBtn){
document.getElementById('btnLoadMoreComments').addEventListener('click',renderCommentPage);
}
}
})();
</script>
${h2cSrc ? '<script>' + h2cSrc + '<\/script>' : ''}
${h2cSrc ? `<script>
(function(){
var videoDate=${JSON.stringify(getVideoDateStr())};
function safeName(s){return s.replace(/[<>:"\\/|?*\\x00-\\x1f]/g,'_').replace(/\\s+/g,'_').substring(0,60)}
function pad4(n){return String(n).padStart(4,'0')}
window.screenshotComment=function(btn){
var commentEl=btn.closest('.comment');
if(!commentEl||typeof html2canvas==='undefined')return;
var allBtns=commentEl.querySelectorAll('.screenshot-btn');
allBtns.forEach(function(b){b.style.display='none';});
html2canvas(commentEl,{backgroundColor:'${c.bgColor}',scale:2,useCORS:true}).then(function(canvas){
allBtns.forEach(function(b){b.style.display='';});
var author=safeName(commentEl.dataset.author||'comment');
var cid=commentEl.dataset.commentId||'unknown';
var idx=parseInt(commentEl.dataset.idx||'0',10);
var total=parseInt(commentEl.dataset.total||'0',10);
var link=document.createElement('a');
link.download=author+'_YT_RC_'+pad4(idx+1)+'-'+pad4(total)+'_'+videoDate+'_'+cid+'.png';
link.href=canvas.toDataURL('image/png');
link.click();
}).catch(function(e){
allBtns.forEach(function(b){b.style.display='';});
console.error('Screenshot failed:',e);
});
};
})();
<\/script>` : ''}
</body>
</html>`;
}

