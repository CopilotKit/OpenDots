import { authHeaders } from './api';

/** The server persists accepted events. A closed page cannot guarantee delivery. */
export function trackSetupStep(step: 'setup_required' | 'ready' | 'settings') {
  const report = (error: 'request_rejected' | 'request_failed') =>
    console.error({
      error,
      context: { component: 'setup_telemetry' },
      timestamp: new Date().toISOString(),
    });
  const capture = (kind: 'step_viewed' | 'setup_abandoned') => {
    // Setup rendering must proceed even if this independent metadata request fails.
    void fetch('/api/setup-telemetry', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, step }),
      keepalive: true,
    })
      .then((response) => {
        if (!response.ok) report('request_rejected');
      })
      .catch(() => report('request_failed'));
  };
  capture('step_viewed');
  const abandon = () => capture('setup_abandoned');
  window.addEventListener('pagehide', abandon);
  return () => window.removeEventListener('pagehide', abandon);
}
