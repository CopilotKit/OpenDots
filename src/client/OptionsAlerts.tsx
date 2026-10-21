import { useEffect, useRef, useState } from 'react';
import { BellRing, X } from 'lucide-react';
import { api } from './api';

type Alert = {
  at: number;
  trade: string;
  event: string;
  title: string;
  message: string;
};

const SEEN = 'opendots.optionsAlertsSeen';

function seenSince(): number {
  try {
    return Number(localStorage.getItem(SEEN)) || Date.now() / 1000 - 3600;
  } catch {
    return Date.now() / 1000 - 3600;
  }
}

function chime() {
  try {
    const audio = new AudioContext();
    for (const [i, pitch] of [880, 1175, 880].entries()) {
      const tone = audio.createOscillator();
      const gain = audio.createGain();
      tone.frequency.value = pitch;
      gain.gain.setValueAtTime(0.15, audio.currentTime + i * 0.18);
      gain.gain.exponentialRampToValueAtTime(
        0.001,
        audio.currentTime + i * 0.18 + 0.16,
      );
      tone.connect(gain).connect(audio.destination);
      tone.start(audio.currentTime + i * 0.18);
      tone.stop(audio.currentTime + i * 0.18 + 0.17);
    }
  } catch {
    // No sound: the banner still shows.
  }
}

// Exit alerts from the options listener: a banner, a chime and, where the
// browser allows it, a system notification (on the phone too, over Tailscale).
export function OptionsAlerts() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const since = useRef(seenSince());

  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      try {
        const { alerts: fresh } = await api<{ alerts: Alert[] }>(
          `/options/alerts?since=${since.current}`,
        );
        if (stopped || !fresh.length) return;
        since.current = fresh[fresh.length - 1].at;
        try {
          localStorage.setItem(SEEN, String(since.current));
        } catch {
          // Private mode: alerts may show again after a reload.
        }
        setAlerts((shown) => [...shown, ...fresh].slice(-5));
        chime();
        if ('Notification' in window && Notification.permission === 'granted')
          for (const alert of fresh)
            new Notification(alert.title, {
              body: alert.message,
              tag: alert.trade,
            });
      } catch {
        // Server restarting: try again on the next tick.
      }
    };
    void poll();
    const timer = window.setInterval(poll, 15_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);

  if (!alerts.length) return null;
  return (
    <div className="options-alerts" role="alert">
      {alerts.map((alert) => (
        <div className="options-alert" key={`${alert.trade}-${alert.event}`}>
          <BellRing size={18} />
          <div>
            <strong>{alert.title}</strong>
            <p>{alert.message}</p>
          </div>
          <button
            aria-label="Dismiss"
            onClick={() =>
              setAlerts((shown) => shown.filter((a) => a !== alert))
            }
          >
            <X size={16} />
          </button>
        </div>
      ))}
      {'Notification' in window && Notification.permission === 'default' && (
        <button
          className="options-alert-allow"
          onClick={() => void Notification.requestPermission()}
        >
          Allow notifications on this device
        </button>
      )}
    </div>
  );
}
