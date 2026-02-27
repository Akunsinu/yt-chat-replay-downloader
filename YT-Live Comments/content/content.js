// Content script for YouTube pages
// Detects video pages, extracts metadata, streaming data, chat replay tokens,
// comments continuation tokens, and performs API fetches (runs in YouTube's origin for cookie access)

(function () {
  'use strict';

  let lastVideoId = null;
  let fetchAbortController = null;
  let isFetching = false;
  let commentsFetchAbortController = null;
  let isFetchingComments = false;
  let cachedStreamingData = null;

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
          console.error('[YT Archiver] Failed to parse ytInitialData:', e);
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
      console.error('[YT Archiver] Error extracting chat continuation:', e);
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
      console.error('[YT Archiver] Error extracting video info:', e);
    }
    if (!info.title) {
      const titleEl = document.querySelector('h1.ytd-watch-metadata yt-formatted-string');
      if (titleEl) info.title = titleEl.textContent.trim();
    }
    return info;
  }

  // ─── Metadata Extraction ───

  function extractFullMetadata(ytInitialData, playerResponse) {
    const metadata = {};
    try {
      // From playerResponse.videoDetails
      const vd = playerResponse?.videoDetails;
      if (vd) {
        metadata.videoId = vd.videoId || '';
        metadata.title = vd.title || '';
        metadata.lengthSeconds = vd.lengthSeconds || '';
        metadata.keywords = (vd.keywords || []).join(', ');
        metadata.channelId = vd.channelId || '';
        metadata.shortDescription = vd.shortDescription || '';
        metadata.viewCount = vd.viewCount || '';
        metadata.author = vd.author || '';
        metadata.isLiveContent = vd.isLiveContent || false;
        // Thumbnail
        const thumbs = vd.thumbnail?.thumbnails;
        if (thumbs?.length > 0) {
          metadata.thumbnail = thumbs[thumbs.length - 1].url;
        }
      }

      // From playerResponse.microformat
      const mf = playerResponse?.microformat?.playerMicroformatRenderer;
      if (mf) {
        metadata.publishDate = mf.publishDate || '';
        metadata.uploadDate = mf.uploadDate || '';
        metadata.category = mf.category || '';
        metadata.description = mf.description?.simpleText || metadata.shortDescription || '';
        metadata.isFamilySafe = mf.isFamilySafe;
        metadata.isUnlisted = mf.isUnlisted;
        metadata.ownerChannelName = mf.ownerChannelName || '';
        metadata.ownerProfileUrl = mf.ownerProfileUrl || '';
        metadata.externalChannelId = mf.externalChannelId || '';
        metadata.lengthSeconds = mf.lengthSeconds || metadata.lengthSeconds;
      }

      // From ytInitialData: likes, subscriber count
      const contents = ytInitialData?.contents?.twoColumnWatchNextResults?.results?.results?.contents;
      if (contents) {
        for (const content of contents) {
          // Likes from videoPrimaryInfoRenderer
          const primary = content.videoPrimaryInfoRenderer;
          if (primary) {
            // Try to get like count from topLevelButtons or menu
            const buttons = primary.videoActions?.menuRenderer?.topLevelButtons || [];
            for (const btn of buttons) {
              const toggleBtn = btn.segmentedLikeDislikeButtonViewModel ||
                btn.segmentedLikeDislikeButtonRenderer;
              if (toggleBtn) {
                const likeBtn = toggleBtn.likeButtonViewModel?.likeButtonViewModel?.toggleButtonViewModel?.toggleButtonViewModel?.defaultButtonViewModel?.buttonViewModel;
                if (likeBtn?.title) {
                  metadata.likeCount = likeBtn.title;
                }
              }
              // Fallback: toggleButtonRenderer
              const toggle = btn.toggleButtonRenderer;
              if (toggle?.defaultText?.accessibility?.accessibilityData?.label) {
                const label = toggle.defaultText.accessibility.accessibilityData.label;
                if (label.toLowerCase().includes('like')) {
                  metadata.likeCount = metadata.likeCount || label;
                }
              }
            }
            // View count
            if (primary.viewCount?.videoViewCountRenderer?.viewCount?.simpleText) {
              metadata.viewCountText = primary.viewCount.videoViewCountRenderer.viewCount.simpleText;
            } else if (primary.viewCount?.videoViewCountRenderer?.viewCount?.runs) {
              metadata.viewCountText = primary.viewCount.videoViewCountRenderer.viewCount.runs.map(r => r.text).join('');
            }
            // Date text
            if (primary.dateText?.simpleText) {
              metadata.dateText = primary.dateText.simpleText;
            } else if (primary.relativeDateText?.simpleText) {
              metadata.dateText = primary.relativeDateText.simpleText;
            }
          }

          // Subscriber count from videoSecondaryInfoRenderer
          const secondary = content.videoSecondaryInfoRenderer;
          if (secondary?.owner?.videoOwnerRenderer?.subscriberCountText?.simpleText) {
            metadata.subscriberCount = secondary.owner.videoOwnerRenderer.subscriberCountText.simpleText;
          }
          // Channel avatar
          const ownerThumbs = secondary?.owner?.videoOwnerRenderer?.thumbnail?.thumbnails;
          if (ownerThumbs?.length > 0) {
            metadata.channelAvatar = ownerThumbs[ownerThumbs.length - 1].url;
          }
        }
      }
    } catch (e) {
      console.error('[YT Archiver] Error extracting metadata:', e);
    }
    return metadata;
  }

  // ─── Video Stream URL Extraction ───

  function extractStreamingData(playerResponse) {
    if (!playerResponse?.streamingData) return null;

    const sd = playerResponse.streamingData;
    const result = {
      formats: [],
      adaptiveFormats: [],
      expiresInSeconds: sd.expiresInSeconds || '',
    };

    // Muxed formats (video+audio combined, lower quality)
    for (const fmt of (sd.formats || [])) {
      if (!fmt.url) continue; // skip signatureCipher
      result.formats.push({
        itag: fmt.itag,
        url: fmt.url,
        mimeType: fmt.mimeType || '',
        qualityLabel: fmt.qualityLabel || '',
        width: fmt.width || 0,
        height: fmt.height || 0,
        contentLength: fmt.contentLength || '',
        bitrate: fmt.bitrate || 0,
        fps: fmt.fps || 0,
      });
    }

    // Adaptive formats (separate video-only and audio-only, higher quality)
    for (const fmt of (sd.adaptiveFormats || [])) {
      if (!fmt.url) continue; // skip signatureCipher
      result.adaptiveFormats.push({
        itag: fmt.itag,
        url: fmt.url,
        mimeType: fmt.mimeType || '',
        qualityLabel: fmt.qualityLabel || '',
        width: fmt.width || 0,
        height: fmt.height || 0,
        contentLength: fmt.contentLength || '',
        bitrate: fmt.bitrate || 0,
        fps: fmt.fps || 0,
        audioQuality: fmt.audioQuality || '',
        audioSampleRate: fmt.audioSampleRate || '',
        audioChannels: fmt.audioChannels || 0,
      });
    }

    return result;
  }

  function getStreamingSummary(streamingData) {
    if (!streamingData) return null;

    const videoFormats = streamingData.adaptiveFormats.filter(f => f.mimeType.startsWith('video/'));
    const audioFormats = streamingData.adaptiveFormats.filter(f => f.mimeType.startsWith('audio/'));
    const muxedFormats = streamingData.formats;

    const bestVideo = videoFormats.sort((a, b) => (b.height || 0) - (a.height || 0))[0];
    const bestAudio = audioFormats.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];

    return {
      bestVideoQuality: bestVideo?.qualityLabel || (muxedFormats[0]?.qualityLabel) || 'unknown',
      bestAudioBitrate: bestAudio ? Math.round(bestAudio.bitrate / 1000) + 'kbps' : 'unknown',
      hasMuxed: muxedFormats.length > 0,
      hasAdaptive: videoFormats.length > 0,
      formatCount: muxedFormats.length + streamingData.adaptiveFormats.length,
      videoFormatCount: videoFormats.length + muxedFormats.length,
      audioFormatCount: audioFormats.length,
    };
  }

  // ─── Player API Fallback for Stream URLs ───

  async function fetchPlayerStreams(videoId) {
    // YouTube's WEB client no longer provides direct URLs (uses server ABR).
    // Use ANDROID client which still returns direct format URLs.
    const cfg = cachedInnertubeConfig || {};
    const apiKey = cfg.apiKey || 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
    const visitorData = cfg.visitorData || '';

    const apiUrl = `https://www.youtube.com/youtubei/v1/player?key=${apiKey}&prettyPrint=false`;

    const clientContext = {
      clientName: 'ANDROID',
      clientVersion: '19.29.37',
      platform: 'MOBILE',
      androidSdkVersion: 34,
    };
    if (visitorData) clientContext.visitorData = visitorData;

    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          context: { client: clientContext },
          videoId,
        }),
      });

      if (!response.ok) {
        console.warn('[YT Archiver] Player API returned', response.status);
        return null;
      }

      const data = await response.json();
      const playerSD = data?.streamingData;
      if (!playerSD) {
        console.warn('[YT Archiver] Player API returned no streamingData');
        return null;
      }

      const result = extractStreamingData({ streamingData: playerSD });
      if (result && (result.formats.length > 0 || result.adaptiveFormats.length > 0)) {
        console.log('[YT Archiver] Player API: got', result.formats.length, 'muxed +', result.adaptiveFormats.length, 'adaptive formats with direct URLs');
        return result;
      }

      console.warn('[YT Archiver] Player API: no formats with direct URLs');
      return null;
    } catch (e) {
      console.error('[YT Archiver] Player API error:', e);
      return null;
    }
  }

  // ─── Comments Continuation Token Extraction ───

  function extractCommentsContinuationToken(ytInitialData) {
    if (!ytInitialData) return null;
    try {
      const contents = ytInitialData?.contents?.twoColumnWatchNextResults?.results?.results?.contents;
      if (!contents) return null;

      for (const content of contents) {
        const section = content.itemSectionRenderer;
        if (!section) continue;

        // Look for the comments section
        const sectionContents = section.contents;
        if (!sectionContents) continue;

        for (const item of sectionContents) {
          if (item.continuationItemRenderer) {
            const token = item.continuationItemRenderer.continuationEndpoint?.continuationCommand?.token;
            if (token) return token;
          }
          if (item.messageRenderer) {
            // Comments disabled
            continue;
          }
        }
      }
    } catch (e) {
      console.error('[YT Archiver] Error extracting comments continuation:', e);
    }
    return null;
  }

  // Helper to extract continuation token from a continuationItemRenderer
  function extractContinuationFromItem(renderer) {
    if (!renderer) return null;
    // Path 1: Direct continuationEndpoint
    const token1 = renderer.continuationEndpoint?.continuationCommand?.token;
    if (token1) return token1;
    // Path 2: Button path
    const token2 = renderer.button?.buttonRenderer?.command?.continuationCommand?.token;
    if (token2) return token2;
    // Path 3: commandExecutorCommand wrapping (newer YouTube format)
    const commands = renderer.continuationEndpoint?.commandExecutorCommand?.commands || [];
    for (const cmd of commands) {
      if (cmd.continuationCommand?.token) return cmd.continuationCommand.token;
    }
    const btnCommands = renderer.button?.buttonRenderer?.command?.commandExecutorCommand?.commands || [];
    for (const cmd of btnCommands) {
      if (cmd.continuationCommand?.token) return cmd.continuationCommand.token;
    }
    return null;
  }

  // ─── Comments Fetching ───

  async function fetchAllComments(initialContinuation) {
    console.log('[YT Archiver] fetchAllComments called, isFetchingComments:', isFetchingComments, 'token length:', initialContinuation?.length);
    if (isFetchingComments) {
      console.log('[YT Archiver] fetchAllComments: already fetching, skipping');
      return;
    }
    isFetchingComments = true;
    commentsFetchAbortController = new AbortController();

    let continuation = initialContinuation;
    let retryCount = 0;
    const maxRetries = 3;
    let topLevelCount = 0;
    let replyCount = 0;
    const replyContinuations = []; // { token, parentCommentId }
    let isFirstPage = true;
    let pageNum = 0;

    // Phase 1: Fetch top-level comments
    while (continuation && isFetchingComments) {
      try {
        console.log('[YT Archiver] Phase 1: fetching page', pageNum, ', isFirstPage:', isFirstPage,
          ', continuation len:', continuation.length);
        const result = await fetchCommentsPage(continuation, commentsFetchAbortController.signal, isFirstPage);
        isFirstPage = false;
        pageNum++;

        if (!result) {
          console.warn('[YT Archiver] Phase 1: page', pageNum - 1, 'returned null result');
          retryCount++;
          if (retryCount >= maxRetries) {
            isFetchingComments = false;
            chrome.runtime.sendMessage({
              type: 'COMMENTS_FETCH_ERROR',
              data: { error: 'Failed to fetch comments after multiple retries' },
            }).catch(() => {});
            return;
          }
          await sleep(1000 * Math.pow(2, retryCount));
          continue;
        }

        retryCount = 0;
        const { comments, nextContinuation, replyTokens } = result;

        topLevelCount += comments.length;
        replyContinuations.push(...replyTokens);
        console.log('[YT Archiver] Phase 1 page', pageNum - 1, ': got', comments.length,
          'comments (total:', topLevelCount, '), reply tokens:', replyTokens.length,
          '(total:', replyContinuations.length, '), nextCont:', !!nextContinuation);

        if (comments.length > 0) {
          chrome.runtime.sendMessage({
            type: 'COMMENTS_PAGE_RESULT',
            data: { comments, topLevel: topLevelCount, replies: replyCount },
          }).catch(() => {});
        }

        continuation = nextContinuation;

        if (!continuation) {
          console.log('[YT Archiver] Phase 1: no more continuation tokens. Total top-level:', topLevelCount);
          break;
        }
        await sleep(200);
      } catch (e) {
        if (e.name === 'AbortError') {
          isFetchingComments = false;
          return;
        }

        if (e.message?.includes('429') || e.message?.includes('rate')) {
          chrome.runtime.sendMessage({
            type: 'COMMENTS_RATE_LIMITED',
          }).catch(() => {});
          try {
            await abortableSleep(30000, commentsFetchAbortController.signal);
          } catch (abortErr) {
            isFetchingComments = false;
            return;
          }
          continue;
        }

        retryCount++;
        if (retryCount >= maxRetries) {
          isFetchingComments = false;
          chrome.runtime.sendMessage({
            type: 'COMMENTS_FETCH_ERROR',
            data: { error: e.message || 'Unknown error' },
          }).catch(() => {});
          return;
        }
        await sleep(1000 * Math.pow(2, retryCount));
      }
    }

    // Phase 2: Fetch replies for each comment thread
    console.log('[YT Archiver] Phase 2: fetching replies for', replyContinuations.length, 'threads');
    for (let rcIdx = 0; rcIdx < replyContinuations.length; rcIdx++) {
      const rc = replyContinuations[rcIdx];
      if (!isFetchingComments) break;

      let replyCont = rc.token;
      retryCount = 0;
      let replyPageNum = 0;

      console.log('[YT Archiver] Phase 2: thread', rcIdx + 1, '/', replyContinuations.length,
        ', parent:', rc.parentCommentId);

      while (replyCont && isFetchingComments) {
        try {
          const result = await fetchCommentsPage(replyCont, commentsFetchAbortController.signal, false);
          replyPageNum++;

          if (!result) {
            console.warn('[YT Archiver] Phase 2: reply page returned null, parent:', rc.parentCommentId);
            retryCount++;
            if (retryCount >= maxRetries) break;
            await sleep(1000 * Math.pow(2, retryCount));
            continue;
          }

          retryCount = 0;
          const { comments, nextContinuation } = result;
          console.log('[YT Archiver] Phase 2: reply page', replyPageNum,
            'for parent', rc.parentCommentId, ': got', comments.length,
            'replies, nextCont:', !!nextContinuation);

          // Mark replies with parent ID
          for (const c of comments) {
            c.parent_comment_id = rc.parentCommentId;
          }

          replyCount += comments.length;

          if (comments.length > 0) {
            chrome.runtime.sendMessage({
              type: 'COMMENTS_PAGE_RESULT',
              data: { comments, topLevel: topLevelCount, replies: replyCount },
            }).catch(() => {});
          }

          replyCont = nextContinuation;
          if (!replyCont) break;
          await sleep(200);
        } catch (e) {
          if (e.name === 'AbortError') {
            isFetchingComments = false;
            return;
          }

          retryCount++;
          if (retryCount >= maxRetries) break;
          await sleep(1000 * Math.pow(2, retryCount));
        }
      }
    }

    // Only send DONE if we weren't stopped/aborted
    const wasStopped = !isFetchingComments;
    isFetchingComments = false;
    console.log('[YT Archiver] fetchAllComments complete. wasStopped:', wasStopped,
      ', topLevel:', topLevelCount, ', replies:', replyCount,
      ', replyThreadsFetched:', replyContinuations.length);
    if (!wasStopped) {
      chrome.runtime.sendMessage({
        type: 'COMMENTS_FETCH_DONE',
        data: { topLevel: topLevelCount, replies: replyCount },
      }).catch(() => {});
    }
  }

  async function fetchCommentsPage(continuation, signal, isFirstPage = false) {
    const cfg = cachedInnertubeConfig || {};
    const apiKey = cfg.apiKey || 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
    const clientVersion = cfg.clientVersion || '2.20260205.01.00';
    const visitorData = cfg.visitorData || '';

    const apiUrl = `https://www.youtube.com/youtubei/v1/next?key=${apiKey}&prettyPrint=false`;

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
    const endpointCount = data?.onResponseReceivedEndpoints?.length || 0;
    console.log('[YT Archiver] fetchCommentsPage: response status:', response.status,
      ', endpoints:', endpointCount, ', isFirstPage:', isFirstPage,
      ', hasMutations:', !!(data?.frameworkUpdates?.entityBatchUpdate?.mutations?.length));
    return parseCommentsResponse(data, isFirstPage);
  }

  function parseCommentsResponse(data, isFirstPage = false) {
    const comments = [];
    let nextContinuation = null;
    const replyTokens = [];
    let headerSortContinuation = null;

    try {
      // Build entity map from frameworkUpdates (new YouTube format)
      const entityMap = {};
      const mutations = data?.frameworkUpdates?.entityBatchUpdate?.mutations || [];
      for (const mutation of mutations) {
        if (mutation.entityKey && mutation.payload) {
          entityMap[mutation.entityKey] = mutation.payload;
        }
      }
      const hasEntityStore = mutations.length > 0;
      console.log('[YT Archiver] parseCommentsResponse: isFirstPage:', isFirstPage,
        ', entityMap size:', Object.keys(entityMap).length,
        ', mutations:', mutations.length);

      const endpoints = data?.onResponseReceivedEndpoints || [];
      console.log('[YT Archiver] parseCommentsResponse: endpoint count:', endpoints.length);

      for (let epIdx = 0; epIdx < endpoints.length; epIdx++) {
        const ep = endpoints[epIdx];
        const items =
          ep.reloadContinuationItemsCommand?.continuationItems ||
          ep.appendContinuationItemsAction?.continuationItems ||
          [];

        // Detect header endpoint: contains commentsHeaderRenderer
        const hasHeader = items.some(item => !!item.commentsHeaderRenderer);
        if (hasHeader) {
          console.log('[YT Archiver] parseCommentsResponse: endpoint', epIdx, 'is header (commentsHeaderRenderer found)');
          // Extract sort continuation from the header (for potential use)
          for (const item of items) {
            if (item.commentsHeaderRenderer) {
              const sortMenu = item.commentsHeaderRenderer.sortMenu?.sortFilterSubMenuRenderer?.subMenuItems;
              if (sortMenu?.length > 0) {
                // Index 0 = "Top comments", Index 1 = "Newest first"
                const sortItem = sortMenu[0]; // Use "Top comments" sort
                const sortToken =
                  sortItem?.serviceEndpoint?.continuationCommand?.token ||
                  sortItem?.continuation?.reloadContinuationData?.continuation;
                if (sortToken) {
                  headerSortContinuation = sortToken;
                  console.log('[YT Archiver] parseCommentsResponse: extracted sort continuation from header (len:', sortToken.length, ')');
                }
              }
              // Also extract total comment count from header
              const countRuns = item.commentsHeaderRenderer.countText?.runs;
              if (countRuns) {
                const countText = countRuns.map(r => r.text || '').join('');
                console.log('[YT Archiver] parseCommentsResponse: comment count from header:', countText);
              }
            }
            // The header endpoint may also have a continuationItemRenderer for sort
            if (item.continuationItemRenderer) {
              const token = extractContinuationFromItem(item.continuationItemRenderer);
              if (token) {
                headerSortContinuation = headerSortContinuation || token;
                console.log('[YT Archiver] parseCommentsResponse: header has continuationItemRenderer (len:', token.length, ')');
              }
            }
          }
          continue; // Skip the header endpoint - don't process its items as comments
        }

        console.log('[YT Archiver] parseCommentsResponse: endpoint', epIdx, 'has', items.length, 'items');

        for (const item of items) {
          // Continuation token for next page
          if (item.continuationItemRenderer) {
            const token = extractContinuationFromItem(item.continuationItemRenderer);
            if (token) nextContinuation = token;
            continue;
          }

          // Top-level comment thread
          const thread = item.commentThreadRenderer;
          if (thread) {
            let parsed = null;

            // New format: commentViewModel + entity store
            const vm = thread.commentViewModel?.commentViewModel;
            if (vm && hasEntityStore) {
              parsed = parseCommentFromEntity(vm, entityMap);
            }

            // Old format fallback: comment.commentRenderer
            if (!parsed) {
              const commentRenderer = thread.comment?.commentRenderer;
              if (commentRenderer) {
                parsed = parseCommentRenderer(commentRenderer);
              }
            }

            if (parsed) {
              comments.push(parsed);

              // Check for reply continuation
              const repliesRenderer = thread.replies?.commentRepliesRenderer;
              if (repliesRenderer) {
                // YouTube has two paths for replies:
                // 1. Old format: repliesRenderer.contents[] with continuationItemRenderer
                // 2. New format: repliesRenderer.subThreads[] with commentThreadRenderer and/or continuationItemRenderer

                // Check contents (old format)
                const replyContents = repliesRenderer.contents || [];
                for (const rc of replyContents) {
                  if (rc.continuationItemRenderer) {
                    const replyToken = extractContinuationFromItem(rc.continuationItemRenderer);
                    if (replyToken) {
                      replyTokens.push({
                        token: replyToken,
                        parentCommentId: parsed.comment_id,
                      });
                    }
                  }
                }

                // Check subThreads (new format - may contain inline replies AND continuation tokens)
                const subThreads = repliesRenderer.subThreads || [];
                for (const st of subThreads) {
                  // Inline reply wrapped in commentThreadRenderer inside subThreads
                  if (st.commentThreadRenderer) {
                    const subThread = st.commentThreadRenderer;
                    let subParsed = null;
                    const subVm = subThread.commentViewModel?.commentViewModel;
                    if (subVm && hasEntityStore) {
                      subParsed = parseCommentFromEntity(subVm, entityMap);
                    }
                    if (!subParsed) {
                      const subRenderer = subThread.comment?.commentRenderer;
                      if (subRenderer) {
                        subParsed = parseCommentRenderer(subRenderer);
                      }
                    }
                    if (subParsed) {
                      subParsed.parent_comment_id = parsed.comment_id;
                      comments.push(subParsed);
                    }
                  }
                  // Continuation token for more replies in subThreads
                  if (st.continuationItemRenderer) {
                    const replyToken = extractContinuationFromItem(st.continuationItemRenderer);
                    if (replyToken) {
                      replyTokens.push({
                        token: replyToken,
                        parentCommentId: parsed.comment_id,
                      });
                    }
                  }
                }

                // Also check viewReplies button path (some formats put continuation there)
                const viewRepliesToken =
                  repliesRenderer.viewReplies?.buttonRenderer?.command?.continuationCommand?.token ||
                  repliesRenderer.viewRepliesCreatorComment?.buttonRenderer?.command?.continuationCommand?.token;
                if (viewRepliesToken && replyTokens.findIndex(rt => rt.parentCommentId === parsed.comment_id) === -1) {
                  replyTokens.push({
                    token: viewRepliesToken,
                    parentCommentId: parsed.comment_id,
                  });
                }

                console.log('[YT Archiver] Reply paths for comment', parsed.comment_id,
                  ': contents=', replyContents.length, ', subThreads=', subThreads.length,
                  ', hasViewReplies=', !!viewRepliesToken,
                  ', foundTokens=', replyTokens.filter(rt => rt.parentCommentId === parsed.comment_id).length);
              }
            }
            continue;
          }

          // Reply comment - new format: commentViewModel
          // Note: standalone reply items use single nesting (item.commentViewModel),
          // unlike top-level threads which use double nesting (thread.commentViewModel.commentViewModel)
          const replyVm = item.commentViewModel?.commentViewModel || item.commentViewModel;
          if (replyVm && hasEntityStore && replyVm.commentKey) {
            const parsed = parseCommentFromEntity(replyVm, entityMap);
            if (parsed) comments.push(parsed);
            continue;
          }

          // Reply comment - old format: commentRenderer
          const commentRenderer = item.commentRenderer;
          if (commentRenderer) {
            const parsed = parseCommentRenderer(commentRenderer);
            if (parsed) comments.push(parsed);
          }
        }
      }

      // If this is the first page and we got comments but no next continuation,
      // use the header sort continuation as the next page token.
      // This handles the case where YouTube returns header + comments in separate endpoints
      // and the comments endpoint doesn't have its own continuation (relying on sort continuation).
      if (isFirstPage && !nextContinuation && headerSortContinuation) {
        console.log('[YT Archiver] parseCommentsResponse: first page, using header sort continuation as next page token');
        nextContinuation = headerSortContinuation;
      }

      console.log('[YT Archiver] parseCommentsResponse: found', comments.length, 'comments,',
        replyTokens.length, 'reply tokens, nextContinuation:', !!nextContinuation,
        nextContinuation ? '(len:' + nextContinuation.length + ')' : '');
    } catch (e) {
      console.error('[YT Archiver] Comments parse error:', e, e.stack);
    }

    return { comments, nextContinuation, replyTokens };
  }

  // New YouTube format: extract comment from entity store via commentViewModel keys
  function parseCommentFromEntity(vm, entityMap) {
    if (!vm) return null;

    const commentId = vm.commentId || '';
    const commentKey = vm.commentKey || '';
    const toolbarStateKey = vm.toolbarStateKey || '';

    // Look up the comment entity using the commentKey
    let entity = null;
    if (commentKey && entityMap[commentKey]) {
      entity = entityMap[commentKey].commentEntityPayload;
    }
    // Fallback: try using toolbarStateKey to find the entity
    if (!entity && toolbarStateKey && entityMap[toolbarStateKey]) {
      // toolbarStateKey points to engagementToolbarStateEntityPayload, not comment entity
      // But we can use it as a clue to find nearby entities
    }
    // Fallback: try to find by iterating entities matching commentId
    if (!entity) {
      for (const key of Object.keys(entityMap)) {
        const ce = entityMap[key].commentEntityPayload;
        if (ce?.properties?.commentId === commentId) {
          entity = ce;
          break;
        }
      }
    }

    if (!entity) {
      console.warn('[YT Archiver] parseCommentFromEntity: no entity found for commentId:', commentId,
        ', commentKey:', commentKey, ', entityMap keys sample:', Object.keys(entityMap).slice(0, 5));
      return null;
    }

    const props = entity.properties || {};
    const author = entity.author || {};
    const toolbar = entity.toolbar || {};
    const avatar = entity.avatar || {};

    // Text content
    const text = props.content?.content || '';

    // Author info
    const authorName = author.displayName || '';
    const channelId = author.channelId || '';
    const isChannelOwner = author.isCreator || false;

    // Profile image
    let profileImage = '';
    const sources = avatar.image?.sources;
    if (sources?.length > 0) {
      profileImage = sources[sources.length - 1].url || '';
    } else if (author.avatarThumbnailUrl) {
      profileImage = author.avatarThumbnailUrl;
    }

    // Like count - try likeCountA11y first (more reliable), then fall back to others
    let likeCount = 0;
    const likeStr = toolbar.likeCountA11y || toolbar.likeCountNotliked || toolbar.likeCountLiked || '';
    if (likeStr) {
      const parsed = parseInt(String(likeStr).replace(/[^0-9]/g, ''), 10);
      if (!isNaN(parsed)) likeCount = parsed;
    }

    // Reply count
    let replyCount = 0;
    if (toolbar.replyCount) {
      const parsed = parseInt(String(toolbar.replyCount).replace(/[^0-9]/g, ''), 10);
      if (!isNaN(parsed)) replyCount = parsed;
    }

    // Heart (creator hearted the comment) - check multiple sources
    let isHearted = !!toolbar.creatorThumbnailUrl;
    // Also check engagementToolbarStateEntityPayload for heart state
    if (!isHearted && toolbarStateKey && entityMap[toolbarStateKey]) {
      const toolbarState = entityMap[toolbarStateKey].engagementToolbarStateEntityPayload;
      if (toolbarState?.heartState === 'TOOLBAR_HEART_STATE_HEARTED') {
        isHearted = true;
      }
    }

    // Published time
    const publishedTimeText = props.publishedTime || '';

    // Pinned - check multiple sources
    let isPinned = false;
    // Method 1: check commentSurfaceEntityPayload
    if (vm.commentSurfaceKey && entityMap[vm.commentSurfaceKey]) {
      const surface = entityMap[vm.commentSurfaceKey].commentSurfaceEntityPayload;
      if (surface?.pinned) isPinned = true;
    }
    // Method 2: check pinnedText on the viewModel (used in newer YouTube format)
    if (!isPinned && vm.pinnedText) {
      isPinned = true;
    }

    return {
      comment_id: commentId,
      parent_comment_id: '',
      author_display_name: authorName,
      author_channel_id: channelId,
      author_profile_image: profileImage,
      text,
      published_time_text: publishedTimeText,
      like_count: likeCount,
      reply_count: replyCount,
      is_channel_owner: isChannelOwner,
      is_pinned: isPinned,
      is_hearted: isHearted,
    };
  }

  // Old YouTube format: extract comment from commentRenderer directly
  function parseCommentRenderer(renderer) {
    if (!renderer) return null;

    let text = '';
    const runs = renderer.contentText?.runs;
    if (runs) {
      text = runs.map(r => r.text || '').join('');
    }

    let profileImage = '';
    const thumbs = renderer.authorThumbnail?.thumbnails;
    if (thumbs?.length > 0) {
      profileImage = thumbs[thumbs.length - 1].url;
    }

    let likeCount = 0;
    if (renderer.voteCount?.simpleText) {
      const parsed = parseInt(renderer.voteCount.simpleText.replace(/[^0-9]/g, ''), 10);
      if (!isNaN(parsed)) likeCount = parsed;
    }
    if (likeCount === 0 && renderer.actionButtons?.commentActionButtonsRenderer?.likeButton?.toggleButtonRenderer?.accessibilityData?.accessibilityData?.label) {
      const label = renderer.actionButtons.commentActionButtonsRenderer.likeButton.toggleButtonRenderer.accessibilityData.accessibilityData.label;
      const match = label.match(/(\d[\d,]*)/);
      if (match) {
        likeCount = parseInt(match[1].replace(/,/g, ''), 10) || 0;
      }
    }

    let replyCount = 0;
    if (renderer.replyCount !== undefined) {
      replyCount = renderer.replyCount;
    }

    const isChannelOwner = renderer.authorIsChannelOwner || false;

    let isPinned = false;
    if (renderer.pinnedCommentBadge) isPinned = true;

    let isHearted = false;
    const heartButton = renderer.actionButtons?.commentActionButtonsRenderer?.creatorHeart;
    if (heartButton?.creatorHeartRenderer?.isHearted) isHearted = true;

    let publishedTimeText = '';
    if (renderer.publishedTimeText?.runs) {
      publishedTimeText = renderer.publishedTimeText.runs.map(r => r.text || '').join('');
    } else if (renderer.publishedTimeText?.simpleText) {
      publishedTimeText = renderer.publishedTimeText.simpleText;
    }

    return {
      comment_id: renderer.commentId || '',
      parent_comment_id: '',
      author_display_name: renderer.authorText?.simpleText || '',
      author_channel_id: renderer.authorEndpoint?.browseEndpoint?.browseId || '',
      author_profile_image: profileImage,
      text,
      published_time_text: publishedTimeText,
      like_count: likeCount,
      reply_count: replyCount,
      is_channel_owner: isChannelOwner,
      is_pinned: isPinned,
      is_hearted: isHearted,
    };
  }

  // ─── ytcfg Extraction via Injection ───

  let cachedInnertubeConfig = null;

  function extractViaInjection() {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('content/page-bridge.js');
    script.onload = () => script.remove();
    document.documentElement.appendChild(script);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.type !== '__YT_CHAT_DL_INITIAL_DATA__') return;

    try {
      const payload = JSON.parse(event.data.data);
      const ytInitialData = payload.ytInitialData;
      cachedInnertubeConfig = payload.innertubeConfig || cachedInnertubeConfig;

      const playerResponse = payload.playerResponse || null;
      const chatContinuationToken = extractContinuationToken(ytInitialData);
      const commentsContinuationToken = extractCommentsContinuationToken(ytInitialData);
      console.log('[YT Archiver] Comments token:', commentsContinuationToken ? commentsContinuationToken.substring(0, 30) + '... (len=' + commentsContinuationToken.length + ')' : 'null');
      const videoInfo = extractVideoInfo(ytInitialData);
      const videoId = getVideoId();

      // Extract and cache streaming data
      let streamingData = extractStreamingData(playerResponse);
      if (streamingData) cachedStreamingData = streamingData;

      // Extract metadata
      const metadata = extractFullMetadata(ytInitialData, playerResponse);

      // Check if we got formats with direct URLs
      let hasDirectUrls = !!(streamingData && (streamingData.formats.length > 0 || streamingData.adaptiveFormats.length > 0));

      // Get streaming summary
      let streamingSummary = getStreamingSummary(streamingData);

      if (videoId) {
        lastVideoId = videoId;

        // If no direct URLs, try player API in background
        if (!hasDirectUrls && videoId) {
          fetchPlayerStreams(videoId).then((result) => {
            if (result) {
              cachedStreamingData = result;
              const summary = getStreamingSummary(result);
              console.log('[YT Archiver] Player API fallback: got streams, updating panel');
              chrome.runtime.sendMessage({
                type: 'VIDEO_PAGE_DETECTED',
                data: {
                  videoId,
                  title: videoInfo.title || metadata.title || '',
                  channelName: videoInfo.channelName || metadata.author || '',
                  chatContinuationToken,
                  commentsContinuationToken,
                  metadata,
                  hasStreams: true,
                  streamingSummary: summary,
                },
              }).catch(() => {});
            }
          }).catch(() => {});
        }

        console.log('[YT Archiver] Injection path: sending VIDEO_PAGE_DETECTED', {
          videoId,
          hasMeta: Object.keys(metadata).length > 0,
          hasStreams: hasDirectUrls,
          hasComments: !!commentsContinuationToken,
          hasChat: !!chatContinuationToken,
        });
        chrome.runtime.sendMessage({
          type: 'VIDEO_PAGE_DETECTED',
          data: {
            videoId,
            title: videoInfo.title || metadata.title || '',
            channelName: videoInfo.channelName || metadata.author || '',
            chatContinuationToken,
            commentsContinuationToken,
            metadata,
            hasStreams: hasDirectUrls,
            streamingSummary,
          },
        }).catch(() => {});
      }
    } catch (e) {
      console.error('[YT Archiver] Error parsing injected data:', e);
    }
  });

  function checkForChatReplay(force = false) {
    const videoId = getVideoId();
    if (!videoId) return;
    if (!force && videoId === lastVideoId) return;
    lastVideoId = videoId;

    const ytInitialData = extractYtInitialData();
    const chatContinuationToken = extractContinuationToken(ytInitialData);
    const commentsContinuationToken = extractCommentsContinuationToken(ytInitialData);
    const videoInfo = extractVideoInfo(ytInitialData);

    // Send the unified VIDEO_PAGE_DETECTED message
    chrome.runtime.sendMessage({
      type: 'VIDEO_PAGE_DETECTED',
      data: {
        videoId,
        title: videoInfo.title,
        channelName: videoInfo.channelName,
        chatContinuationToken,
        commentsContinuationToken,
        metadata: {},
        hasStreams: false,
        streamingSummary: null,
      },
    }).catch(() => {});
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

        console.error('[YT Archiver] Fetch error:', e);

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
      console.error('[YT Archiver] Parse error:', e);
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
      const prevVideoId = lastVideoId;
      lastVideoId = null;
      cachedStreamingData = null;
      extractViaInjection();
      // Fallback if injection doesn't respond
      setTimeout(() => {
        if (!lastVideoId) checkForChatReplay(true);
      }, 1500);
      sendResponse({ status: 'checking' });
    } else if (message.type === 'START_FETCH_FROM_CONTENT') {
      if (message.continuation) {
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
    } else if (message.type === 'START_COMMENTS_FETCH') {
      console.log('[YT Archiver] Received START_COMMENTS_FETCH, continuation:', !!message.continuation);
      if (message.continuation) {
        extractViaInjection();
        setTimeout(() => {
          fetchAllComments(message.continuation);
        }, 300);
      }
      sendResponse({ status: 'ok' });
    } else if (message.type === 'STOP_COMMENTS_FETCH') {
      isFetchingComments = false;
      if (commentsFetchAbortController) {
        commentsFetchAbortController.abort();
        commentsFetchAbortController = null;
      }
      sendResponse({ status: 'ok' });
    } else if (message.type === 'GET_VIDEO_STREAMS') {
      // If cached data has no formats with URLs, try player API fallback
      const hasUrls = cachedStreamingData &&
        (cachedStreamingData.formats.length > 0 || cachedStreamingData.adaptiveFormats.length > 0);
      if (hasUrls) {
        sendResponse({ streamingData: cachedStreamingData });
      } else {
        // Async fallback - fetch from player API
        const videoId = getVideoId();
        if (videoId) {
          fetchPlayerStreams(videoId).then((result) => {
            if (result) {
              cachedStreamingData = result;
            }
            sendResponse({ streamingData: result || cachedStreamingData });
          }).catch(() => {
            sendResponse({ streamingData: cachedStreamingData });
          });
        } else {
          sendResponse({ streamingData: cachedStreamingData });
        }
      }
    }
    return true;
  });

  // ─── Initial Check ───

  // Always try injection first (gets rich data: metadata, streams, innertube config)
  // Then fall back to DOM parsing if injection doesn't respond
  console.log('[YT Archiver] Content script loaded, videoId:', getVideoId());
  extractViaInjection();
  // Fallback: if injection doesn't fire within 2s, try DOM parsing
  setTimeout(() => {
    if (!lastVideoId) {
      console.log('[YT Archiver] Injection fallback: trying DOM parse');
      checkForChatReplay();
    }
  }, 2000);

  // Watch for YouTube SPA navigation using multiple strategies

  // Strategy 1: yt-navigate-finish event (the canonical YouTube SPA navigation event)
  window.addEventListener('yt-navigate-finish', () => {
    const currentVideoId = getVideoId();
    console.log('[YT Archiver] yt-navigate-finish fired, videoId:', currentVideoId, 'lastVideoId:', lastVideoId);
    if (currentVideoId && currentVideoId !== lastVideoId) {
      cachedStreamingData = null;
      // Short delay to let YouTube populate ytInitialData
      setTimeout(() => {
        extractViaInjection();
        // Fallback if injection doesn't fire
        setTimeout(() => {
          if (lastVideoId !== currentVideoId) {
            console.log('[YT Archiver] SPA fallback (yt-navigate-finish): trying DOM parse');
            checkForChatReplay();
          }
        }, 1500);
      }, 500);
    }
  });

  // Strategy 2: popstate for browser back/forward navigation
  window.addEventListener('popstate', () => {
    const currentVideoId = getVideoId();
    console.log('[YT Archiver] popstate fired, videoId:', currentVideoId, 'lastVideoId:', lastVideoId);
    if (currentVideoId && currentVideoId !== lastVideoId) {
      cachedStreamingData = null;
      setTimeout(() => {
        extractViaInjection();
        setTimeout(() => {
          if (lastVideoId !== currentVideoId) {
            console.log('[YT Archiver] SPA fallback (popstate): trying DOM parse');
            checkForChatReplay();
          }
        }, 1500);
      }, 500);
    }
  });

  // Strategy 3: MutationObserver on title as an additional fallback
  let lastObservedUrl = window.location.href;
  const observer = new MutationObserver(() => {
    const currentUrl = window.location.href;
    if (currentUrl !== lastObservedUrl) {
      lastObservedUrl = currentUrl;
      const currentVideoId = getVideoId();
      if (currentVideoId && currentVideoId !== lastVideoId) {
        console.log('[YT Archiver] Title MutationObserver detected URL change, videoId:', currentVideoId);
        cachedStreamingData = null;
        setTimeout(() => {
          extractViaInjection();
          setTimeout(() => {
            if (lastVideoId !== currentVideoId) {
              console.log('[YT Archiver] SPA fallback (observer): trying DOM parse');
              checkForChatReplay();
            }
          }, 1500);
        }, 500);
      }
    }
  });

  observer.observe(document.querySelector('title') || document.head, {
    childList: true,
    subtree: true,
    characterData: true,
  });
})();
