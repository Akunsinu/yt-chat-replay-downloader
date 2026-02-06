// Background service worker
// Routes messages, collects chat data from content script, handles exports

let currentVideoData = null;
let chatMessages = [];
let fetchState = 'idle'; // idle, ready, fetching, complete, stopped, error
let fetchProgress = { current: 0, total: 0 };
let activeTabId = null;

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
          messageCountLost: chatMessages.length,
        },
      });
    } catch (e2) {
      console.error('[YT Chat Downloader] Failed to save state:', e2);
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
    }
  } catch (e) {
    console.error('[YT Chat Downloader] Failed to restore state:', e);
  }
}

restoreState();

// ─── Message Routing ───

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    // From content script: video detected
    case 'CHAT_REPLAY_DETECTED':
      currentVideoData = message.data;
      chatMessages = [];
      fetchState = 'ready';
      fetchProgress = { current: 0, total: 0 };
      if (sender.tab) activeTabId = sender.tab.id;
      saveState();
      broadcastToSidePanel({
        type: 'VIDEO_DETECTED',
        data: currentVideoData,
      });
      sendResponse({ status: 'ok' });
      break;

    case 'NO_CHAT_REPLAY':
      currentVideoData = { ...message.data, noChatReplay: true };
      fetchState = 'idle';
      saveState();
      broadcastToSidePanel({
        type: 'NO_CHAT_REPLAY',
        data: message.data,
      });
      sendResponse({ status: 'ok' });
      break;

    // From side panel: get current state
    case 'GET_STATE':
      sendResponse({
        videoData: currentVideoData,
        fetchState,
        fetchProgress,
        messageCount: chatMessages.length,
      });
      break;

    // From side panel: start fetching (delegates to content script)
    case 'START_FETCH':
      if (currentVideoData?.continuationToken) {
        fetchState = 'fetching';
        chatMessages = [];
        fetchProgress = { current: 0, total: 0 };
        broadcastToSidePanel({ type: 'FETCH_STARTED' });

        // Tell content script to start fetching
        const tabId = activeTabId;
        if (tabId) {
          chrome.tabs.sendMessage(tabId, {
            type: 'START_FETCH_FROM_CONTENT',
            continuation: currentVideoData.continuationToken,
          }).catch((err) => {
            console.error('[YT Chat Downloader] Failed to start fetch in content script:', err);
            fetchState = 'error';
            broadcastToSidePanel({
              type: 'FETCH_ERROR',
              data: { error: 'Could not communicate with YouTube page. Try refreshing.' },
            });
          });
        }
      }
      sendResponse({ status: 'ok' });
      break;

    // From side panel: stop fetching
    case 'STOP_FETCH':
      fetchState = 'stopped';
      if (activeTabId) {
        chrome.tabs.sendMessage(activeTabId, {
          type: 'STOP_FETCH_FROM_CONTENT',
        }).catch(() => {});
      }
      saveState();
      broadcastToSidePanel({
        type: 'FETCH_STOPPED',
        data: { messageCount: chatMessages.length },
      });
      sendResponse({ status: 'ok' });
      break;

    // From content script: batch of messages received
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

    // From content script: fetching complete
    case 'FETCH_PAGE_DONE':
      fetchState = 'complete';
      saveState();
      broadcastToSidePanel({
        type: 'FETCH_COMPLETE',
        data: { messageCount: chatMessages.length },
      });
      sendResponse({ status: 'ok' });
      break;

    // From content script: fetch error
    case 'FETCH_PAGE_ERROR':
      fetchState = 'error';
      saveState();
      broadcastToSidePanel({
        type: 'FETCH_ERROR',
        data: {
          error: message.data?.error || 'Unknown error',
          messageCount: chatMessages.length,
        },
      });
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

    // From side panel: export
    case 'EXPORT_CSV':
      exportCSV(message.data?.filters);
      sendResponse({ status: 'ok' });
      break;

    case 'EXPORT_HTML':
      exportHTML(message.data?.theme, message.data?.filters);
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

    default:
      break;
  }
  return true;
});

