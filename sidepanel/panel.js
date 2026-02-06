// Side panel UI logic

const sections = {
  notYoutube: document.getElementById('state-not-youtube'),
  noReplay: document.getElementById('state-no-replay'),
  ready: document.getElementById('state-ready'),
  fetching: document.getElementById('state-fetching'),
  complete: document.getElementById('state-complete'),
  error: document.getElementById('state-error'),
};

const videoInfoEls = {
  noReplay: document.getElementById('no-replay-video-info'),
  ready: document.getElementById('ready-video-info'),
  fetching: document.getElementById('fetching-video-info'),
  complete: document.getElementById('complete-video-info'),
  error: document.getElementById('error-video-info'),
};

let currentVideoData = null;

// ─── State Management ───

function showSection(name) {
  Object.values(sections).forEach((s) => s.classList.add('hidden'));
  if (sections[name]) {
    sections[name].classList.remove('hidden');
  }
}

function setVideoInfo(data) {
  currentVideoData = data;
  const html = `
    <div class="title">${escapeHTML(data.title || 'Unknown Video')}</div>
    ${data.channelName ? `<div class="channel">${escapeHTML(data.channelName)}</div>` : ''}
  `;
  Object.values(videoInfoEls).forEach((el) => {
    el.innerHTML = html;
  });
}

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ─── Initialize ───

async function init() {
  // Get current state from background
  try {
    const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    if (state?.videoData) {
      setVideoInfo(state.videoData);

      if (state.videoData.noChatReplay) {
        showSection('noReplay');
      } else if (state.fetchState === 'fetching') {
        showSection('fetching');
        updateMessageCount(state.messageCount);
      } else if (state.fetchState === 'complete') {
        showSection('complete');
        document.getElementById('total-messages').textContent =
          state.messageCount.toLocaleString();
      } else if (state.fetchState === 'stopped') {
        showSection('complete');
        document.getElementById('total-messages').textContent =
          state.messageCount.toLocaleString();
      } else if (state.fetchState === 'error') {
        showSection('error');
      } else {
        showSection('ready');
      }
    } else {
      // Ask content script to check
      chrome.runtime.sendMessage({ type: 'CHECK_PAGE' });
      showSection('notYoutube');
    }
  } catch (e) {
    showSection('notYoutube');
    chrome.runtime.sendMessage({ type: 'CHECK_PAGE' });
  }
}

// ─── Message Listeners ───

chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case 'VIDEO_DETECTED':
      setVideoInfo(message.data);
      showSection('ready');
      break;

    case 'NO_CHAT_REPLAY':
      setVideoInfo(message.data);
      showSection('noReplay');
      break;

    case 'NOT_YOUTUBE':
      showSection('notYoutube');
      break;

    case 'FETCH_STARTED':
      showSection('fetching');
      updateMessageCount(0);
      document.getElementById('rate-limit-warning').classList.add('hidden');
      break;

    case 'FETCH_PROGRESS':
      updateMessageCount(message.data.messageCount);
      updatePreview(message.data.lastMessages);
      break;

    case 'FETCH_RATE_LIMITED':
      document.getElementById('rate-limit-warning').classList.remove('hidden');
      break;

    case 'FETCH_COMPLETE':
      showSection('complete');
      document.getElementById('total-messages').textContent =
        message.data.messageCount.toLocaleString();
      break;

    case 'FETCH_STOPPED':
      showSection('complete');
      document.getElementById('total-messages').textContent =
        message.data.messageCount.toLocaleString();
      break;

    case 'FETCH_ERROR':
      showSection('error');
      document.getElementById('error-message').textContent =
        message.data.error || 'An error occurred while fetching chat data.';
      if (message.data.messageCount > 0) {
        document.getElementById('error-partial').classList.remove('hidden');
        document.getElementById('error-message-count').textContent =
          message.data.messageCount.toLocaleString();
      }
      break;
  }
});

function updateMessageCount(count) {
  document.getElementById('message-count').textContent =
    count.toLocaleString();
}

function updatePreview(messages) {
  if (!messages || messages.length === 0) return;
  const container = document.getElementById('preview-messages');

  for (const msg of messages) {
    const div = document.createElement('div');
    div.className = `preview-msg ${msg.message_type !== 'text' ? msg.message_type : ''}`;
    div.innerHTML = `
      <span class="ts">[${escapeHTML(msg.timestamp_text)}]</span>
      <span class="author">${escapeHTML(msg.author_name)}:</span>
      <span class="text">${escapeHTML(msg.message)}</span>
    `;
    container.appendChild(div);
  }

  // Keep only last 20 messages in preview
  while (container.children.length > 20) {
    container.removeChild(container.firstChild);
  }

  // Scroll to bottom
  container.scrollTop = container.scrollHeight;
}

// ─── Button Handlers ───

document.getElementById('btn-start').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'START_FETCH' });
});

document.getElementById('btn-stop').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'STOP_FETCH' });
});

document.getElementById('btn-recheck').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'CHECK_PAGE' });
});

document.getElementById('btn-retry').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'START_FETCH' });
});

document.getElementById('btn-refetch').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'START_FETCH' });
});

document.getElementById('btn-download').addEventListener('click', () => {
  const format = document.querySelector('input[name="format"]:checked').value;
  const theme = document.querySelector('input[name="theme"]:checked').value;
  const filters = Array.from(
    document.querySelectorAll('input[name="filter"]:checked')
  ).map((el) => el.value);

  if (format === 'csv') {
    chrome.runtime.sendMessage({ type: 'EXPORT_CSV', data: { filters } });
  } else {
    chrome.runtime.sendMessage({
      type: 'EXPORT_HTML',
      data: { theme, filters },
    });
  }
});

// Handle partial download from error state
document.getElementById('btn-download-partial')?.addEventListener('click', () => {
  const filters = ['text', 'superchat', 'membership', 'supersticker'];
  chrome.runtime.sendMessage({ type: 'EXPORT_CSV', data: { filters } });
});

// Show/hide theme options based on format selection
document.querySelectorAll('input[name="format"]').forEach((radio) => {
  radio.addEventListener('change', (e) => {
    const themeOptions = document.getElementById('theme-options');
    if (e.target.value === 'html') {
      themeOptions.classList.remove('hidden');
    } else {
      themeOptions.classList.add('hidden');
    }
  });
});

// ─── Start ───
init();
