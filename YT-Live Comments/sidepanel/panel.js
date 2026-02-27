// Side panel UI logic for YouTube Video Archiver

const sections = {
  notYoutube: document.getElementById('state-not-youtube'),
  detected: document.getElementById('state-detected'),
};

let currentVideoData = null;
let currentArchiveSteps = {};
let isArchiveRunning = false;

// ─── State Management ───

function showSection(name) {
  Object.values(sections).forEach((s) => s.classList.add('hidden'));
  if (sections[name]) {
    sections[name].classList.remove('hidden');
  }
}

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function setVideoInfo(data) {
  currentVideoData = data;
  const el = document.getElementById('video-info');
  let html = `<div class="title">${escapeHTML(data.title || 'Unknown Video')}</div>`;
  if (data.channelName) html += `<div class="channel">${escapeHTML(data.channelName)}</div>`;

  // Capabilities summary
  const caps = [];
  if (data.chatContinuationToken) caps.push('Live Chat');
  if (data.commentsContinuationToken) caps.push('Comments');
  if (data.hasStreams) {
    const summary = data.streamingSummary;
    caps.push(summary ? `Video (${summary.bestVideoQuality})` : 'Video');
  }
  if (caps.length > 0) {
    html += `<div class="capabilities">${caps.join(' &bull; ')}</div>`;
  }

  el.innerHTML = html;
}

function updateStepUI(steps) {
  currentArchiveSteps = steps || {};
  const stepNames = ['metadata', 'comments', 'liveChat', 'video'];

  for (const name of stepNames) {
    const status = steps[name] || 'pending';
    const iconEl = document.getElementById(`step-icon-${name}`);
    const statusEl = document.getElementById(`step-status-${name}`);
    const stepEl = document.getElementById(`step-${name}`);

    if (!iconEl || !statusEl || !stepEl) continue;

    // Remove all state classes
    stepEl.className = 'step';

    switch (status) {
      case 'pending':
        stepEl.classList.add('step-pending');
        iconEl.textContent = '\u25CB'; // circle
        statusEl.textContent = 'Pending';
        break;
      case 'fetching':
      case 'downloading':
        stepEl.classList.add('step-running');
        iconEl.innerHTML = '<span class="spinner"></span>';
        statusEl.textContent = status === 'downloading' ? 'Downloading...' : 'Fetching...';
        break;
      case 'complete':
        stepEl.classList.add('step-complete');
        iconEl.textContent = '\u2713'; // checkmark
        statusEl.textContent = getCompleteText(name);
        break;
      case 'skipped':
        stepEl.classList.add('step-skipped');
        iconEl.textContent = '\u2014'; // dash
        statusEl.textContent = 'Not available';
        break;
      case 'error':
        stepEl.classList.add('step-error');
        iconEl.textContent = '\u2717'; // x mark
        statusEl.textContent = 'Error';
        break;
    }
  }

  updateButtons();
  updateExportOptions();
}

function getCompleteText(stepName) {
  switch (stepName) {
    case 'metadata': return 'Extracted';
    case 'comments': {
      const count = document.getElementById('step-status-comments')?.dataset?.count;
      return count ? `${parseInt(count).toLocaleString()} comments` : 'Complete';
    }
    case 'liveChat': {
      const count = document.getElementById('step-status-liveChat')?.dataset?.count;
      return count ? `${parseInt(count).toLocaleString()} messages` : 'Complete';
    }
    case 'video': return 'Downloaded';
    default: return 'Complete';
  }
}

function updateButtons() {
  const steps = currentArchiveSteps;
  const anyRunning = Object.values(steps).some(s => s === 'fetching' || s === 'downloading');
  const allDone = Object.values(steps).every(s => s === 'complete' || s === 'skipped' || s === 'error');

  isArchiveRunning = anyRunning;

  const startBtn = document.getElementById('btn-start-archive');
  const stopBtn = document.getElementById('btn-stop-archive');

  if (anyRunning) {
    startBtn.classList.add('hidden');
    stopBtn.classList.remove('hidden');
  } else {
    stopBtn.classList.add('hidden');
    if (allDone) {
      startBtn.textContent = 'Re-Archive';
    } else {
      startBtn.textContent = 'Start Full Archive';
    }
    startBtn.classList.remove('hidden');
  }

  // Individual action buttons
  const commentsBtn = document.getElementById('btn-fetch-comments');
  const chatBtn = document.getElementById('btn-fetch-chat');
  const videoBtn = document.getElementById('btn-download-video');

  commentsBtn.classList.toggle('hidden',
    !currentVideoData?.commentsContinuationToken || steps.comments === 'fetching');
  chatBtn.classList.toggle('hidden',
    !currentVideoData?.chatContinuationToken || steps.liveChat === 'fetching');
  videoBtn.classList.toggle('hidden',
    !currentVideoData?.hasStreams || steps.video === 'downloading');
}

