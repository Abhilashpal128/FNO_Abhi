"""Chronological helpers, intentionally usable without ML dependencies."""
import math


def validate_samples(rows):
    if len({r["id"] for r in rows}) != len(rows):
        raise ValueError("Duplicate sample IDs")
    for r in rows:
        if any(not isinstance(r.get(k), (int, float)) or not math.isfinite(r[k]) for k in ("signalAt", "horizonEnd", "availableAt", "featuresAsOf")):
            raise ValueError("Finite timestamps are required")
        if r["label"] not in (0, 1) or not (0 < r["signalAt"] <= r["horizonEnd"] <= r["availableAt"]):
            raise ValueError("Invalid option outcome chronology")
        if r.get("outcomeDefinition") != "option-target2-before-stop-v1":
            raise ValueError("Labels must represent the selected option premium outcome")
        if r.get("featuresAsOf", r["signalAt"] + 1) > r["signalAt"]:
            raise ValueError("Features contain information after the candidate timestamp")
        if any(v is not None and not math.isfinite(v) for v in r["features"].values()):
            raise ValueError("Non-finite feature")
    return sorted(rows, key=lambda r: (r["signalAt"], r["id"]))


def purged_before(rows, boundary, embargo_ms):
    return [r for r in rows if r["horizonEnd"] < boundary - embargo_ms and r["availableAt"] < boundary - embargo_ms]


def walk_forward(rows, folds=3, embargo_ms=1800000):
    if folds < 1 or embargo_ms < 0:
        raise ValueError("Invalid folds or embargo")
    rows = validate_samples(rows)
    width = len(rows) // (folds + 1)
    if width < 2:
        return []
    result = []
    for i in range(folds):
        test = rows[(i+1)*width:(i+2)*width if i < folds-1 else None]
        train = purged_before(rows[:(i+1)*width], test[0]["signalAt"], embargo_ms)
        result.append((train, test))
    return result


def metrics(rows, probabilities, threshold=0.5):
    if len(rows) != len(probabilities) or any(not 0 <= p <= 1 for p in probabilities):
        raise ValueError("Invalid probabilities")
    chosen = [(r, p) for r, p in zip(rows, probabilities) if p >= threshold]
    executed = [(r, p) for r, p in chosen if all(r.get(k) is not None for k in ("grossPnl", "fees", "slippage"))]
    pnls = [r["grossPnl"] - r["fees"] - r["slippage"] for r, _ in executed]
    equity = peak = drawdown = 0.0
    streak = worst = 0
    for p in pnls:
        equity += p
        peak = max(peak, equity)
        drawdown = max(drawdown, peak-equity)
        streak = streak+1 if p < 0 else 0
        worst = max(worst, streak)
    wins, losses = [p for p in pnls if p > 0], [p for p in pnls if p < 0]
    ece = 0.0
    for b in range(10):
        values = [(r["label"], p) for r, p in zip(rows, probabilities) if min(9, int(p*10)) == b]
        if values:
            ece += len(values)/len(rows) * abs(sum(y for y, _ in values)/len(values) - sum(p for _, p in values)/len(values))
    return {"eligibleOpportunities": len(rows), "selected": len(chosen), "coverage": len(chosen)/len(rows) if rows else None,
            "precision": sum(r["label"] for r, _ in chosen)/len(chosen) if chosen else None,
            "targetBeforeStopAccuracy": sum((p >= threshold) == bool(r["label"]) for r, p in zip(rows, probabilities))/len(rows) if rows else None,
            "executedCostObservations": len(executed), "grossPnl": sum(r["grossPnl"] for r, _ in executed), "fees": sum(r["fees"] for r, _ in executed), "slippage": sum(r["slippage"] for r, _ in executed),
            "netPnl": equity, "netExpectancy": equity/len(pnls) if pnls else None,
            "averageWin": sum(wins)/len(wins) if wins else None, "averageLoss": sum(losses)/len(losses) if losses else None,
            "profitFactor": sum(wins)/-sum(losses) if losses else None, "maxDrawdown": drawdown, "worstLosingStreak": worst,
            "calibrationError": ece if rows else None, "brier": sum((p-r["label"])**2 for r, p in zip(rows, probabilities))/len(rows) if rows else None}
