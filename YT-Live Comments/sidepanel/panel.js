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
  if (data.videoId) {
    const summary = data.hasStreams && data.streamingSummary;
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

  // Sync the video progress bar with the step state. Anything other than
  // 'downloading' should hide it; 'downloading' before the first percent
  // arrives shows an indeterminate pulse.
  if (steps.video === 'downloading') {
    const fill = document.getElementById('step-progress-video-fill');
    const wasShown = !document.getElementById('step-progress-video')?.classList.contains('hidden');
    if (!wasShown) showVideoProgress({ indeterminate: true });
    else if (fill && !fill.style.width) showVideoProgress({ indeterminate: true });
  } else {
    hideVideoProgress();
  }

  updateButtons();
  updateExportOptions();
}

// ─── Video progress bar helpers ───

function showVideoProgress({ percent = null, indeterminate = false } = {}) {
  const wrap = document.getElementById('step-progress-video');
  const fill = document.getElementById('step-progress-video-fill');
  if (!wrap || !fill) return;
  wrap.classList.remove('hidden');
  if (percent != null) {
    fill.classList.remove('indeterminate');
    fill.style.marginLeft = '';
    fill.style.width = Math.max(0, Math.min(100, percent)) + '%';
  } else if (indeterminate) {
    fill.classList.add('indeterminate');
    fill.style.width = '';
    fill.style.marginLeft = '';
  }
}

function hideVideoProgress() {
  const wrap = document.getElementById('step-progress-video');
  const fill = document.getElementById('step-progress-video-fill');
  if (wrap) wrap.classList.add('hidden');
  if (fill) {
    fill.classList.remove('indeterminate');
    fill.style.width = '0%';
    fill.style.marginLeft = '';
  }
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
  // yt-dlp handles its own URL resolution — show button whenever there's a videoId.
  // hasStreams only reflects whether direct (signature-free) URLs were exposed in the page,
  // which is increasingly rare on YouTube and unrelated to whether yt-dlp can download.
  videoBtn.classList.toggle('hidden',
    !currentVideoData?.videoId || steps.video === 'downloading');
}

