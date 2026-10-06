-- Request attempts and resolved accounts, excluding validation probes.
-- Uses same-identity boot events when request enrichment is unavailable.
SELECT toDate(timestamp) AS day, count() AS request_attempts,
       uniqExactIf(clerk_user_id, notEmpty(clerk_user_id)) AS accounts
FROM (
  SELECT request.timestamp AS timestamp,
         if(notEmpty(request.clerk_user_id), request.clerk_user_id,
            identity.clerk_user_id) AS clerk_user_id
  FROM (
    SELECT timestamp, toString(properties.telemetry_id) AS telemetry_id,
           toString(properties.clerk_user_id) AS clerk_user_id
    FROM events
    WHERE event = 'oss.runtime.copilot_request_created'
      AND properties.accessibility_title = 'OpenDots'
      AND timestamp >= now() - INTERVAL 30 DAY
      AND empty(toString(properties.validation_run_id))
  ) AS request
  LEFT JOIN (
    SELECT toString(properties.telemetry_id) AS telemetry_id,
           argMax(toString(properties.clerk_user_id), timestamp) AS clerk_user_id
    FROM events
    WHERE event IN ('oss.runtime.instance_created', 'oss.runtime.copilot_request_created')
      AND properties.accessibility_title = 'OpenDots'
      AND timestamp >= now() - INTERVAL 30 DAY
      AND empty(toString(properties.validation_run_id))
      AND notEmpty(toString(properties.telemetry_id))
      AND notEmpty(toString(properties.clerk_user_id))
    GROUP BY telemetry_id
  ) AS identity ON request.telemetry_id = identity.telemetry_id
)
GROUP BY day
ORDER BY day
