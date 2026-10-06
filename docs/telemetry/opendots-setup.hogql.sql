-- Setup events are separate from Intelligence signup events.
-- Browser abandonment is best-effort; activation means a successful answer.
SELECT event,
       toString(properties.step) AS step,
       toString(properties.error_class) AS error_class,
       count() AS events,
       uniqExact(toString(properties.installation_id)) AS installations
FROM events
WHERE event IN (
    'oss.runtime.setup_step_viewed',
    'oss.runtime.setup_failed',
    'oss.runtime.setup_activated',
    'oss.runtime.setup_abandoned'
  )
  AND properties.accessibility_title = 'OpenDots'
  AND timestamp >= now() - INTERVAL 30 DAY
  AND empty(toString(properties.validation_run_id))
GROUP BY event, step, error_class
ORDER BY event, step, error_class