function updateExportOptions() {
  const steps = currentArchiveSteps;

  // Disable/enable based on available data
  const metaOpt = document.getElementById('opt-metadata-csv');
  const commentsCSV = document.getElementById('opt-comments-csv');
  const commentsHTML = document.getElementById('opt-comments-html');
  const commentScreenshots = document.getElementById('opt-comment-screenshots');
  const chatCSV = document.getElementById('opt-livechat-csv');
  const chatHTML = document.getElementById('opt-livechat-html');

  const hasMetadata = steps.metadata === 'complete';
  const hasComments = steps.comments === 'complete';
  const hasChat = steps.liveChat === 'complete';

  toggleExportOption(metaOpt, hasMetadata);
  toggleExportOption(commentsCSV, hasComments);
  toggleExportOption(commentsHTML, hasComments);
  toggleExportOption(commentScreenshots, hasComments || hasChat);
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

// ─── Setup status (yt-dlp + native host) ───

const SETUP_CLASSES = ['setup-ok', 'setup-warn', 'setup-error', 'setup-checking'];

function applySetupStatus({ klass, label, summary, showSteps }) {
  const section = document.getElementById('setup-status');
  const labelEl = document.getElementById('setup-label');
  const summaryEl = document.getElementById('setup-summary');
  const stepsEl = document.getElementById('setup-install-steps');
  if (!section) return;

  SETUP_CLASSES.forEach(c => section.classList.remove(c));
  section.classList.add(klass);
  labelEl.textContent = label;
  summaryEl.textContent = summary || '';
  stepsEl.classList.toggle('hidden', !showSteps);
}

function setSetupExpanded(expanded) {
  const details = document.getElementById('setup-details');
  const toggle = document.getElementById('btn-setup-toggle');
  details.classList.toggle('hidden', !expanded);
  toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  toggle.textContent = expanded ? 'Hide' : 'Details';
}

async function runSetupCheck({ force = false, autoExpandOnProblem = false } = {}) {
  applySetupStatus({
    klass: 'setup-checking',
    label: 'Checking video downloader…',
    summary: '',
    showSteps: false,
  });

  let result;
  try {
    result = await chrome.runtime.sendMessage({ type: 'CHECK_NATIVE_HOST', force });
  } catch (e) {
    result = { status: 'host_missing', error: e?.message || 'No response from background worker' };
  }

  if (!result || typeof result !== 'object') {
    result = { status: 'host_missing', error: 'Empty response from background worker' };
  }

  if (result.status === 'ok') {
    const v = result.version ? ` (yt-dlp ${result.version})` : '';
    applySetupStatus({
      klass: 'setup-ok',
      label: `Video downloads ready${v}`,
      summary: 'yt-dlp is installed and the native messaging host is reachable. Video downloads will work.',
      showSteps: false,
    });
    // Stay collapsed when everything works.
    return result;
  }

  if (result.status === 'ytdlp_missing') {
    applySetupStatus({
      klass: 'setup-warn',
      label: 'yt-dlp not found on PATH',
      summary: 'The native messaging host is registered, but it could not find the yt-dlp binary. Install it (step 1) and re-check.',
      showSteps: true,
    });
  } else {
    // host_missing or anything unexpected
    applySetupStatus({
      klass: 'setup-warn',
      label: 'Video downloader not configured',
      summary: result.error
        ? `Native messaging host unreachable: ${result.error}`
        : 'Native messaging host is not registered yet.',
      showSteps: true,
    });
  }

  if (autoExpandOnProblem) setSetupExpanded(true);
  return result;
}

document.getElementById('btn-setup-toggle').addEventListener('click', () => {
  const details = document.getElementById('setup-details');
  setSetupExpanded(details.classList.contains('hidden'));
});

document.getElementById('btn-setup-recheck').addEventListener('click', () => {
  runSetupCheck({ force: true });
});

// ─── Walkthrough modal ───

const WALKTHROUGH_TOTAL_STEPS = 5;
let walkthroughStep = 0;

function setWalkthroughStep(i) {
  walkthroughStep = Math.max(0, Math.min(WALKTHROUGH_TOTAL_STEPS - 1, i));

  document.querySelectorAll('.walkthrough-step').forEach(el => {
    el.classList.toggle('active', Number(el.dataset.step) === walkthroughStep);
  });
  document.querySelectorAll('.walkthrough-dot').forEach(el => {
    el.classList.toggle('active', Number(el.dataset.step) === walkthroughStep);
  });

  const prevBtn = document.getElementById('btn-walkthrough-prev');
  const nextBtn = document.getElementById('btn-walkthrough-next');
  prevBtn.disabled = walkthroughStep === 0;
  prevBtn.style.visibility = walkthroughStep === 0 ? 'hidden' : 'visible';
  nextBtn.textContent = walkthroughStep === WALKTHROUGH_TOTAL_STEPS - 1 ? 'Done' : 'Next →';

  // Reset scroll on step change so each step starts at the top.
  document.querySelector('.walkthrough-body').scrollTop = 0;
}

function openWalkthrough() {
  document.getElementById('walkthrough-overlay').classList.remove('hidden');
  setWalkthroughStep(0);
  document.body.style.overflow = 'hidden';
}

function closeWalkthrough() {
  document.getElementById('walkthrough-overlay').classList.add('hidden');
  document.body.style.overflow = '';
}

document.getElementById('btn-show-walkthrough').addEventListener('click', openWalkthrough);
document.getElementById('btn-walkthrough-close').addEventListener('click', closeWalkthrough);
document.getElementById('btn-walkthrough-prev').addEventListener('click', () => setWalkthroughStep(walkthroughStep - 1));
document.getElementById('btn-walkthrough-next').addEventListener('click', () => {
  if (walkthroughStep === WALKTHROUGH_TOTAL_STEPS - 1) {
    closeWalkthrough();
    // Re-check immediately after closing — the user just finished setup.
    runSetupCheck({ force: true });
  } else {
    setWalkthroughStep(walkthroughStep + 1);
  }
});

// Click backdrop to close
document.getElementById('walkthrough-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'walkthrough-overlay') closeWalkthrough();
});

// Click any dot to jump
document.querySelectorAll('.walkthrough-dot').forEach(dot => {
  dot.style.cursor = 'pointer';
  dot.addEventListener('click', () => setWalkthroughStep(Number(dot.dataset.step)));
});

// Copy buttons inside terminal mockups. Each button has a `data-copy-target`
// containing the exact command to copy (just the command, not the fake output).
document.querySelectorAll('.mock-copy-btn').forEach(btn => {
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const text = btn.dataset.copyTarget || '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      const original = btn.textContent;
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = original;
        btn.classList.remove('copied');
      }, 1500);
    } catch (err) {
      console.error('[Panel] Copy failed:', err);
      btn.textContent = 'Copy failed';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    }
  });
});

