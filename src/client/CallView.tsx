import { useEffect, useState } from 'react';
import {
  ChevronDown,
  Mic,
  MicOff,
  PhoneOff,
  Volume2,
  VolumeX,
  Maximize2,
} from 'lucide-react';
import { Mascot } from './Mascot';
import type { Dot } from '../shared/types';
import type { useVoice } from './useVoice';
import { t } from './i18n';

export function CallView({
  dot,
  voice,
}: {
  dot: Dot;
  voice: ReturnType<typeof useVoice>;
}) {
  const [minimized, setMinimized] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (voice.status !== 'active') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [voice.status]);
  if (voice.status === 'idle') return null;
  const seconds = voice.startedAt
    ? Math.max(0, Math.floor((now - voice.startedAt) / 1000))
    : 0;
  const duration = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const label =
    voice.status === 'connecting'
      ? t('calls.connecting')
      : voice.status === 'ending'
        ? t('calls.saving')
        : voice.muted
          ? t('calls.muted')
          : voice.phase === 'speaking'
            ? `${dot.name} ${t('calls.speaking')}`
            : voice.phase === 'thinking'
              ? t('calls.working')
              : t('calls.listening');
  return (
    <section
      className={`call-view ${minimized ? 'minimized' : ''}`}
      aria-label={`${t('calls.call')} com ${dot.name}`}
    >
      <div className="call-heading">
        <span>
          <span className="call-live-dot" /> {t('calls.call')}
        </span>
        <button
          className="call-minimize"
          aria-label={minimized ? t('calls.expand') : t('calls.minimize')}
          onClick={() => setMinimized(!minimized)}
        >
          {minimized ? <Maximize2 size={18} /> : <ChevronDown size={20} />}
        </button>
      </div>
      <div className={`call-persona ${voice.phase}`}>
        <Mascot identity={dot.id} name={dot.name} />
        <h2>{dot.name}</h2>
        <span className="call-timer" aria-label={t('calls.duration')}>
          {duration}
        </span>
        <p role="status">{label}</p>
      </div>
      {!minimized && (
        <div className="call-caption" aria-live="polite">
          {voice.userCaption && (
            <p className="call-user-caption">
              <small>{t('calls.you')}</small>
              {voice.userCaption}
            </p>
          )}
          <p>
            <small>{dot.name}</small>
            {voice.caption || t('calls.speak')}
          </p>
        </div>
      )}
      {voice.error && (
        <p className="call-warning" role="alert">
          {voice.error}
        </p>
      )}
      <div className="call-controls">
        <button
          aria-label={
            voice.speakerMuted ? t('calls.enableAudio') : t('calls.muteAudio')
          }
          aria-pressed={voice.speakerMuted}
          onClick={voice.toggleSpeaker}
          disabled={voice.status !== 'active'}
        >
          <span>{voice.speakerMuted ? <VolumeX /> : <Volume2 />}</span>
          <small>{t('calls.speaker')}</small>
        </button>
        <button
          className="call-end"
          aria-label={t('calls.endCall')}
          onClick={() => void voice.end()}
          disabled={voice.status === 'ending'}
        >
          <span>
            <PhoneOff />
          </span>
          <small>{t('calls.end')}</small>
        </button>
        <button
          aria-label={voice.muted ? t('calls.unmuteMic') : t('calls.muteMic')}
          aria-pressed={voice.muted}
          onClick={voice.toggleMute}
          disabled={voice.status !== 'active'}
        >
          <span>{voice.muted ? <MicOff /> : <Mic />}</span>
          <small>{voice.muted ? t('calls.unmute') : t('calls.mute')}</small>
        </button>
      </div>
      {!minimized && (
        <p className="call-footer">{t('calls.sharedConversation')}</p>
      )}
    </section>
  );
}
