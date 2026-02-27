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

# Debug log to help diagnose issues
DEBUG_LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'debug.log')

def debug(msg):
    with open(DEBUG_LOG, 'a') as f:
        f.write(msg + '\n')
        f.flush()

debug('--- Host started, PID=%d ---' % os.getpid())
debug('PATH=' + os.environ.get('PATH', '(unset)'))
debug('argv=' + repr(sys.argv))

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


def download_video(video_url, output_dir, title, max_quality='1080'):
    global ytdlp_process

    output_dir = os.path.expanduser(output_dir)
    os.makedirs(output_dir, exist_ok=True)

    output_template = os.path.join(output_dir, title + '.%(ext)s')

    # Prefer H.264+AAC for universal playback (QuickTime, browsers, HTML <video>)
    # Falls back to VP9/Opus if H.264 not available
    fmt = (
        'bestvideo[height<=%s][vcodec^=avc1]+bestaudio[acodec^=mp4a]/'
        'bestvideo[height<=%s][vcodec^=avc1]+bestaudio/'
        'bestvideo[height<=%s]+bestaudio/'
        'best[height<=%s]/best'
    ) % (max_quality, max_quality, max_quality, max_quality)

    cmd = [
        'yt-dlp',
        '-f', fmt,
        '--merge-output-format', 'mp4',
        '--newline',
        '--no-colors',
        '--no-playlist',
        '--no-update',
        '-o', output_template,
        video_url,
    ]

    send_message({'type': 'status', 'message': 'Starting yt-dlp...'})

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
            send_message({
                'type': 'complete',
                'files': files,
                'outputDir': output_dir,
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
        try:
            result = subprocess.run(
                ['yt-dlp', '--version'],
                capture_output=True, text=True, timeout=10,
            )
            send_message({
                'type': 'check_result',
                'available': result.returncode == 0,
                'version': result.stdout.strip(),
            })
        except (FileNotFoundError, subprocess.TimeoutExpired):
            send_message({'type': 'check_result', 'available': False})
    else:
        send_message({'type': 'error', 'message': 'Unknown action: %s' % action})


if __name__ == '__main__':
    try:
        main()
    except Exception:
        debug('UNCAUGHT: ' + traceback.format_exc())
    debug('--- Host exiting ---')
