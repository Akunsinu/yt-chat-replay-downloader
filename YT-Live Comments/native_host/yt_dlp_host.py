#!/usr/bin/env python3
"""Native messaging host for YouTube Video Archiver. Downloads videos via yt-dlp."""

import sys
import json
import struct
import subprocess
import os
import re
import signal
import traceback
import pathlib

# Debug log to help diagnose issues. We try several locations because Chrome's
# native-messaging child processes on macOS may not be able to write inside
# ~/Documents (TCC tightens that on recent OS releases). The first writable
# location wins; if none works, debug() becomes a no-op rather than crashing
# the host before it can respond to Chrome.
def _pick_debug_log():
    candidates = [
        os.path.join(os.path.expanduser('~/Library/Logs/com.ytarchiver.downloader'), 'debug.log'),
        os.path.join(os.path.expanduser('~'), '.cache', 'com.ytarchiver.downloader', 'debug.log'),
        os.path.join('/tmp', 'com.ytarchiver.downloader.log'),
        os.path.join(os.path.dirname(os.path.abspath(__file__)), 'debug.log'),
    ]
    for path in candidates:
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, 'a') as f:
                f.write('')
            return path
        except Exception:
            continue
    return None

DEBUG_LOG = _pick_debug_log()

def debug(msg):
    # Never crash the host on logging failures.
    if not DEBUG_LOG:
        return
    try:
        with open(DEBUG_LOG, 'a') as f:
            f.write(msg + '\n')
            f.flush()
    except Exception:
        pass

debug('--- Host started, PID=%d ---' % os.getpid())
debug('DEBUG_LOG=%s' % DEBUG_LOG)
debug('PATH=' + os.environ.get('PATH', '(unset)'))
debug('argv=' + repr(sys.argv))
debug('cwd=' + os.getcwd())
debug('python=' + sys.executable + ' ' + sys.version.replace('\n', ' '))

# Chrome launches native hosts with minimal PATH; add common locations
for p in ['/opt/homebrew/bin', '/usr/local/bin',
          os.path.expanduser('~/.local/bin'), os.path.expanduser('~/bin')]:
    if p not in os.environ.get('PATH', ''):
        os.environ['PATH'] = p + ':' + os.environ.get('PATH', '')
# Also ensure HOME is set (needed by yt-dlp for config/cache)
if 'HOME' not in os.environ:
    os.environ['HOME'] = os.path.expanduser('~')

debug('PATH after fix=' + os.environ['PATH'])

ytdlp_process = None


def read_message():
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) < 4:
        return None
    length = struct.unpack('=I', raw_length)[0]
    data = sys.stdin.buffer.read(length)
    return json.loads(data.decode('utf-8'))


