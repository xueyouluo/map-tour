import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, Pause, Play } from 'lucide-react';
import type { VideoMusicTrack } from './shared/videoExport';

export function MusicLibraryPicker({
  tracks,
  selectedId,
  onSelect,
  enabled
}: {
  tracks: VideoMusicTrack[];
  selectedId: string;
  onSelect: (id: string) => void;
  enabled: boolean;
}) {
  const player = useRef<HTMLAudioElement>(null);
  const request = useRef(0);
  const [previewId, setPreviewId] = useState('');
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const selectedTrack = tracks.find((track) => track.id === selectedId);
  useEffect(() => {
    request.current++;
    player.current?.pause();
    setPreviewId('');
    setError('');
  }, [selectedId, enabled]);
  useEffect(() => {
    const audio = player.current;
    return () => {
      request.current++;
      audio?.pause();
      audio?.removeAttribute('src');
      audio?.load();
    };
  }, []);

  async function preview(track: VideoMusicTrack) {
    const audio = player.current;
    if (!audio || !enabled) return;
    const ticket = ++request.current;
    audio.pause();
    if (previewId === track.id) {
      setPreviewId('');
      return;
    }
    setError('');
    setPreviewId(track.id);
    audio.src = track.previewUrl;
    audio.currentTime = 0;
    try {
      await audio.play();
    } catch {
      if (request.current === ticket) {
        setPreviewId('');
        setError('试听暂时无法播放，请再试一次。');
      }
    }
  }

  return (
    <div className="video-library">
      <p className="video-library-hint">
        五种旅行氛围 · 10 首配乐 · 试听开头 20 秒
      </p>
      {selectedTrack && (
        <div className="video-library-row selected video-library-current">
          <button
            type="button"
            className="video-library-select"
            aria-label="选择或更换内置音乐"
            aria-expanded={expanded}
            aria-controls={listId}
            disabled={!enabled}
            onClick={() => setExpanded(!expanded)}
          >
            <span>
              <strong>
                {selectedTrack.title} <em>{selectedTrack.version}</em>
              </strong>
              <small>{selectedTrack.mood} · 点击更换</small>
            </span>
            <ChevronDown
              size={14}
              style={{ transform: expanded ? 'rotate(180deg)' : undefined }}
            />
          </button>
          <button
            type="button"
            className="video-library-preview"
            aria-label={`${previewId === selectedTrack.id ? '暂停试听' : '试听'} ${selectedTrack.title} ${selectedTrack.version}`}
            aria-pressed={previewId === selectedTrack.id}
            disabled={!enabled}
            onClick={() => void preview(selectedTrack)}
          >
            {previewId === selectedTrack.id ? (
              <Pause size={13} />
            ) : (
              <Play size={13} />
            )}
          </button>
        </div>
      )}
      {expanded && (
        <div
          id={listId}
          className="video-library-list"
          role="group"
          aria-label="内置音乐曲库"
        >
          {tracks.map((track) => (
            <div
              key={track.id}
              className={`video-library-row ${selectedId === track.id ? 'selected' : ''}`}
            >
              <button
                type="button"
                className="video-library-select"
                aria-label={`选择 ${track.title} ${track.version}`}
                aria-pressed={selectedId === track.id}
                disabled={!enabled}
                onClick={() => {
                  onSelect(track.id);
                  setExpanded(false);
                }}
              >
                <span className="video-library-indicator">
                  {selectedId === track.id && <Check size={11} />}
                </span>
                <span>
                  <strong>
                    {track.title} <em>{track.version}</em>
                  </strong>
                  <small>{track.mood}</small>
                </span>
                <time>
                  {Math.floor(track.duration / 60)}:
                  {String(Math.floor(track.duration % 60)).padStart(2, '0')}
                </time>
              </button>
              <button
                type="button"
                className="video-library-preview"
                aria-label={`${previewId === track.id ? '暂停试听候选' : '试听候选'} ${track.title} ${track.version}`}
                title={previewId === track.id ? '暂停试听' : '试听开头 20 秒'}
                aria-pressed={previewId === track.id}
                disabled={!enabled}
                onClick={() => void preview(track)}
              >
                {previewId === track.id ? (
                  <Pause size={13} />
                ) : (
                  <Play size={13} />
                )}
              </button>
            </div>
          ))}
        </div>
      )}
      <audio
        ref={player}
        preload="none"
        aria-label="内置音乐试听播放器"
        onEnded={() => setPreviewId('')}
        onPause={() => {
          if (player.current?.paused) setPreviewId('');
        }}
      />
      {error && (
        <p className="video-library-error" role="status">
          {error}
        </p>
      )}
    </div>
  );
}
