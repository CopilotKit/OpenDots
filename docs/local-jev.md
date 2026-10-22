# Local JEV browser target selection

`browser_jev_find(target, use_image=false, candidate_refs=null)` selects a current
visible browser reference. It never clicks. Use the returned reference with the
existing browser click/type tools, then verify the result. Existing tool permissions,
confirmation policy and procedure recording remain in effect.

`browser_jev_check(expectation)` returns `yes`, `no`, or `uncertain` for a fresh
screenshot, along with capture time and all three option probabilities. It is a
read-only model assessment, never an automatic step acceptance or action trigger.
For exact numeric conditions use extracted values and explicit comparisons.
Live charts may change between capture and response; historical screenshots are
not evidence that a current condition still holds.

## Selected trial: Visual JEV 4B

Source: https://huggingface.co/guanxuyu/visual-jev-4b-answer-sft

This is an answer-SFT LoRA on Qwen3-VL-4B-Instruct. It is not AutoTrust JEV or a
drop-in Ollama model. The bridge uses the author's VDM prompt and candidate-logit
readout, not free-form coordinate generation. Browser accuracy and latency need
local evaluation; published VQA scores are not browser benchmarks.

The checked-out inference source is `localtools/vendor/Visual-Jev`, revision
`a392eaedfa41adae348f9767b55c0f54b3a13b57`, from
https://github.com/guanxuyu-sv/Visual-Jev. Clone that repository and check out the
revision to reproduce this local dependency. Model dependencies are isolated in
`localtools/.jev-deps`: transformers 5.17.0, peft 0.21.0, accelerate 1.15.0,
safetensors 0.8.0, tokenizers 0.23.2, huggingface_hub 1.32.0. The existing LocalTools
CUDA PyTorch installation is used; compatibility must be verified locally.

Start with `localtools/.venv/Scripts/python.exe localtools/visual_jev_server.py`.
The server checks for at least 10 GiB free VRAM before loading; this is a trial
minimum, not a guarantee against OOM. Model weights download on first successful
startup into `localtools/jev-models`. The server listens only on 127.0.0.1:8017.
`GET /health` reports ready after loading.
For a hidden background process on Windows, use `localtools/start-jev.ps1`.
It does not register a Windows startup task; run it again after a PC restart.

Only after that succeeds, add these to the localtools `env` in mcp.servers.json:

```json
"LOCALTOOLS_JEV_URL": "http://127.0.0.1:8017",
"LOCALTOOLS_JEV_BACKEND": "visual-jev"
```

Restart idle DOTS to load configuration. The visual backend always captures a
fresh image; it cannot replace that image with historical evidence. Pass up to
seven candidate_refs from browser_find/snapshot, leaving one option for abstention.
Larger lists are rejected rather than truncated. Disabled/offscreen candidates
cannot be selected for action. Malformed, weak or ambiguous responses yield no
target. Initial probability/margin gates (0.85/0.20) are heuristics, not calibrated
UI correctness guarantees. References are rechecked after inference; no coordinates
from the model are executed. This does not implement a persistent image-target cache.

## AutoTrust alternative

An AutoTrust JEV-27B-VL `serve_decide.py` server can use the same client with
`LOCALTOOLS_JEV_BACKEND=autotrust` and its loopback URL. That protocol accepts text
choices without a screenshot. It is not installed by this change. JEV-9B is also
a different serving setup; do not assume that renaming an Ollama model preserves
the adapter, decision head or probability API.
