// Offscreen document for rendering comment/chat screenshots into a zip

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'RENDER_COMMENT_SCREENSHOTS') {
    renderAndZip(message.data).then(sendResponse).catch(e => {
      sendResponse({ error: e.message });
    });
    return true;
  }
});

async function renderAndZip({ comments, chat, theme, folderPrefix, dateStr }) {
  const c = getThemeColors(theme);
  const renderArea = document.getElementById('renderArea');
  renderArea.style.background = c.bgColor;
  renderArea.style.color = c.textColor;
  renderArea.style.fontFamily = "'Roboto','YouTube Sans','Arial',sans-serif";
  renderArea.style.lineHeight = '1.6';
  renderArea.style.fontSize = '14px';

  const style = document.createElement('style');
  style.textContent = buildStyles(c);
  document.head.appendChild(style);

  const zip = new JSZip();
  const totalRC = (comments || []).length;
  const totalChat = (chat || []).length;
  const grandTotal = totalRC + totalChat;
  let processed = 0;
  const date = dateStr || 'unknown';

  // Render regular comments
  for (let i = 0; i < totalRC; i++) {
    const cm = comments[i];
    renderArea.innerHTML = buildCommentHTML(cm, c);
    await waitForImages(renderArea);
    await delay(20);

    try {
      const el = renderArea.firstElementChild;
      const canvas = await html2canvas(el, { backgroundColor: c.bgColor, scale: 2, useCORS: true, width: 600 });
      const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
      const author = safeName(cm.a || 'comment');
      const filename = `${author}_YT_RC_${pad4(i + 1)}-${pad4(totalRC)}_${date}_${cm.id || 'unknown'}.png`;
      zip.file(filename, blob);

      // Clean up canvas to free memory
      canvas.width = 0;
      canvas.height = 0;
    } catch (e) {
      console.error('Screenshot failed for comment', cm.id, e);
    }

    // Clear DOM to free memory
    renderArea.innerHTML = '';

    processed++;
    if (processed % 10 === 0 || processed === grandTotal) {
      reportProgress(processed, grandTotal);
      // Yield to event loop for GC and message processing
      await delay(0);
    }
  }

  // Render live chat messages
  for (let i = 0; i < totalChat; i++) {
    const msg = chat[i];
    renderArea.innerHTML = buildChatMessageHTML(msg, c);
    await waitForImages(renderArea);
    await delay(20);

    try {
      const el = renderArea.firstElementChild;
      const canvas = await html2canvas(el, { backgroundColor: c.bgColor, scale: 2, useCORS: true, width: 600 });
      const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
      const author = safeName(msg.a || 'chat');
      const filename = `${author}_YT_Live_Chat_${pad4(i + 1)}-${pad4(totalChat)}_${date}_${msg.id || 'unknown'}.png`;
      zip.file(filename, blob);

      // Clean up canvas to free memory
      canvas.width = 0;
      canvas.height = 0;
    } catch (e) {
      console.error('Screenshot failed for chat msg', msg.id, e);
    }

    // Clear DOM to free memory
    renderArea.innerHTML = '';

    processed++;
    if (processed % 10 === 0 || processed === grandTotal) {
      reportProgress(processed, grandTotal);
      await delay(0);
    }
  }

  // Report that we're now zipping
  reportProgress(grandTotal, grandTotal);

  const zipBlob = await zip.generateAsync({ type: 'base64' });
  return { base64: zipBlob, count: grandTotal };
}