// Esc to close, arrow keys to navigate
document.addEventListener('keydown', (e) => {
  const overlay = document.getElementById('walkthrough-overlay');
  if (!overlay || overlay.classList.contains('hidden')) return;
  if (e.key === 'Escape') closeWalkthrough();
  else if (e.key === 'ArrowLeft' && walkthroughStep > 0) setWalkthroughStep(walkthroughStep - 1);
  else if (e.key === 'ArrowRight' && walkthroughStep < WALKTHROUGH_TOTAL_STEPS - 1) setWalkthroughStep(walkthroughStep + 1);
});

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
      hideVideoProgress();
      break;
    }

    case 'VIDEO_DOWNLOAD_ERROR':
      showError(message.data?.error || 'Error downloading video');
      hideVideoProgress();
      // The download path failing is the strongest signal that the setup state
      // changed (or was never right). Force a re-check so the panel reflects
      // reality and the install steps appear if needed.
      runSetupCheck({ force: true, autoExpandOnProblem: true });
      break;

    case 'VIDEO_DOWNLOAD_STATUS': {
      // Pre-download / merging phases — yt-dlp doesn't emit a percent here,
      // so use the indeterminate animation and surface the message text.
      const msg = message.data?.message || '';
      const statusEl = document.getElementById('step-status-video');
      if (statusEl && msg) statusEl.textContent = msg;
      showVideoProgress({ indeterminate: true });
      break;
    }

    case 'VIDEO_DOWNLOAD_PROGRESS': {
      const statusEl = document.getElementById('step-status-video');
      const d = message.data;
      if (statusEl && d.percent != null) {
        let text = `${d.percent.toFixed(1)}%`;
        if (d.totalSize) text += ` of ${d.totalSize}`;
        if (d.speed) text += ` at ${d.speed}`;
        if (d.eta && d.eta !== 'Unknown') text += ` ETA ${d.eta}`;
        statusEl.textContent = text;
      }
      if (d?.percent != null) {
        showVideoProgress({ percent: d.percent });
      }
      break;
    }

    // Screenshot progress
    case 'SCREENSHOT_PROGRESS': {
      const d = message.data;
      if (d) {
        showScreenshotProgress(d.current, d.total);
      }
      break;
    }

    case 'SCREENSHOT_COMPLETE':
      hideScreenshotProgress();
      break;

    case 'SCREENSHOT_ERROR':
      hideScreenshotProgress();
      showError(message.data?.error || 'Screenshot export failed');
      break;

    case 'STORAGE_WARNING':
    case 'MEMORY_WARNING':
      if (message.data?.message) showError(message.data.message);
      break;

    case 'EXPORT_PROGRESS': {
      const d = message.data || {};
      showExportProgress(d.current || 0, d.total || 0, d.name || '');
      break;
    }

    case 'EXPORT_COMPLETE': {
      hideExportProgress();
      const d = message.data || {};
      if (d.skipped && d.skipped.length > 0) {
        showError(`Done. Skipped: ${d.skipped.join('; ')}`);
      } else {
        hideError();
      }
      break;
    }

    case 'EXPORT_ERROR':
      hideExportProgress();
      showError(message.data?.error || 'Export failed');
      break;
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

function showScreenshotProgress(current, total) {
  const container = document.getElementById('screenshot-progress');
  const fill = document.getElementById('screenshot-progress-fill');
  const count = document.getElementById('screenshot-progress-count');
  const label = document.getElementById('screenshot-progress-label');
  const btn = document.getElementById('btn-download-selected');

  container.classList.remove('hidden');
  btn.disabled = true;
  btn.textContent = 'Exporting...';

  const pct = total > 0 ? (current / total * 100) : 0;
  fill.style.width = pct + '%';
  count.textContent = `${current.toLocaleString()} / ${total.toLocaleString()}`;
  label.textContent = current >= total ? 'Zipping screenshots...' : 'Rendering screenshots...';
}

function showExportProgress(current, total, name) {
  const container = document.getElementById('export-progress');
  const fill = document.getElementById('export-progress-fill');
  const count = document.getElementById('export-progress-count');
  const label = document.getElementById('export-progress-label');
  const btn = document.getElementById('btn-download-selected');

  container.classList.remove('hidden');
  btn.disabled = true;
  btn.textContent = 'Exporting...';

  // Show progress as "completed-1 of total" while item N is in flight, so the
  // bar reads honestly: an export that's currently running is counted toward
  // "in progress," not "done."
  const inFlight = Math.max(0, current - 1);
  const pct = total > 0 ? (inFlight / total * 100) : 0;
  fill.style.width = pct + '%';
  count.textContent = `${current} / ${total}`;
  label.textContent = name ? `Generating: ${name}` : 'Preparing exports…';
}

function hideExportProgress() {
  const container = document.getElementById('export-progress');
  const btn = document.getElementById('btn-download-selected');
  container.classList.add('hidden');
  btn.disabled = false;
  btn.textContent = 'Download Selected';
}

function hideScreenshotProgress() {
  const container = document.getElementById('screenshot-progress');
  const btn = document.getElementById('btn-download-selected');
  container.classList.add('hidden');
  btn.disabled = false;
  btn.textContent = 'Download Selected';
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
// Auto-expand the install help if it isn't set up yet — first-run users see
// the steps without needing to click "Details".
runSetupCheck({ autoExpandOnProblem: true });
