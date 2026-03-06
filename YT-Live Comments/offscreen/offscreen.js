// Offscreen document for rendering comment/chat screenshots into a zip

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'RENDER_COMMENT_SCREENSHOTS') {
    renderAndZip(message.data).then(sendResponse).catch(e => {
      sendResponse({ error: e.message });
    });
    return true;
  }
});

async function renderAndZip({ comments, chat, theme, folderPrefix }) {
  const c = getThemeColors(theme);
  const renderArea = document.getElementById('renderArea');
  renderArea.style.background = c.bgColor;
  renderArea.style.color = c.textColor;
  renderArea.style.fontFamily = "'Roboto','YouTube Sans',Arial,sans-serif";
  renderArea.style.lineHeight = '1.4';

  // Inject styles for both comments and chat
  const style = document.createElement('style');
  style.textContent = `
    /* Regular comment styles */
    .comment{padding:12px 16px;background:${c.bgColor};border-bottom:1px solid ${c.borderColor}}
    .comment-main{display:flex;gap:12px}
    .comment .avatar{width:40px;height:40px;border-radius:50%;flex-shrink:0}
    .comment-body{flex:1;min-width:0}
    .comment-header{display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap}
    .comment-author{font-size:13px;font-weight:500;color:${c.textColor}}
    .comment-author.owner{background:${c.isDark?'#272727':'#f0f0f0'};padding:1px 6px;border-radius:12px}
    .comment-time{font-size:12px;color:${c.secondaryText}}
    .pin-badge{font-size:11px;color:${c.secondaryText}}
    .heart-badge{color:#ff0000;font-size:12px}
    .comment-text{font-size:14px;white-space:pre-wrap;word-break:break-word;margin-bottom:4px;color:${c.textColor}}
    .comment-actions{font-size:12px;color:${c.secondaryText};display:flex;gap:12px;align-items:center}
    .replies{margin-left:52px;padding-left:0}
    .reply{padding:8px 0;display:flex;gap:10px}
    .reply .avatar{width:24px;height:24px;border-radius:50%}
    .reply .comment-body{flex:1}
    .reply .comment-text{font-size:13px}
    /* Chat message styles */
    .chat-message{padding:8px 16px;background:${c.bgColor};display:flex;align-items:flex-start;gap:12px}
    .chat-message .avatar{width:24px;height:24px;border-radius:50%;flex-shrink:0;margin-top:2px}
    .chat-message .avatar-placeholder{width:24px;height:24px;border-radius:50%;background:${c.secondaryText};flex-shrink:0;margin-top:2px}
    .chat-message .msg-content{flex:1;min-width:0}
    .chat-message .timestamp{color:${c.secondaryText};font-size:11px;margin-right:8px}
    .chat-message .author{font-size:13px;font-weight:500;margin-right:4px}
    .chat-message .text{font-size:13px;word-break:break-word;color:${c.textColor}}
    .chat-message .badge{display:inline-block;font-size:10px;padding:1px 4px;border-radius:2px;margin-right:4px;font-weight:500}
    .chat-message .badge.owner{background:#ffd600;color:#0f0f0f}
    .chat-message .badge.moderator{background:#5e84f1;color:#fff}
    .chat-message .badge.member{background:#2ba640;color:#fff}
    .chat-message.superchat{background:${c.isDark?'#1a3a1a':'#e8f5e9'};border-left:3px solid #ffd600;border-radius:4px;padding:12px 16px}
    .chat-message .superchat-amount{font-weight:700;color:#ffd600;font-size:14px;margin-bottom:4px}
    .chat-message.membership{background:${c.isDark?'#1a2a1a':'#e8f5e9'};border-left:3px solid #2ba640;border-radius:4px;padding:12px 16px}
  `;
  document.head.appendChild(style);

  const zip = new JSZip();
  const totalRC = (comments || []).length;
  const totalChat = (chat || []).length;
  const grandTotal = totalRC + totalChat;
  let processed = 0;

  // Render regular comments
  for (let i = 0; i < totalRC; i++) {
    const cm = comments[i];
    renderArea.innerHTML = buildCommentHTML(cm);
    await waitForImages(renderArea);
    await delay(50);

    try {
      const el = renderArea.firstElementChild;
      const canvas = await html2canvas(el, { backgroundColor: c.bgColor, scale: 2, useCORS: true, width: 600 });
      const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
      const author = safeName(cm.a || 'comment');
      const filename = `${author}_YT_RC_${pad4(i + 1)}-${pad4(totalRC)}_${cm.id || 'unknown'}.png`;
      zip.file(filename, blob);
    } catch (e) {
      console.error('Screenshot failed for comment', cm.id, e);
    }

    processed++;
    if (processed % 10 === 0 || processed === grandTotal) reportProgress(processed, grandTotal);
  }

  // Render live chat messages
  for (let i = 0; i < totalChat; i++) {
    const msg = chat[i];
    renderArea.innerHTML = buildChatMessageHTML(msg, c);
    await waitForImages(renderArea);
    await delay(50);

    try {
      const el = renderArea.firstElementChild;
      const canvas = await html2canvas(el, { backgroundColor: c.bgColor, scale: 2, useCORS: true, width: 600 });
      const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
      const author = safeName(msg.a || 'chat');
      const filename = `${author}_YT_Live_Chat_${pad4(i + 1)}-${pad4(totalChat)}_${msg.id || 'unknown'}.png`;
      zip.file(filename, blob);
    } catch (e) {
      console.error('Screenshot failed for chat msg', msg.id, e);
    }

    processed++;
    if (processed % 10 === 0 || processed === grandTotal) reportProgress(processed, grandTotal);
  }

  const zipBlob = await zip.generateAsync({ type: 'base64' });
  return { base64: zipBlob, count: grandTotal };
}

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