function buildStyles(c) {
  return `
/* ─── YouTube-style regular comments ─── */
.yt-comment {
  padding: 16px 16px 12px;
  background: ${c.bgColor};
  display: flex;
  gap: 16px;
  font-family: 'Roboto','YouTube Sans','Arial',sans-serif;
}
.yt-comment .avatar {
  width: 40px; height: 40px; border-radius: 50%; flex-shrink: 0;
  background: ${c.isDark ? '#3f3f3f' : '#e0e0e0'};
  object-fit: cover;
}
.yt-comment .body { flex: 1; min-width: 0; }
.yt-comment .header {
  display: flex; align-items: baseline; gap: 8px;
  margin-bottom: 4px; flex-wrap: wrap;
}
.yt-comment .author-name {
  font-size: 13px; font-weight: 500; line-height: 18px;
  color: ${c.textColor};
}
.yt-comment .author-name.owner {
  background: ${c.isDark ? '#272727' : '#e8e8e8'};
  padding: 2px 8px; border-radius: 12px;
}
.yt-comment .timestamp {
  font-size: 12px; color: ${c.secondaryText}; line-height: 18px;
}
.yt-comment .pinned-label {
  display: flex; align-items: center; gap: 4px;
  font-size: 12px; color: ${c.secondaryText};
  margin-bottom: 4px;
}
.yt-comment .pinned-label svg { fill: ${c.secondaryText}; }
.yt-comment .text {
  font-size: 14px; line-height: 20px;
  white-space: pre-wrap; word-break: break-word;
  color: ${c.textColor}; margin-bottom: 8px;
}
.yt-comment .actions {
  display: flex; align-items: center; gap: 8px;
  color: ${c.secondaryText}; font-size: 12px;
}
.yt-comment .action-btn {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 4px 8px; border-radius: 20px;
  font-size: 12px; color: ${c.secondaryText};
}
.yt-comment .action-btn svg { fill: ${c.secondaryText}; width: 16px; height: 16px; }
.yt-comment .like-count { font-size: 12px; color: ${c.secondaryText}; }
.yt-comment .heart-icon {
  display: inline-flex; align-items: center; gap: 2px;
  margin-left: 4px;
}
.yt-comment .heart-icon svg { fill: #ff0000; width: 14px; height: 14px; }
.yt-comment .reply-count {
  font-size: 13px; font-weight: 500;
  color: ${c.accentColor}; cursor: default;
  padding: 8px 16px; border-radius: 20px;
}
/* Replies */
.yt-replies { margin-left: 56px; padding-top: 4px; }
.yt-reply {
  display: flex; gap: 12px; padding: 8px 0;
  font-family: 'Roboto','YouTube Sans','Arial',sans-serif;
}
.yt-reply .avatar {
  width: 24px; height: 24px; border-radius: 50%; flex-shrink: 0;
  background: ${c.isDark ? '#3f3f3f' : '#e0e0e0'};
  object-fit: cover;
}
.yt-reply .body { flex: 1; min-width: 0; }
.yt-reply .header {
  display: flex; align-items: baseline; gap: 8px;
  margin-bottom: 2px; flex-wrap: wrap;
}
.yt-reply .author-name {
  font-size: 12px; font-weight: 500; color: ${c.textColor};
}
.yt-reply .author-name.owner {
  background: ${c.isDark ? '#272727' : '#e8e8e8'};
  padding: 2px 6px; border-radius: 12px;
}
.yt-reply .timestamp { font-size: 12px; color: ${c.secondaryText}; }
.yt-reply .text {
  font-size: 13px; line-height: 18px;
  white-space: pre-wrap; word-break: break-word;
  color: ${c.textColor}; margin-bottom: 4px;
}
.yt-reply .actions {
  display: flex; align-items: center; gap: 8px;
  color: ${c.secondaryText}; font-size: 12px;
}
.yt-reply .action-btn {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 12px; color: ${c.secondaryText};
}
.yt-reply .action-btn svg { fill: ${c.secondaryText}; width: 14px; height: 14px; }

/* ─── YouTube-style live chat messages ─── */
.yt-chat {
  padding: 8px 16px;
  background: ${c.bgColor};
  display: flex; align-items: flex-start; gap: 16px;
  font-family: 'Roboto','YouTube Sans','Arial',sans-serif;
}
.yt-chat .avatar {
  width: 24px; height: 24px; border-radius: 50%; flex-shrink: 0;
  margin-top: 2px;
  background: ${c.isDark ? '#3f3f3f' : '#e0e0e0'};
  object-fit: cover;
}
.yt-chat .msg-body { flex: 1; min-width: 0; }
.yt-chat .msg-header {
  display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap;
  margin-bottom: 2px;
}
.yt-chat .chat-ts {
  font-size: 11px; color: ${c.secondaryText}; flex-shrink: 0;
}
.yt-chat .chat-author {
  font-size: 12px; font-weight: 500;
}
.yt-chat .chat-badge {
  display: inline-block; font-size: 10px; padding: 1px 5px;
  border-radius: 2px; margin-left: 2px; font-weight: 500;
}
.yt-chat .chat-badge.owner { background: #ffd600; color: #0f0f0f; }
.yt-chat .chat-badge.mod { background: #5e84f1; color: #fff; }
.yt-chat .chat-badge.member { background: #2ba640; color: #fff; }
.yt-chat .chat-text {
  font-size: 13px; line-height: 18px;
  word-break: break-word; color: ${c.textColor};
}
.yt-chat.superchat {
  background: ${c.isDark ? '#1a3a1a' : '#e8f5e9'};
  border-left: 3px solid #ffd600;
  border-radius: 8px; padding: 12px 16px;
  margin: 2px 0;
}
.yt-chat .sc-amount {
  font-weight: 700; color: #ffd600; font-size: 15px;
  margin-bottom: 4px; display: block;
}
.yt-chat.membership {
  background: ${c.isDark ? '#1a2a1a' : '#e8f5e9'};
  border-left: 3px solid #2ba640;
  border-radius: 8px; padding: 12px 16px;
  margin: 2px 0;
}
`;
}

