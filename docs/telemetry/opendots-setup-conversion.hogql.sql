-- Installation funnel. Ready configuration alone is not activation.
SELECT count() AS installations_seen,
       countIf(saw_setup_required = 1) AS setup_required,
       countIf(saw_ready = 1) AS ready,
       countIf(activated = 1) AS first_successful_answer,
       countIf(failed = 1) AS had_setup_failure,
       countIf(abandoned = 1) AS reported_abandonment
FROM (
  SELECT properties.installation_id AS installation,
         max(event = 'oss.runtime.setup_step_viewed'
             AND properties.step = 'setup_required') AS saw_setup_required,
         max(event = 'oss.runtime.setup_step_viewed'
             AND properties.step = 'ready') AS saw_ready,
         max(event = 'oss.runtime.setup_activated') AS activated,
         max(event = 'oss.runtime.setup_failed') AS failed,
         max(event = 'oss.runtime.setup_abandoned') AS abandoned
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
    AND notEmpty(toString(properties.installation_id))
  GROUP BY installation
)
