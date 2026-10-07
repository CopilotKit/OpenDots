# Local deployment helpers

Artifacts that live outside the repository but are part of a self-hosted setup.
See [`docs/LOCAL-SETUP.md`](../../docs/LOCAL-SETUP.md) for the full runbook.

| File                           | Purpose                                                                                                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `opendots-gateway-lan.service` | systemd unit (socat) that forwards the Intelligence realtime gateway port from a LAN address to `127.0.0.1`, so a LAN browser can open the gateway socket. |
| `opendots-gateway-ts.service`  | Same, for the Tailscale address.                                                                                                                           |
| `env.local.example`            | Commented `.env` template for the self-hosted + LAN/Tailscale setup.                                                                                       |

Both units assume `socat` is installed and forward `40231` (the gateway port from
`INTELLIGENCE_GATEWAY_WS_URL`). Adjust the address and port to match your `.env`.

```sh
sudo cp opendots-gateway-lan.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now opendots-gateway-lan.service
```
