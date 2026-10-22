"""Validate visual grounding output and map it to CSS viewport coordinates."""
import json
import math


def viewport_point(answer: str, width: float, height: float):
    text = answer.split('</think>')[-1].strip()
    if text.startswith('```') and text.endswith('```'):
        text = '\n'.join(text.splitlines()[1:-1]).strip()
    try:
        payload = json.loads(text)
    except (ValueError, TypeError):
        return None
    point = payload.get('point') if isinstance(payload, dict) else None
    if not isinstance(point, list) or len(point) != 2:
        return None
    if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 1000 for value in point):
        return None
    if width <= 0 or height <= 0:
        return None
    # The viewport's right/bottom edges themselves are outside its pixels.
    return min(point[0] / 1000 * width, width - 1), min(point[1] / 1000 * height, height - 1)