function updateExportOptions() {
  const steps = currentArchiveSteps;

  // Disable/enable based on available data
  const metaOpt = document.getElementById('opt-metadata-csv');
  const commentsCSV = document.getElementById('opt-comments-csv');
  const commentsHTML = document.getElementById('opt-comments-html');
  const chatCSV = document.getElementById('opt-livechat-csv');
  const chatHTML = document.getElementById('opt-livechat-html');

  const hasMetadata = steps.metadata === 'complete';
  const hasComments = steps.comments === 'complete';
  const hasChat = steps.liveChat === 'complete';

  toggleExportOption(metaOpt, hasMetadata);
  toggleExportOption(commentsCSV, hasComments);
  toggleExportOption(commentsHTML, hasComments);
  toggleExportOption(chatCSV, hasChat);
  toggleExportOption(chatHTML, hasChat);
}

function toggleExportOption(el, enabled) {
  if (!el) return;
  const input = el.querySelector('input');
  if (enabled) {
    el.classList.remove('disabled');
    if (input) input.disabled = false;
  } else {
    el.classList.add('disabled');
    if (input) input.disabled = true;
  }
}

// ─── Initialize ───

async function init() {
  console.log('[Panel] init() called');
  try {
    const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    console.log('[Panel] GET_STATE response:', JSON.stringify({
      hasVideoData: !!state?.videoData,
      videoId: state?.videoData?.videoId,
      hasCommentToken: !!state?.videoData?.commentsContinuationToken,
      hasChatToken: !!state?.videoData?.chatContinuationToken,
      hasStreams: !!state?.videoData?.hasStreams,
      commentCount: state?.commentCount,
      messageCount: state?.messageCount,
      archiveSteps: state?.archiveSteps,
    }));
    if (state?.videoData) {
      setVideoInfo(state.videoData);
      showSection('detected');

      if (state.archiveSteps) {
        updateStepUI(state.archiveSteps);
      }

      // Update counts from state
      if (state.commentCount > 0) {
        const statusEl = document.getElementById('step-status-comments');
        if (statusEl) {
          statusEl.dataset.count = state.commentCount;
          if (state.archiveSteps?.comments === 'complete') {
            statusEl.textContent = `${state.commentCount.toLocaleString()} comments`;
          }
        }
      }
      if (state.messageCount > 0) {
        const statusEl = document.getElementById('step-status-liveChat');
        if (statusEl) {
          statusEl.dataset.count = state.messageCount;
          if (state.archiveSteps?.liveChat === 'complete') {
            statusEl.textContent = `${state.messageCount.toLocaleString()} messages`;
          }
        }
      }
    } else {
      console.log('[Panel] No video data, sending CHECK_PAGE');
      chrome.runtime.sendMessage({ type: 'CHECK_PAGE' }).catch(() => {});
      showSection('notYoutube');
    }
  } catch (e) {
    console.error('[Panel] init() error:', e);
    showSection('notYoutube');
    chrome.runtime.sendMessage({ type: 'CHECK_PAGE' }).catch(() => {});
  }
}

// ─── Message Listeners ───