// SVG icons matching YouTube's style
const SVG_LIKE = '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M12.42 14.06h-3.71l-.2-.14c-.24-.16-.5-.38-.78-.65a7.7 7.7 0 01-1.5-2.14 1.5 1.5 0 01-.14-.46V7.84c0-.27.07-.5.2-.7s.32-.38.56-.52a3.3 3.3 0 011.64-.47h.68V3.28a1.2 1.2 0 01.35-.85 1.16 1.16 0 01.85-.35c.27 0 .53.09.73.26s.34.38.4.64l.74 3.7h1.6c.39 0 .72.14 1 .42.27.27.41.6.41 1v4.35c0 .39-.14.72-.41 1a1.36 1.36 0 01-1 .41h-1.42zm-8.64 0H2.36c-.39 0-.72-.14-1-.41a1.36 1.36 0 01-.41-1V8.1c0-.39.14-.72.41-1s.6-.41 1-.41h1.42c.39 0 .72.14 1 .41s.42.6.42 1v4.56c0 .39-.14.72-.42 1s-.6.41-1 .41z"></path></svg>';
const SVG_DISLIKE = '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M3.54 1.94h3.71l.2.14c.24.16.5.38.78.65a7.7 7.7 0 011.5 2.14c.09.15.14.3.14.46v2.83c0 .27-.07.5-.2.7s-.32.38-.56.52a3.3 3.3 0 01-1.64.47h-.68v2.87a1.2 1.2 0 01-.35.85 1.16 1.16 0 01-.85.35c-.27 0-.53-.09-.73-.26s-.34-.38-.4-.64l-.74-3.7H2.12c-.39 0-.72-.14-1-.42a1.36 1.36 0 01-.41-1V3.59c0-.39.14-.72.41-1s.6-.41 1-.41h1.42zm8.64 0h1.42c.39 0 .72.14 1 .41s.41.6.41 1v4.56c0 .39-.14.72-.41 1s-.6.41-1 .41h-1.42c-.39 0-.72-.14-1-.41s-.42-.6-.42-1V3.35c0-.39.14-.72.42-1s.6-.41 1-.41z"></path></svg>';
const SVG_PIN = '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M16 11V4h1V2H7v2h1v7l-2 2v2h5v6l1 1 1-1v-6h5v-2l-2-2z"></path></svg>';
const SVG_HEART = '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"></path></svg>';

function reportProgress(current, total) {
  chrome.runtime.sendMessage({
    type: 'SCREENSHOT_PROGRESS',
    data: { current, total },
  }).catch(() => {});
}

async function waitForImages(container) {
  const imgs = container.querySelectorAll('img');
  if (imgs.length > 0) {
    await Promise.all(Array.from(imgs).map(img => {
      if (img.complete) return Promise.resolve();
      return new Promise(r => { img.onload = r; img.onerror = r; });
    }));
  }
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function safeName(s) {
  return s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, '_').substring(0, 60);
}

