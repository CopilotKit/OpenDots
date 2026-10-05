-- Signup accounts with OpenDots requests in the same 30-day window.
-- Resolve a missing request Clerk ID from boot/runtime events with the same
-- telemetry identity. Validation probes are excluded from both sides.
SELECT count(DISTINCT signup.distinct_id) AS signups_with_opendots_usage
FROM events AS signup
INNER JOIN (
  SELECT DISTINCT clerk_user_id FROM (
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
  ) WHERE notEmpty(clerk_user_id)
) AS usage ON signup.distinct_id = usage.clerk_user_id
WHERE signup.event = 'intelligence_signup'
  AND signup.timestamp >= now() - INTERVAL 30 DAY
