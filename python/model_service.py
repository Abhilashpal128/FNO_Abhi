"""Optional local inference. Start on loopback; it has no tools or broker/DB credentials."""
import asyncio
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, ConfigDict
from dotenv import dotenv_values


def worker_setting(name, default=""):
    # Read only worker settings; never copy database/broker secrets into worker environment.
    if name in os.environ:
        return os.environ[name]
    return dotenv_values(Path(__file__).resolve().parents[1] / ".env").get(name) or default


@asynccontextmanager
async def lifespan(app):
    app.state.sentiment = None
    app.state.predictor = None
    app.state.inference_lock = asyncio.Semaphore(1)
    if worker_setting("FINBERT_ENABLED", "false").lower() == "true":
        from transformers import pipeline
        model = worker_setting("FINBERT_MODEL", "ProsusAI/finbert")
        app.state.sentiment = pipeline("text-classification", model=model, device=-1, trust_remote_code=False)
        app.state.sentiment_version = model
    bundle = worker_setting("LIGHTGBM_BUNDLE", "")
    if bundle:
        import lightgbm as lgb
        directory = Path(bundle)
        meta = json.loads((directory / "metadata.json").read_text())
        # Validation evidence alone never silently approves a model for serving.
        if meta.get("approvedForServing") is not True or meta.get("validated") is not True:
            raise RuntimeError("Model bundle requires explicit reviewed approval")
        app.state.predictor = (lgb.Booster(model_file=str(directory / "model.txt")), meta)
    yield


app = FastAPI(title="Abhi optional financial models", lifespan=lifespan)


class SentimentRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4000)


class PredictionRequest(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)
    modelVersion: str
    asOf: int = Field(gt=0)
    features: dict[str, float | None]


@app.get("/health")
def health():
    return {"finbert": app.state.sentiment is not None, "lightgbm": app.state.predictor is not None}


@app.post("/sentiment")
async def sentiment(body: SentimentRequest):
    if app.state.sentiment is None:
        raise HTTPException(503, "FinBERT unavailable")
    async with app.state.inference_lock:
        result = await asyncio.to_thread(app.state.sentiment, body.text, truncation=True, max_length=512)
    label = result[0]["label"].lower()
    if label not in ("positive", "negative", "neutral"):
        raise HTTPException(503, "Unsupported sentiment labels")
    return {"label": label, "modelVersion": app.state.sentiment_version}


@app.post("/predict")
async def predict(body: PredictionRequest):
    if app.state.predictor is None:
        raise HTTPException(503, "Validated model unavailable")
    import math
    model, meta = app.state.predictor
    if body.modelVersion != meta["modelVersion"] or body.asOf < meta["createdAt"]:
        raise HTTPException(409, "Model version or temporal mismatch")
    names = meta["featureNames"]
    if any(k not in body.features for k in names):
        raise HTTPException(422, "Missing required features")
    values = [[float("nan") if body.features[k] is None else body.features[k] for k in names]]
    async with app.state.inference_lock:
        raw = float((await asyncio.to_thread(model.predict, values))[0])
    raw = max(1e-9, min(1-1e-9, raw))
    a, b = meta["calibration"]["coefficient"], meta["calibration"]["intercept"]
    score = max(-40, min(40, a * math.log(raw / (1-raw)) + b))
    return {"modelVersion": meta["modelVersion"], "probability": 1 / (1 + math.exp(-score))}