function broadcastToSidePanel(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

// ─── Export Functions ───

function filterMessages(filters) {
  if (!filters || filters.length === 0) return chatMessages;
  return chatMessages.filter((msg) => filters.includes(msg.message_type));
}

function stringToBase64(str) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function exportCSV(filters) {
  const messages = filterMessages(filters);
  const headers = [
    'timestamp_ms', 'timestamp_text', 'author_name', 'author_channel_id',
    'author_profile_image', 'message', 'message_type', 'is_owner',
    'is_moderator', 'is_member', 'is_verified', 'badges', 'superchat_amount',
  ];

  const escapeCSV = (val) => {
    const str = String(val ?? '');
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  };

  let csv = '\uFEFF';
  csv += headers.join(',') + '\n';
  for (const msg of messages) {
    csv += headers.map((h) => escapeCSV(msg[h])).join(',') + '\n';
  }

  const base64 = stringToBase64(csv);
  const dataUrl = `data:text/csv;base64,${base64}`;
  const filename = sanitizeFilename(
    `chat_${currentVideoData?.title || currentVideoData?.videoId || 'export'}.csv`
  );

  chrome.downloads.download({ url: dataUrl, filename, saveAs: true });
}

function exportHTML(theme = 'dark', filters) {
  const messages = filterMessages(filters);
  const isDark = theme === 'dark';
  const title = currentVideoData?.title || 'Chat Replay';
  const channelName = currentVideoData?.channelName || '';

  const bgColor = isDark ? '#0f0f0f' : '#ffffff';
  const textColor = isDark ? '#ffffff' : '#0f0f0f';
  const secondaryText = isDark ? '#aaaaaa' : '#606060';
  const messageBg = isDark ? '#272727' : '#f2f2f2';
  const borderColor = isDark ? '#3f3f3f' : '#e0e0e0';
  const headerBg = isDark ? '#212121' : '#f9f9f9';
  const cardBg = isDark ? '#1a1a1a' : '#f9f9f9';
  const inputBg = isDark ? '#272727' : '#f2f2f2';
  const accentColor = '#3ea6ff';
  const barBg = isDark ? '#333333' : '#e0e0e0';

  const esc = (str) =>
    String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // ── Compute analytics ──
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

    // Timeline: bucket by 5-minute intervals
    const bucketMin = Math.floor(Math.max(0, msg.timestamp_ms) / 300000) * 5;
    timelineBuckets[bucketMin] = (timelineBuckets[bucketMin] || 0) + 1;

    if (msg.message_type === 'superchat' || msg.message_type === 'supersticker') {
      superChatCount++;
      const amount = parseFloat(String(msg.superchat_amount).replace(/[^0-9.]/g, ''));
      if (!isNaN(amount)) totalSuperChatValue += amount;
    }
  }

  // Top 10 chatters
  const topChatters = Object.entries(authorCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  const topChatterMax = topChatters.length > 0 ? topChatters[0][1] : 1;

  // Timeline bars
  const timelineEntries = Object.entries(timelineBuckets)
    .map(([min, count]) => [parseInt(min), count])
    .sort((a, b) => a[0] - b[0]);
  const timelineMax = timelineEntries.length > 0
    ? Math.max(...timelineEntries.map(e => e[1])) : 1;

  // Format duration
  const durationSec = Math.floor(maxTimestampMs / 1000);
  const durH = Math.floor(durationSec / 3600);
  const durM = Math.floor((durationSec % 3600) / 60);
  const durationStr = durH > 0 ? `${durH}h ${durM}m` : `${durM}m`;

  // Currency symbol from first superchat
  const scMsg = messages.find(m => m.superchat_amount);
  const currencySymbol = scMsg ? String(scMsg.superchat_amount).replace(/[0-9.,\s]/g, '').trim() || '$' : '$';

  // ── Build analytics HTML ──
  const topChattersHTML = topChatters.map(([name, count]) => {
    const pct = Math.round((count / topChatterMax) * 100);
    return `<div class="chatter-row">
      <span class="chatter-name">${esc(name)}</span>
      <div class="chatter-bar-wrap"><div class="chatter-bar" style="width:${pct}%"></div></div>
      <span class="chatter-count">${count}</span>
    </div>`;
  }).join('');

  const timelineHTML = timelineEntries.map(([min, count]) => {
    const pct = Math.round((count / timelineMax) * 100);
    const h = Math.floor(min / 60);
    const m = min % 60;
    const label = h > 0 ? `${h}:${String(m).padStart(2,'0')}` : `${m}m`;
    return `<div class="tl-bar-wrap" title="${label}: ${count} msgs">
      <div class="tl-bar" style="height:${pct}%"></div>
      <div class="tl-label">${label}</div>
    </div>`;
  }).join('');

  // ── Build message HTML ──
  let messagesHTML = '';
  for (const msg of messages) {
    let nameColor = textColor;
    let extraBadges = '';
    if (msg.is_owner) { nameColor = isDark ? '#ffd600' : '#c69000'; extraBadges += '<span class="badge owner">Owner</span>'; }
    if (msg.is_moderator) { nameColor = isDark ? '#5e84f1' : '#2962ff'; extraBadges += '<span class="badge moderator">Mod</span>'; }
    if (msg.is_member) { nameColor = isDark ? '#2ba640' : '#0f9d58'; extraBadges += '<span class="badge member">Member</span>'; }
    if (msg.is_verified) { extraBadges += '<span class="badge verified">&#10003;</span>'; }

    let msgClass = 'message';
    let superchatHeader = '';
    if (msg.message_type === 'superchat') {
      msgClass += ' superchat';
      superchatHeader = `<div class="superchat-amount">${esc(msg.superchat_amount)}</div>`;
    } else if (msg.message_type === 'membership') {
      msgClass += ' membership';
    } else if (msg.message_type === 'supersticker') {
      msgClass += ' supersticker';
      superchatHeader = `<div class="superchat-amount">${esc(msg.superchat_amount)}</div>`;
    }

    const imgSrc = msg.author_profile_image
      ? `<img class="avatar" src="${esc(msg.author_profile_image)}" alt="" loading="lazy" />`
      : '<div class="avatar-placeholder"></div>';

    messagesHTML += `
      <div class="${msgClass}" data-author="${esc(msg.author_name).toLowerCase()}" data-text="${esc(msg.message).toLowerCase()}" data-type="${msg.message_type}">
        ${superchatHeader}
        <div class="message-body">
          ${imgSrc}
          <div class="message-content">
            <span class="timestamp">${esc(msg.timestamp_text)}</span>
            <span class="author" style="color:${nameColor}">${esc(msg.author_name)}</span>
            ${extraBadges}
            <span class="text">${esc(msg.message)}</span>
          </div>
        </div>
      </div>`;
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)} - Chat Replay</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Roboto', 'YouTube Sans', Arial, sans-serif; background: ${bgColor}; color: ${textColor}; line-height: 1.4; }

  /* Header */
  .header { background: ${headerBg}; border-bottom: 1px solid ${borderColor}; padding: 16px 20px; position: sticky; top: 0; z-index: 10; }
  .header h1 { font-size: 18px; font-weight: 500; margin-bottom: 4px; }
  .header .meta { font-size: 12px; color: ${secondaryText}; }

  /* Tabs */
  .tabs { display: flex; gap: 0; border-bottom: 1px solid ${borderColor}; background: ${headerBg}; position: sticky; top: 56px; z-index: 9; }
  .tab { padding: 10px 24px; cursor: pointer; font-size: 14px; font-weight: 500; color: ${secondaryText}; border-bottom: 2px solid transparent; transition: all 0.2s; user-select: none; }
  .tab:hover { color: ${textColor}; }
  .tab.active { color: ${accentColor}; border-bottom-color: ${accentColor}; }
  .tab-content { display: none; }
  .tab-content.active { display: block; }

  /* Search */
  .search-bar { max-width: 800px; margin: 16px auto; padding: 0 20px; display: flex; gap: 8px; align-items: center; }
  .search-bar input { flex: 1; padding: 10px 16px; border-radius: 20px; border: 1px solid ${borderColor}; background: ${inputBg}; color: ${textColor}; font-size: 14px; outline: none; }
  .search-bar input:focus { border-color: ${accentColor}; }
  .search-bar input::placeholder { color: ${secondaryText}; }
  .search-info { max-width: 800px; margin: 0 auto; padding: 0 20px; font-size: 12px; color: ${secondaryText}; min-height: 20px; }
  .filter-chips { max-width: 800px; margin: 8px auto; padding: 0 20px; display: flex; gap: 6px; flex-wrap: wrap; }
  .chip { padding: 4px 12px; border-radius: 16px; font-size: 12px; cursor: pointer; border: 1px solid ${borderColor}; background: transparent; color: ${secondaryText}; transition: all 0.2s; user-select: none; }
  .chip.active { background: ${accentColor}; color: #0f0f0f; border-color: ${accentColor}; }

  /* Messages */
  .messages-container { max-width: 800px; margin: 0 auto; }
  .message { padding: 8px 20px; display: flex; flex-direction: column; }
  .message.hidden { display: none; }
  .message:hover { background: ${messageBg}; }
  .message-body { display: flex; align-items: flex-start; gap: 12px; }
  .avatar { width: 24px; height: 24px; border-radius: 50%; flex-shrink: 0; margin-top: 2px; }
  .avatar-placeholder { width: 24px; height: 24px; border-radius: 50%; background: ${secondaryText}; flex-shrink: 0; margin-top: 2px; }
  .message-content { flex: 1; min-width: 0; }
  .timestamp { color: ${secondaryText}; font-size: 11px; margin-right: 8px; }
  .author { font-size: 13px; font-weight: 500; margin-right: 4px; }
  .text { font-size: 13px; word-break: break-word; }
  .badge { display: inline-block; font-size: 10px; padding: 1px 4px; border-radius: 2px; margin-right: 4px; font-weight: 500; vertical-align: middle; }
  .badge.owner { background: #ffd600; color: #0f0f0f; }
  .badge.moderator { background: #5e84f1; color: #fff; }
  .badge.member { background: #2ba640; color: #fff; }
  .badge.verified { background: ${secondaryText}; color: ${bgColor}; }
  .superchat { background: ${isDark ? '#1a3a1a' : '#e8f5e9'}; border-left: 3px solid #ffd600; margin: 4px 0; border-radius: 4px; padding: 12px 20px; }
  .superchat-amount { font-weight: 700; color: #ffd600; font-size: 14px; margin-bottom: 4px; }
  .membership { background: ${isDark ? '#1a2a1a' : '#e8f5e9'}; border-left: 3px solid #2ba640; margin: 4px 0; border-radius: 4px; padding: 12px 20px; }
  .supersticker { background: ${isDark ? '#2a2a1a' : '#fff8e1'}; border-left: 3px solid #ff6f00; margin: 4px 0; border-radius: 4px; padding: 12px 20px; }

  /* Analytics */
  .analytics { max-width: 800px; margin: 0 auto; padding: 20px; }
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .stat-card { background: ${cardBg}; border: 1px solid ${borderColor}; border-radius: 12px; padding: 16px; text-align: center; }
  .stat-value { font-size: 28px; font-weight: 700; color: ${accentColor}; }
  .stat-label { font-size: 12px; color: ${secondaryText}; margin-top: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
  .analytics-section { background: ${cardBg}; border: 1px solid ${borderColor}; border-radius: 12px; padding: 20px; margin-bottom: 16px; }
  .analytics-section h3 { font-size: 14px; font-weight: 500; margin-bottom: 16px; color: ${textColor}; }

  /* Type breakdown */
  .type-bars { display: flex; flex-direction: column; gap: 10px; }
  .type-row { display: flex; align-items: center; gap: 12px; }
  .type-label { width: 100px; font-size: 13px; color: ${secondaryText}; text-align: right; }
  .type-bar-wrap { flex: 1; height: 24px; background: ${barBg}; border-radius: 4px; overflow: hidden; }
  .type-bar { height: 100%; border-radius: 4px; display: flex; align-items: center; padding-left: 8px; font-size: 11px; font-weight: 500; color: #fff; min-width: fit-content; }
  .type-bar.text-bar { background: ${accentColor}; }
  .type-bar.superchat-bar { background: #ffd600; color: #0f0f0f; }
  .type-bar.membership-bar { background: #2ba640; }
  .type-bar.supersticker-bar { background: #ff6f00; }
  .type-count { width: 60px; font-size: 13px; color: ${secondaryText}; }

  /* Top chatters */
  .chatter-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .chatter-name { width: 140px; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; color: ${textColor}; }
  .chatter-bar-wrap { flex: 1; height: 20px; background: ${barBg}; border-radius: 4px; overflow: hidden; }
  .chatter-bar { height: 100%; background: ${accentColor}; border-radius: 4px; }
  .chatter-count { width: 40px; font-size: 12px; color: ${secondaryText}; }

  /* Timeline */
  .timeline { display: flex; align-items: flex-end; gap: 2px; height: 120px; overflow-x: auto; padding-bottom: 20px; position: relative; }
  .tl-bar-wrap { display: flex; flex-direction: column; align-items: center; flex: 1; min-width: 8px; max-width: 24px; height: 100%; justify-content: flex-end; position: relative; }
  .tl-bar { width: 100%; background: ${accentColor}; border-radius: 2px 2px 0 0; min-height: 2px; transition: opacity 0.2s; }
  .tl-bar-wrap:hover .tl-bar { opacity: 0.7; }
  .tl-label { font-size: 9px; color: ${secondaryText}; position: absolute; bottom: -16px; white-space: nowrap; }
  .tl-label { display: none; }
  .tl-bar-wrap:nth-child(6n+1) .tl-label { display: block; }
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

<!-- Chat Tab -->
<div class="tab-content active" id="tab-chat">
  <div class="search-bar">
    <input type="text" id="searchInput" placeholder="Search messages or @username..." />
  </div>
  <div class="filter-chips">
    <div class="chip active" data-filter="all">All</div>
    <div class="chip" data-filter="text">Text (${typeCounts.text.toLocaleString()})</div>
    <div class="chip" data-filter="superchat">Super Chat (${(typeCounts.superchat || 0).toLocaleString()})</div>
    <div class="chip" data-filter="membership">Membership (${(typeCounts.membership || 0).toLocaleString()})</div>
    <div class="chip" data-filter="supersticker">Sticker (${(typeCounts.supersticker || 0).toLocaleString()})</div>
  </div>
  <div class="search-info" id="searchInfo"></div>
  <div class="messages-container" id="messagesContainer">
${messagesHTML}
  </div>
</div>

<!-- Analytics Tab -->
<div class="tab-content" id="tab-analytics">
  <div class="analytics">
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-value">${totalMessages.toLocaleString()}</div><div class="stat-label">Total Messages</div></div>
      <div class="stat-card"><div class="stat-value">${uniqueAuthors.size.toLocaleString()}</div><div class="stat-label">Unique Chatters</div></div>
      <div class="stat-card"><div class="stat-value">${superChatCount}</div><div class="stat-label">Super Chats</div></div>
      <div class="stat-card"><div class="stat-value">${totalSuperChatValue > 0 ? currencySymbol + totalSuperChatValue.toFixed(2) : '-'}</div><div class="stat-label">Super Chat Total</div></div>
      <div class="stat-card"><div class="stat-value">${durationStr}</div><div class="stat-label">Duration</div></div>
      <div class="stat-card"><div class="stat-value">${durationSec > 0 ? (totalMessages / (durationSec / 60)).toFixed(1) : '0'}</div><div class="stat-label">Msgs / Minute</div></div>
    </div>

    <div class="analytics-section">
      <h3>Message Types</h3>
      <div class="type-bars">
        <div class="type-row"><span class="type-label">Text</span><div class="type-bar-wrap"><div class="type-bar text-bar" style="width:${totalMessages > 0 ? Math.max(1, (typeCounts.text / totalMessages) * 100) : 0}%">${typeCounts.text > 0 ? Math.round((typeCounts.text / totalMessages) * 100) + '%' : ''}</div></div><span class="type-count">${typeCounts.text.toLocaleString()}</span></div>
        <div class="type-row"><span class="type-label">Super Chat</span><div class="type-bar-wrap"><div class="type-bar superchat-bar" style="width:${totalMessages > 0 ? Math.max((typeCounts.superchat || 0) > 0 ? 1 : 0, ((typeCounts.superchat || 0) / totalMessages) * 100) : 0}%">${(typeCounts.superchat || 0) > 0 ? Math.round(((typeCounts.superchat || 0) / totalMessages) * 100) + '%' : ''}</div></div><span class="type-count">${(typeCounts.superchat || 0).toLocaleString()}</span></div>
        <div class="type-row"><span class="type-label">Membership</span><div class="type-bar-wrap"><div class="type-bar membership-bar" style="width:${totalMessages > 0 ? Math.max((typeCounts.membership || 0) > 0 ? 1 : 0, ((typeCounts.membership || 0) / totalMessages) * 100) : 0}%">${(typeCounts.membership || 0) > 0 ? Math.round(((typeCounts.membership || 0) / totalMessages) * 100) + '%' : ''}</div></div><span class="type-count">${(typeCounts.membership || 0).toLocaleString()}</span></div>
        <div class="type-row"><span class="type-label">Sticker</span><div class="type-bar-wrap"><div class="type-bar supersticker-bar" style="width:${totalMessages > 0 ? Math.max((typeCounts.supersticker || 0) > 0 ? 1 : 0, ((typeCounts.supersticker || 0) / totalMessages) * 100) : 0}%">${(typeCounts.supersticker || 0) > 0 ? Math.round(((typeCounts.supersticker || 0) / totalMessages) * 100) + '%' : ''}</div></div><span class="type-count">${(typeCounts.supersticker || 0).toLocaleString()}</span></div>
      </div>
    </div>

    <div class="analytics-section">
      <h3>Activity Over Time (5-min intervals)</h3>
      <div class="timeline">${timelineHTML}</div>
    </div>

    <div class="analytics-section">
      <h3>Top 10 Chatters</h3>
      ${topChattersHTML}
    </div>
  </div>
</div>

<script>
(function() {
  // Tab switching
  document.querySelectorAll('.tab').forEach(function(tab) {
    tab.addEventListener('click', function() {
      document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
      document.querySelectorAll('.tab-content').forEach(function(tc) { tc.classList.remove('active'); });
      tab.classList.add('active');
      document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
    });
  });

  // Search & filter
  var searchInput = document.getElementById('searchInput');
  var searchInfo = document.getElementById('searchInfo');
  var allMsgs = document.querySelectorAll('.message');
  var activeFilter = 'all';

  function applyFilters() {
    var query = searchInput.value.toLowerCase().trim();
    var isAuthorSearch = query.startsWith('@');
    var searchTerm = isAuthorSearch ? query.slice(1) : query;
    var shown = 0;
    var total = allMsgs.length;

    allMsgs.forEach(function(el) {
      var matchType = activeFilter === 'all' || el.dataset.type === activeFilter;
      var matchSearch = true;
      if (searchTerm) {
        if (isAuthorSearch) {
          matchSearch = el.dataset.author.indexOf(searchTerm) !== -1;
        } else {
          matchSearch = el.dataset.text.indexOf(searchTerm) !== -1 || el.dataset.author.indexOf(searchTerm) !== -1;
        }
      }
      if (matchType && matchSearch) {
        el.classList.remove('hidden');
        shown++;
      } else {
        el.classList.add('hidden');
      }
    });

    if (query || activeFilter !== 'all') {
      searchInfo.textContent = 'Showing ' + shown.toLocaleString() + ' of ' + total.toLocaleString() + ' messages';
    } else {
      searchInfo.textContent = '';
    }
  }

  searchInput.addEventListener('input', applyFilters);

  document.querySelectorAll('.chip').forEach(function(chip) {
    chip.addEventListener('click', function() {
      document.querySelectorAll('.chip').forEach(function(c) { c.classList.remove('active'); });
      chip.classList.add('active');
      activeFilter = chip.dataset.filter;
      applyFilters();
    });
  });
})();
</script>
</body>
</html>`;

  const base64 = stringToBase64(html);
  const dataUrl = `data:text/html;base64,${base64}`;
  const filename = sanitizeFilename(
    `chat_${currentVideoData?.title || currentVideoData?.videoId || 'export'}_${theme}.html`
  );

  chrome.downloads.download({ url: dataUrl, filename, saveAs: true });
}

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, '_').substring(0, 200);
}