function getThemeColors(theme) {
  const isDark = theme === 'dark';
  return {
    isDark,
    bgColor: isDark ? '#0f0f0f' : '#ffffff',
    textColor: isDark ? '#ffffff' : '#0f0f0f',
    secondaryText: isDark ? '#aaaaaa' : '#606060',
    borderColor: isDark ? '#3f3f3f' : '#e0e0e0',
  };
}

function buildCommentHTML(cm) {
  let badges = '';
  if (cm.pin) badges += '<span class="pin-badge">&#128204; Pinned</span>';
  if (cm.heart) badges += '<span class="heart-badge">&#10084;</span>';
  const authorCls = cm.own ? 'comment-author owner' : 'comment-author';

  let html = '<div class="comment"><div class="comment-main">';
  html += cm.img
    ? '<img class="avatar" src="' + esc(cm.img) + '" alt="" crossorigin="anonymous" />'
    : '<div class="avatar" style="background:#666;border-radius:50%"></div>';
  html += '<div class="comment-body"><div class="comment-header">';
  html += '<span class="' + authorCls + '">' + esc(cm.a) + '</span>';
  html += '<span class="comment-time">' + esc(cm.time) + '</span>' + badges + '</div>';
  html += '<div class="comment-text">' + esc(cm.t) + '</div>';
  html += '<div class="comment-actions">';
  if (cm.likes > 0) html += '<span>&#128077; ' + cm.likes + '</span>';
  if (cm.rc > 0) html += '<span>' + cm.rc + ' replies</span>';
  html += '</div></div></div>';

  if (cm.replies && cm.replies.length > 0) {
    html += '<div class="replies">';
    for (const r of cm.replies) {
      const rBadges = r.heart ? '<span class="heart-badge">&#10084;</span>' : '';
      const rAuthorCls = r.own ? 'comment-author owner' : 'comment-author';
      html += '<div class="reply">';
      html += r.img
        ? '<img class="avatar" src="' + esc(r.img) + '" alt="" crossorigin="anonymous" />'
        : '<div class="avatar" style="background:#666;border-radius:50%;width:24px;height:24px"></div>';
      html += '<div class="comment-body"><div class="comment-header">';
      html += '<span class="' + rAuthorCls + '">' + esc(r.a) + '</span>';
      html += '<span class="comment-time">' + esc(r.time) + '</span>' + rBadges + '</div>';
      html += '<div class="comment-text">' + esc(r.t) + '</div>';
      if (r.likes > 0) html += '<div class="comment-actions"><span>&#128077; ' + r.likes + '</span></div>';
      html += '</div></div>';
    }
    html += '</div>';
  }
  html += '</div>';
  return html;
}

function buildChatMessageHTML(msg, c) {
  let badges = '';
  let nameColor = c.textColor;
  if (msg.o) { nameColor = c.isDark ? '#ffd600' : '#c69000'; badges += '<span class="badge owner">Owner</span>'; }
  if (msg.mod) { nameColor = c.isDark ? '#5e84f1' : '#2962ff'; badges += '<span class="badge moderator">Mod</span>'; }
  if (msg.mem) { badges += '<span class="badge member">Member</span>'; }

  let cls = 'chat-message';
  let scHeader = '';
  if (msg.t === 'superchat') { cls += ' superchat'; scHeader = '<div class="superchat-amount">' + esc(msg.sc) + '</div>'; }
  else if (msg.t === 'membership') { cls += ' membership'; }
  else if (msg.t === 'supersticker') { cls += ' superchat'; scHeader = '<div class="superchat-amount">' + esc(msg.sc) + '</div>'; }

  const img = msg.img
    ? '<img class="avatar" src="' + esc(msg.img) + '" alt="" crossorigin="anonymous" />'
    : '<div class="avatar-placeholder"></div>';

  return '<div class="' + cls + '">' + scHeader +
    img + '<div class="msg-content">' +
    '<span class="timestamp">' + esc(msg.ts) + '</span>' +
    '<span class="author" style="color:' + nameColor + '">' + esc(msg.a) + '</span>' +
    badges +
    '<span class="text">' + esc(msg.m) + '</span>' +
    '</div></div>';
}
