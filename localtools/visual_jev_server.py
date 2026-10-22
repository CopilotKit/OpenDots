"""Loopback bridge for the published Visual-Jev answer-SFT inference path.

Run separately from LocalTools so model dependencies and VRAM use are explicit.
"""
import base64
import io
import json
import os
from pathlib import Path
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / '.jev-deps'))
sys.path.insert(0, str(ROOT / 'vendor' / 'Visual-Jev' / 'code'))
os.environ.setdefault('HF_HOME', str(ROOT / 'jev-models'))


def parse_request(data):
    options = data.get('options')
    state = data.get('state')
    question = data.get('question')
    if data.get('kind') != 'choice' or not isinstance(options, list) or not 2 <= len(options) <= 8 or any(not isinstance(o, str) or not o or len(o) > 500 for o in options):
        raise ValueError('Expected 2–8 nonempty choice options.')
    if not isinstance(question, str) or not 1 <= len(question) <= 2000 or not isinstance(state, list):
        raise ValueError('Question and multimodal state required.')
    images = [p['image'] for p in state if isinstance(p, dict) and 'image' in p]
    if len(images) != 1 or not isinstance(images[0], str) or not images[0].startswith('data:image/png;base64,'):
        raise ValueError('Exactly one inline PNG is required; remote images are not fetched.')
    from PIL import Image
    image = Image.open(io.BytesIO(base64.b64decode(images[0].split(',', 1)[1], validate=True)))
    if image.width * image.height > 16000000:
        raise ValueError('Screenshot exceeds pixel limit.')
    context = '\n'.join(p for p in state if isinstance(p, str))
    if len(context) > 8000:
        raise ValueError('State exceeds context limit.')
    return image.convert('RGB'), context, question, options


def main():
    import torch
    from peft import PeftModel
    from vdm.models.vdm_model import VDM
    if not torch.cuda.is_available():
        raise RuntimeError('Visual JEV requires a working CUDA installation on this PC.')
    free, _ = torch.cuda.mem_get_info()
    if free < 10 * 1024**3:
        raise RuntimeError('Visual JEV needs at least 10 GiB free VRAM for this trial. Unload unused local models before starting; DOTS does not unload them automatically.')
    model = VDM('Qwen/Qwen3-VL-4B-Instruct', device='cuda', dtype=torch.bfloat16, with_heads=False)
    model.processor.image_processor.max_pixels = 200704
    model.backbone = PeftModel.from_pretrained(model.backbone, 'guanxuyu/visual-jev-4b-answer-sft').eval()

    class Handler(BaseHTTPRequestHandler):
        def reply(self, status, body):
            encoded = json.dumps(body).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def do_GET(self):
            self.reply(200 if self.path == '/health' else 404, {'model': 'guanxuyu/visual-jev-4b-answer-sft', 'ready': True})

        def do_POST(self):
            if self.path != '/v1/decide':
                self.reply(404, {'error': 'Unknown route'})
                return
            if self.headers.get('Origin') or self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
                self.reply(403, {'error': 'Only local JSON clients are supported'})
                return
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 12000000:
                    raise ValueError('Invalid request size')
                image, context, question, options = parse_request(json.loads(self.rfile.read(size)))
                with torch.inference_mode():
                    group = model.prepare_group(image, [{'qtype': 'choice', 'instruction': question, 'candidates': options}], shared_context=context)
                    output = model.run_independent(group)
                    probs = torch.softmax(output['lm_option_logits'][0, :len(options)].float(), dim=-1).cpu().tolist()
                index = max(range(len(probs)), key=probs.__getitem__)
                self.reply(200, {'options': options, 'probabilities': probs, 'choice_index': index})
            except (ValueError, KeyError, TypeError) as exc:
                self.reply(400, {'error': str(exc)})
            except Exception:
                self.reply(503, {'error': 'Visual JEV inference failed; no target selected'})

    server = HTTPServer(('127.0.0.1', 8017), Handler)
    print('Visual JEV ready at http://127.0.0.1:8017', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