function pad4(n) {
  return String(n).padStart(4, '0');
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function resolveAbsoluteDate(relativeText, fetchedAtMs) {
  if (!relativeText || !fetchedAtMs) return relativeText || '';
  const now = new Date(fetchedAtMs);
  const raw = relativeText.trim();
  const edited = /\(edited\)/i.test(raw);
  const text = raw.replace(/\s*\(edited\)\s*/i, '').toLowerCase().trim();

  // Match patterns like "1 day ago", "2 weeks ago", "3 months ago", "1 year ago",
  // "5 minutes ago", "2 hours ago", "just now", "1 second ago"
  const match = text.match(/^(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/);
  if (match) {
    const amount = parseInt(match[1], 10);
    const unit = match[2];
    const d = new Date(now);
    switch (unit) {
      case 'second': d.setSeconds(d.getSeconds() - amount); break;
      case 'minute': d.setMinutes(d.getMinutes() - amount); break;
      case 'hour': d.setHours(d.getHours() - amount); break;
      case 'day': d.setDate(d.getDate() - amount); break;
      case 'week': d.setDate(d.getDate() - amount * 7); break;
      case 'month': d.setMonth(d.getMonth() - amount); break;
      case 'year': d.setFullYear(d.getFullYear() - amount); break;
    }
    return formatAbsoluteDate(d) + (edited ? ' (edited)' : '');
  }

  // "just now" or "moments ago"
  if (text === 'just now' || text.includes('moment')) {
    return formatAbsoluteDate(now) + (edited ? ' (edited)' : '');
  }

  // Already absolute or unrecognized — return as-is
  return relativeText;
}

function formatAbsoluteDate(d) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const h = d.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} ${h12}:${min} ${ampm}`;
}

function getThemeColors(theme) {
  const isDark = theme === 'dark';
  return {
    isDark,
    bgColor: isDark ? '#0f0f0f' : '#ffffff',
    textColor: isDark ? '#f1f1f1' : '#0f0f0f',
    secondaryText: isDark ? '#aaaaaa' : '#606060',
    borderColor: isDark ? '#3f3f3f' : '#e0e0e0',
    accentColor: '#3ea6ff',
  };
}

function buildCommentHTML(cm, c) {
  const authorCls = cm.own ? 'author-name owner' : 'author-name';
  const displayTime = resolveAbsoluteDate(cm.time, cm.fat);

  let html = '<div class="yt-comment">';

  // Avatar
  html += cm.img
    ? '<img class="avatar" src="' + esc(cm.img) + '" alt="" crossorigin="anonymous" />'
    : '<div class="avatar"></div>';

  html += '<div class="body">';

  // Pinned label
  if (cm.pin) {
    html += '<div class="pinned-label">' + SVG_PIN + ' Pinned</div>';
  }

  // Header: author + time
  html += '<div class="header">';
  html += '<span class="' + authorCls + '">@' + esc(cm.a) + '</span>';
  html += '<span class="timestamp">' + esc(displayTime) + '</span>';
  html += '</div>';

  // Comment text
  html += '<div class="text">' + esc(cm.t) + '</div>';

  // Actions row
  html += '<div class="actions">';
  html += '<span class="action-btn">' + SVG_LIKE;
  if (cm.likes > 0) html += '<span class="like-count">' + formatCount(cm.likes) + '</span>';
  html += '</span>';
  html += '<span class="action-btn">' + SVG_DISLIKE + '</span>';
  if (cm.heart) {
    html += '<span class="heart-icon">' + SVG_HEART + '</span>';
  }
  html += '</div>';

  // Reply count
  if (cm.rc > 0) {
    html += '<div class="reply-count">' + cm.rc + (cm.rc === 1 ? ' reply' : ' replies') + '</div>';
  }

  html += '</div></div>';

  // Replies
  if (cm.replies && cm.replies.length > 0) {
    html += '<div class="yt-replies">';
    for (const r of cm.replies) {
      const rAuthorCls = r.own ? 'author-name owner' : 'author-name';
      const rDisplayTime = resolveAbsoluteDate(r.time, r.fat);
      html += '<div class="yt-reply">';
      html += r.img
        ? '<img class="avatar" src="' + esc(r.img) + '" alt="" crossorigin="anonymous" />'
        : '<div class="avatar"></div>';
      html += '<div class="body">';
      html += '<div class="header">';
      html += '<span class="' + rAuthorCls + '">@' + esc(r.a) + '</span>';
      html += '<span class="timestamp">' + esc(rDisplayTime) + '</span>';
      html += '</div>';
      html += '<div class="text">' + esc(r.t) + '</div>';
      html += '<div class="actions">';
      html += '<span class="action-btn">' + SVG_LIKE;
      if (r.likes > 0) html += '<span class="like-count">' + formatCount(r.likes) + '</span>';
      html += '</span>';
      html += '<span class="action-btn">' + SVG_DISLIKE + '</span>';
      if (r.heart) {
        html += '<span class="heart-icon">' + SVG_HEART + '</span>';
      }
      html += '</div>';
      html += '</div></div>';
    }
    html += '</div>';
  }

  return html;
}

function buildChatMessageHTML(msg, c) {
  let badges = '';
  let nameColor = c.textColor;
  if (msg.o) { nameColor = c.isDark ? '#ffd600' : '#c69000'; badges += '<span class="chat-badge owner">Owner</span>'; }
  if (msg.mod) { nameColor = c.isDark ? '#5e84f1' : '#2962ff'; badges += '<span class="chat-badge mod">Mod</span>'; }
  if (msg.mem) { badges += '<span class="chat-badge member">Member</span>'; }

  let cls = 'yt-chat';
  let scHeader = '';
  if (msg.t === 'superchat') { cls += ' superchat'; scHeader = '<span class="sc-amount">' + esc(msg.sc) + '</span>'; }
  else if (msg.t === 'membership') { cls += ' membership'; }
  else if (msg.t === 'supersticker') { cls += ' superchat'; scHeader = '<span class="sc-amount">' + esc(msg.sc) + '</span>'; }

  const img = msg.img
    ? '<img class="avatar" src="' + esc(msg.img) + '" alt="" crossorigin="anonymous" />'
    : '<div class="avatar"></div>';

  let html = '<div class="' + cls + '">';
  html += img;
  html += '<div class="msg-body">';
  if (scHeader) html += scHeader;
  html += '<div class="msg-header">';
  html += '<span class="chat-ts">' + esc(msg.ts) + '</span>';
  html += '<span class="chat-author" style="color:' + nameColor + '">' + esc(msg.a) + '</span>';
  if (badges) html += badges;
  html += '</div>';
  html += '<div class="chat-text">' + esc(msg.m) + '</div>';
  html += '</div></div>';
  return html;
}

function formatCount(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}