def send_message(msg):
    encoded = json.dumps(msg).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('=I', len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def cleanup(signum=None, frame=None):
    global ytdlp_process
    if ytdlp_process and ytdlp_process.poll() is None:
        try:
            ytdlp_process.terminate()
            ytdlp_process.wait(timeout=5)
        except Exception:
            ytdlp_process.kill()
    sys.exit(0)


signal.signal(signal.SIGTERM, cleanup)
signal.signal(signal.SIGINT, cleanup)


def detect_ffmpeg():
    """Return (available: bool, version: str|None). Used both at runtime to
    decide which yt-dlp format selector to use, and by the `check` action to
    surface ffmpeg status to the panel."""
    try:
        result = subprocess.run(
            ['ffmpeg', '-version'],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode != 0:
            return False, None
        first_line = (result.stdout or '').splitlines()[:1]
        version = first_line[0] if first_line else 'ffmpeg'
        # `ffmpeg -version` prints "ffmpeg version N.N.N ..." — keep just the leading part
        m = re.match(r'ffmpeg version (\S+)', version)
        return True, (m.group(1) if m else version)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False, None
    except Exception:
        return False, None


def download_video(video_url, output_dir, title, max_quality='1080'):
    global ytdlp_process

    # Resolve and confine output_dir to the user's home directory.
    # Prevents a malicious sender from writing to arbitrary paths via "../../etc" tricks.
    expanded = os.path.expanduser(output_dir)
    try:
        real_out = pathlib.Path(expanded).resolve(strict=False)
        home_real = pathlib.Path(os.path.expanduser('~')).resolve(strict=False)
    except Exception as e:
        send_message({'type': 'error', 'message': 'Invalid outputDir: %s' % e})
        return
    try:
        real_out.relative_to(home_real)
    except ValueError:
        send_message({
            'type': 'error',
            'message': 'outputDir must be inside the home directory (got: %s)' % real_out,
        })
        return

    output_dir = str(real_out)
    os.makedirs(output_dir, exist_ok=True)

    # Strip path separators from title so it can't escape output_dir via the template.
    safe_title = re.sub(r'[\\/]+', '_', title or 'video').strip() or 'video'
    output_template = os.path.join(output_dir, safe_title + '.%(ext)s')

    # Reject obviously malformed video URLs early — yt-dlp accepts URLs starting
    # with '-' as flag-like inputs in some shells; we never use shell=True, but
    # guard anyway in case the caller sends junk.
    if not isinstance(video_url, str) or not video_url.startswith(('http://', 'https://')):
        send_message({'type': 'error', 'message': 'videoUrl must be an http(s) URL'})
        return

    ffmpeg_available, ffmpeg_version = detect_ffmpeg()
    debug('ffmpeg_available=%s version=%s' % (ffmpeg_available, ffmpeg_version))

    if ffmpeg_available:
        # Prefer separate streams (higher quality) and let yt-dlp+ffmpeg merge.
        fmt = (
            'bestvideo[height<=%s][vcodec^=avc1]+bestaudio[acodec^=mp4a]/'
            'bestvideo[height<=%s][vcodec^=avc1]+bestaudio/'
            'bestvideo[height<=%s]+bestaudio/'
            'best[height<=%s]/best'
        ) % (max_quality, max_quality, max_quality, max_quality)
        cmd = [
            'yt-dlp', '-f', fmt,
            '--merge-output-format', 'mp4',
            '--newline', '--no-colors', '--no-playlist', '--no-update',
            '-o', output_template,
            video_url,
        ]
        send_message({'type': 'status', 'message': 'Starting yt-dlp...'})
    else:
        # No ffmpeg → use only pre-muxed (single-file) formats. These cap at
        # 720p on YouTube, but the user gets one playable file with audio
        # instead of two unmerged streams.
        fmt = 'best[height<=%s][ext=mp4]/best[ext=mp4]/best' % max_quality
        cmd = [
            'yt-dlp', '-f', fmt,
            '--newline', '--no-colors', '--no-playlist', '--no-update',
            '-o', output_template,
            video_url,
        ]
        send_message({
            'type': 'status',
            'message': 'ffmpeg not installed — downloading single-file format (max 720p). Install ffmpeg for higher quality.',
        })

    try:
        ytdlp_process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )

        last_error = ''
        for line in ytdlp_process.stdout:
            line = line.strip()
            if not line:
                continue

            # Capture ERROR lines for better error reporting
            if line.startswith('ERROR:'):
                last_error = line

            # Progress: [download]  45.2% of  100.00MiB at  5.20MiB/s ETA 00:10
            m = re.match(
                r'\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+\S+)\s+at\s+(\S+)\s+ETA\s+(\S+)',
                line
            )
            if m:
                try:
                    send_message({
                        'type': 'progress',
                        'percent': float(m.group(1)),
                        'totalSize': m.group(2),
                        'speed': m.group(3),
                        'eta': m.group(4),
                    })
                except (BrokenPipeError, OSError):
                    cleanup()
                continue

            if 'has already been downloaded' in line:
                send_message({'type': 'status', 'message': 'Already downloaded'})
                continue

            if '[Merger]' in line:
                send_message({'type': 'status', 'message': 'Merging video and audio...'})
                continue

            if '[download] 100%' in line:
                send_message({'type': 'progress', 'percent': 100.0})
                continue

        ytdlp_process.wait()

        if ytdlp_process.returncode == 0:
            files = []
            for f in sorted(os.listdir(output_dir)):
                if os.path.isfile(os.path.join(output_dir, f)):
                    files.append(f)

            # Merge verification: if any file in the output dir has a
            # `.fNNN.` segment in its name (e.g. `.f137.mp4`, `.f140.m4a`),
            # that's yt-dlp's signature for an unmerged per-format download.
            # The merge step failed silently — almost always because ffmpeg
            # is missing. Surface a clear, actionable error rather than
            # claiming "complete" with a soundless video.
            unmerged = [f for f in files if re.search(r'\.f\d+\.', f)]
            if unmerged:
                debug('merge failed; unmerged files: %s' % unmerged)
                # Distinguish by what ffmpeg said earlier — guides the message.
                if not ffmpeg_available:
                    err = (
                        'Video and audio downloaded as separate files because '
                        'ffmpeg is not installed. Install it with: '
                        'brew install ffmpeg — then re-download. '
                        'Files: ' + ', '.join(unmerged)
                    )
                else:
                    err = (
                        'yt-dlp finished but the streams were not merged into '
                        'a single file. Unmerged files: ' + ', '.join(unmerged)
                    )
                send_message({
                    'type': 'error',
                    'message': err,
                    'unmergedFiles': unmerged,
                    'outputDir': output_dir,
                })
                return

            send_message({
                'type': 'complete',
                'files': files,
                'outputDir': output_dir,
                'ffmpegAvailable': ffmpeg_available,
            })
        else:
            err_msg = last_error if last_error else 'yt-dlp exited with code %d' % ytdlp_process.returncode
            send_message({
                'type': 'error',
                'message': err_msg,
            })

    except FileNotFoundError:
        send_message({
            'type': 'error',
            'message': 'yt-dlp not found. Install it: brew install yt-dlp',
        })
    except BrokenPipeError:
        cleanup()
    except Exception as e:
        send_message({
            'type': 'error',
            'message': str(e),
        })
    finally:
        ytdlp_process = None


def main():
    debug('main() called, reading message...')
    try:
        msg = read_message()
    except Exception as e:
        debug('read_message error: ' + traceback.format_exc())
        return
    debug('message received: ' + repr(msg)[:200])
    if not msg:
        debug('no message, exiting')
        return

    action = msg.get('action')

    if action == 'download':
        download_video(
            msg.get('videoUrl', ''),
            msg.get('outputDir', '~/Downloads/YT-Archive'),
            msg.get('title', 'video'),
            msg.get('maxQuality', '1080'),
        )
    elif action == 'check':
        ytdlp_available = False
        ytdlp_version = ''
        try:
            result = subprocess.run(
                ['yt-dlp', '--version'],
                capture_output=True, text=True, timeout=10,
            )
            ytdlp_available = result.returncode == 0
            ytdlp_version = (result.stdout or '').strip()
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass
        ffmpeg_available, ffmpeg_version = detect_ffmpeg()
        send_message({
            'type': 'check_result',
            'available': ytdlp_available,
            'version': ytdlp_version,
            'ffmpegAvailable': ffmpeg_available,
            'ffmpegVersion': ffmpeg_version or '',
        })
    else:
        send_message({'type': 'error', 'message': 'Unknown action: %s' % action})


if __name__ == '__main__':
    try:
        main()
    except Exception:
        debug('UNCAUGHT: ' + traceback.format_exc())
    debug('--- Host exiting ---')
