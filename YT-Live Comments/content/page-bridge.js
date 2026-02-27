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
  if (window.ytInitialPlayerResponse) {
    var yp = window.ytInitialPlayerResponse;
    payload.playerResponse = {
      videoDetails: yp.videoDetails,
      microformat: yp.microformat,
      streamingData: yp.streamingData,
    };
  }
  // Fallback for SPA navigation: ytInitialPlayerResponse is cleared after first load.
  // Try to get playerResponse from the movie_player element's getPlayerResponse method.
  if (!payload.playerResponse) {
    try {
      var player = document.getElementById('movie_player');
      if (player && typeof player.getPlayerResponse === 'function') {
        var pr = player.getPlayerResponse();
        if (pr) {
          payload.playerResponse = {
            videoDetails: pr.videoDetails,
            microformat: pr.microformat,
            streamingData: pr.streamingData,
          };
        }
      }
    } catch (e) {
      // Ignore - player may not be ready
    }
  }
  if (payload.ytInitialData || payload.innertubeConfig || payload.playerResponse) {
    window.postMessage({
      type: '__YT_CHAT_DL_INITIAL_DATA__',
      data: JSON.stringify(payload)
    }, '*');
  }
})();