chrome.runtime.onMessage.addListener((message) => {
  console.log('[Panel] Received:', message.type);
  switch (message.type) {
    case 'VIDEO_PAGE_DETECTED':
      setVideoInfo(message.data);
      showSection('detected');
      if (message.data.archiveSteps) {
        updateStepUI(message.data.archiveSteps);
      }
      break;

    case 'NOT_YOUTUBE':
      showSection('notYoutube');
      break;

    case 'ARCHIVE_STEP_UPDATE':
      if (message.data?.archiveSteps) {
        updateStepUI(message.data.archiveSteps);
      }
      break;

    case 'ARCHIVE_COMPLETE':
      isArchiveRunning = false;
      if (message.data?.archiveSteps) {
        updateStepUI(message.data.archiveSteps);
      }
      break;

    case 'ARCHIVE_STOPPED':
      isArchiveRunning = false;
      if (message.data?.archiveSteps) {
        updateStepUI(message.data.archiveSteps);
      }
      break;

    // Comments progress
    case 'COMMENTS_FETCH_STARTED':
      hideError();
      break;

    case 'COMMENTS_PROGRESS': {
      const statusEl = document.getElementById('step-status-comments');
      if (statusEl) {
        statusEl.dataset.count = message.data.commentCount;
        statusEl.textContent = `${message.data.commentCount.toLocaleString()} comments...`;
      }
      break;
    }

    case 'COMMENTS_FETCH_COMPLETE': {
      const statusEl = document.getElementById('step-status-comments');
      if (statusEl) {
        statusEl.dataset.count = message.data.commentCount;
        statusEl.textContent = `${message.data.commentCount.toLocaleString()} comments`;
      }
      break;
    }

    case 'COMMENTS_FETCH_ERROR_MSG':
      showError(message.data?.error || 'Error fetching comments');
      break;

    case 'COMMENTS_RATE_LIMITED':
      document.getElementById('rate-limit-warning').classList.remove('hidden');
      break;

    // Chat progress
    case 'FETCH_STARTED':
      hideError();
      document.getElementById('rate-limit-warning').classList.add('hidden');
      break;

    case 'FETCH_PROGRESS': {
      const statusEl = document.getElementById('step-status-liveChat');
      if (statusEl) {
        statusEl.dataset.count = message.data.messageCount;
        statusEl.textContent = `${message.data.messageCount.toLocaleString()} messages...`;
      }
      break;
    }

    case 'FETCH_COMPLETE': {
      const statusEl = document.getElementById('step-status-liveChat');
      if (statusEl) {
        statusEl.dataset.count = message.data.messageCount;
        statusEl.textContent = `${message.data.messageCount.toLocaleString()} messages`;
      }
      break;
    }

    case 'FETCH_STOPPED': {
      const statusEl = document.getElementById('step-status-liveChat');
      if (statusEl && message.data?.messageCount > 0) {
        statusEl.dataset.count = message.data.messageCount;
        statusEl.textContent = `${message.data.messageCount.toLocaleString()} messages (stopped)`;
      }
      break;
    }

    case 'FETCH_ERROR':
      showError(message.data?.error || 'Error fetching chat');
      break;

    case 'FETCH_RATE_LIMITED':
      document.getElementById('rate-limit-warning').classList.remove('hidden');
      break;

    // Video download
    case 'VIDEO_DOWNLOAD_COMPLETE': {
      const statusEl = document.getElementById('step-status-video');
      if (statusEl) {
        const files = message.data?.files;
        if (files && files.length > 0) {
          statusEl.textContent = `Downloaded (${files.length} file${files.length > 1 ? 's' : ''})`;
        } else {
          statusEl.textContent = 'Downloaded';
        }
      }
      break;
    }

    case 'VIDEO_DOWNLOAD_ERROR':
      showError(message.data?.error || 'Error downloading video');
      break;

    case 'VIDEO_DOWNLOAD_PROGRESS': {
      const statusEl = document.getElementById('step-status-video');
      if (statusEl) {
        const d = message.data;
        if (d.percent != null) {
          let text = `${d.percent.toFixed(1)}%`;
          if (d.totalSize) text += ` of ${d.totalSize}`;
          if (d.speed) text += ` at ${d.speed}`;
          if (d.eta && d.eta !== 'Unknown') text += ` ETA ${d.eta}`;
          statusEl.textContent = text;
        }
      }
      break;
    }
  }
});

function showError(msg) {
  const box = document.getElementById('error-message-box');
  const text = document.getElementById('error-message-text');
  text.textContent = msg;
  box.classList.remove('hidden');
}

function hideError() {
  document.getElementById('error-message-box').classList.add('hidden');
  document.getElementById('rate-limit-warning').classList.add('hidden');
}

// ─── Button Handlers ───

function sendMsg(msg) {
  console.log('[Panel] Sending:', msg.type);
  chrome.runtime.sendMessage(msg).catch(err => {
    console.error('[Panel] sendMessage error for', msg.type, ':', err);
    showError('Extension error: ' + err.message + '. Try reloading the extension.');
  });
}

document.getElementById('btn-start-archive').addEventListener('click', () => {
  console.log('[Panel] Start Archive clicked');
  hideError();
  sendMsg({ type: 'START_ARCHIVE' });
});

document.getElementById('btn-stop-archive').addEventListener('click', () => {
  sendMsg({ type: 'STOP_ARCHIVE' });
});

document.getElementById('btn-fetch-comments').addEventListener('click', () => {
  hideError();
  sendMsg({ type: 'START_COMMENTS_FETCH' });
});

document.getElementById('btn-fetch-chat').addEventListener('click', () => {
  hideError();
  sendMsg({ type: 'START_FETCH' });
});

document.getElementById('btn-download-video').addEventListener('click', () => {
  hideError();
  sendMsg({ type: 'START_VIDEO_DOWNLOAD' });
});

document.getElementById('btn-recheck').addEventListener('click', () => {
  sendMsg({ type: 'CHECK_PAGE' });
});

document.getElementById('btn-download-selected').addEventListener('click', () => {
  const theme = document.querySelector('input[name="theme"]:checked').value;
  const checkboxes = document.querySelectorAll('input[name="export"]:checked');
  const selected = {};
  checkboxes.forEach((cb) => {
    selected[cb.value] = true;
  });

  // If specific exports are checked, trigger them
  if (Object.keys(selected).length === 0) {
    showError('No export options selected.');
    return;
  }

  console.log('[Panel] Exporting:', selected, 'theme:', theme);
  sendMsg({
    type: 'EXPORT_ALL',
    data: { theme, selected },
  });
});

// ─── Start ───
init();
