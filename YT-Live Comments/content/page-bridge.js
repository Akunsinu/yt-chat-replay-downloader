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
  // Prefer a player response that matches the URL. On Shorts (and after any SPA nav)
  // window.ytInitialPlayerResponse is STALE — it still holds the FIRST video — while
  // the live player element returns the current one. Choosing by URL id prevents
  // labeling a Short with a previous video's metadata.
  var wantId = new URLSearchParams(location.search).get('v');
  if (!wantId) { var pm = location.pathname.match(/^\/shorts\/([^/?#]+)/); if (pm) wantId = pm[1]; }
  function shape(pr) {
    if (!pr || !pr.videoDetails) return null;
    return { videoDetails: pr.videoDetails, microformat: pr.microformat, streamingData: pr.streamingData };
  }
  var candidates = [];
  try {
    var players = document.querySelectorAll('#movie_player, #shorts-player, .html5-video-player');
    for (var i = 0; i < players.length; i++) {
      if (players[i] && typeof players[i].getPlayerResponse === 'function') {
        var c = shape(players[i].getPlayerResponse());
        if (c) candidates.push(c);
      }
    }
  } catch (e) { /* player may not be ready */ }
  candidates.push(shape(window.ytInitialPlayerResponse));
  var chosen = null, firstAvailable = null;
  for (var j = 0; j < candidates.length; j++) {
    if (!candidates[j]) continue;
    if (!firstAvailable) firstAvailable = candidates[j];
    if (wantId && candidates[j].videoDetails.videoId === wantId) { chosen = candidates[j]; break; }
  }
  payload.playerResponse = chosen || firstAvailable || null;
  if (payload.ytInitialData || payload.innertubeConfig || payload.playerResponse) {
    window.postMessage({
      type: '__YT_CHAT_DL_INITIAL_DATA__',
      data: JSON.stringify(payload)
    }, '*');
  }
})();
