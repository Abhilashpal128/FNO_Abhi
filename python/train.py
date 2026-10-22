"""Explicit offline training; never runs in the collector and never auto-approves a model."""
import argparse
import hashlib
import json
import time
from pathlib import Path
from validation import validate_samples, purged_before, walk_forward, metrics


def train(rows, output, embargo=1800000, minimum=300):
    import numpy as np
    import lightgbm as lgb
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import brier_score_loss
    from sklearn.inspection import permutation_importance
    rows = validate_samples(rows)
    if embargo < 0:
        raise ValueError("Embargo cannot be negative")
    if len(rows) < minimum:
        raise ValueError(f"Need at least {minimum} non-ambiguous option outcomes")
    development, unseen = rows[:int(len(rows)*.8)], rows[int(len(rows)*.8):]
    development = purged_before(development, unseen[0]["signalAt"], embargo)
    if len(development) < 100:
        raise ValueError("Insufficient development history after purging")
    all_names = sorted(set().union(*(r["features"] for r in development)))
    variants = {"full": all_names, "withoutVolume": [n for n in all_names if not n.startswith("volume_")],
                "withoutNews": [n for n in all_names if not n.startswith("news_")],
                "withoutVolumeOrNews": [n for n in all_names if not n.startswith(("volume_", "news_"))]}
    if any(not names for names in variants.values()):
        raise ValueError("Provide independent price/risk features as well as volume and news groups")
    grid = [{"num_leaves": 7, "n_estimators": 50}, {"num_leaves": 15, "n_estimators": 100}]
    report = {"modelVersion": "lightgbm-option-v1-" + str(int(time.time())), "createdAt": int(time.time()*1000),
              "validated": False, "approvedForServing": False, "outcomeDefinition": "option-target2-before-stop-v1",
              "unseenStart": unseen[0]["signalAt"], "unseenEnd": unseen[-1]["horizonEnd"], "embargoMs": embargo,
              "variants": {}, "limitations": ["Review unseen-period costs, calibration and coverage before approval", "No profitability or accuracy guarantee"]}
    def arrays(group, names):
        return np.array([[np.nan if r["features"].get(n) is None else r["features"][n] for n in names] for r in group]), np.array([r["label"] for r in group])
    def estimator(params):
        return lgb.LGBMClassifier(**params, random_state=42, n_jobs=1, verbosity=-1, deterministic=True, force_col_wise=True)
    output = Path(output)
    output.mkdir(parents=True, exist_ok=False)
    for name, names in variants.items():
        calibration_rows = development[int(len(development)*.8):]
        tuning_rows = purged_before(development[:int(len(development)*.8)], calibration_rows[0]["signalAt"], embargo)
        tuning = []
        for params in grid:
            scores = []
            for fit_rows, valid_rows in walk_forward(tuning_rows, 3, embargo):
                x, y = arrays(fit_rows, names)
                vx, vy = arrays(valid_rows, names)
                if len(set(y)) < 2 or len(fit_rows) < 20:
                    continue
                model = estimator(params).fit(x, y)
                scores.append(float(brier_score_loss(vy, model.predict_proba(vx)[:, 1])))
            if scores:
                tuning.append((sum(scores)/len(scores), params, scores))
        if not tuning:
            raise ValueError("Insufficient chronological class coverage for validation")
        score, params, folds = min(tuning, key=lambda v: v[0])
        fit_rows = tuning_rows
        x, y = arrays(fit_rows, names)
        cx, cy = arrays(calibration_rows, names)
        tx, ty = arrays(unseen, names)
        if len(set(y)) < 2 or len(set(cy)) < 2:
            raise ValueError("Calibration requires both outcome classes in its separate time block")
        model = estimator(params).fit(x, y)
        raw = np.clip(model.predict_proba(cx)[:, 1], 1e-9, 1-1e-9)
        calibrator = LogisticRegression(random_state=42).fit(np.log(raw/(1-raw)).reshape(-1, 1), cy)
        raw_test = np.clip(model.predict_proba(tx)[:, 1], 1e-9, 1-1e-9)
        predictions = calibrator.predict_proba(np.log(raw_test/(1-raw_test)).reshape(-1, 1))[:, 1]
        importance = permutation_importance(model, tx, ty, scoring="neg_brier_score", n_repeats=5, random_state=42, n_jobs=1)
        report["variants"][name] = {"tuningBrier": score, "walkForwardBrier": folds, "hyperparameters": params,
            "unseen": metrics(unseen, predictions.tolist()), "featureImportance": dict(zip(names, model.feature_importances_.tolist())),
            "unseenPermutationImportance": dict(zip(names, importance.importances_mean.tolist())),
            "byRegime": {r: metrics([s for s in unseen if s["regime"] == r], [float(p) for s, p in zip(unseen, predictions) if s["regime"] == r]) for r in sorted({s["regime"] for s in unseen})}}
        if name == "full":
            model.booster_.save_model(str(output / "model.txt"))
            report["featureNames"] = names
            report["calibration"] = {"coefficient": float(calibrator.coef_[0][0]), "intercept": float(calibrator.intercept_[0])}
            report["trainingRange"] = [fit_rows[0]["signalAt"], fit_rows[-1]["horizonEnd"]]
            report["calibrationRange"] = [calibration_rows[0]["signalAt"], calibration_rows[-1]["horizonEnd"]]
    report["baseline"] = metrics(unseen, [sum(r["label"] for r in development)/len(development)]*len(unseen))
    report["datasetSha256"] = hashlib.sha256(json.dumps(rows, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    (output / "metadata.json").write_text(json.dumps(report, indent=2, allow_nan=False), encoding="utf-8")
    return report


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("dataset")
    p.add_argument("output")
    p.add_argument("--embargo-minutes", type=int, default=30)
    args = p.parse_args()
    rows = [json.loads(line) for line in Path(args.dataset).read_text(encoding="utf-8").splitlines() if line.strip()]
    result = train(rows, args.output, args.embargo_minutes*60000)
    print(json.dumps({"modelVersion": result["modelVersion"], "validated": False, "report": str(Path(args.output)/"metadata.json")}))
