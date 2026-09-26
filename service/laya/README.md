# Laya service

Local HTTP service that scores World Info entries for the Lore stage. Same code and endpoints as
Laya WI Director's service, so either copy can run on the default URL `http://localhost:8666`.

## Run (Apple Silicon / macOS)

    cd service/laya
    python3 -m venv .venv
    source .venv/bin/activate
    pip install -r requirements.txt   # pulls laya + torch; the first model download is ~2 GB
    python3 server.py

It prints `Laya ready (backend=torch).` and `Serving on http://127.0.0.1:8666`.

- `LAYA_WID_HOST` / `LAYA_WID_PORT` change the address.
- `LAYA_WID_BACKEND=mlx` uses the faster MLX backend (`pip install laya-mlx` first; untested here).

Then in SillyTavern: Extensions → sangkhem → Settings → Lore → **Test connection**.

## Endpoints

- `GET /health` → `{"status": "ok"}`
- `POST /wi-director` → `{"results": [{"id", "relevance", "usefulness"}]}` (scores 0–5)
- `POST /reply-guard`, `POST /echo-check` are used by Laya WI Director's reply guard, not by sangkhem v1.
