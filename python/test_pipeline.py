"""Offline verification using synthetic fixtures, never evidence of market accuracy."""
import copy
import hashlib
import json
import os
import tempfile
import unittest
import warnings
from pathlib import Path
from unittest.mock import patch
from validation import validate_samples, walk_forward, metrics


def samples(count=400):
    return [{"id": str(i), "signalAt": 1000000+i*3600000, "featuresAsOf": 1000000+i*3600000,
             "horizonEnd": 1000000+i*3600000+60000, "availableAt": 1000000+i*3600000+120000,
             "label": int(i % 4 < 2), "outcomeDefinition": "option-target2-before-stop-v1", "regime": "SIDEWAYS",
             "grossPnl": 100 if i % 4 < 2 else -50, "fees": 10, "slippage": 2,
             "features": {"price_momentum": i % 7, "volume_rvol": 1+(i % 5)/10,
                          "news_sentiment": i % 3 - 1}} for i in range(count)]


class ValidationTests(unittest.TestCase):
    def test_rejects_late_features_duplicate_ids_and_wrong_labels(self):
        for field, value in [("featuresAsOf", 999999999999), ("outcomeDefinition", "underlying-up"), ("label", 2), ("signalAt", float("inf"))]:
            rows = samples(4)
            rows[0][field] = value
            with self.assertRaises(ValueError):
                validate_samples(rows)
        with self.assertRaises(ValueError):
            validate_samples([samples(1)[0]]*2)

    def test_purge_and_embargo_leave_no_label_overlap(self):
        for fit, unseen in walk_forward(samples(40), 3, 3600000):
            self.assertTrue(all(r["availableAt"] < unseen[0]["signalAt"]-3600000 for r in fit))

    def test_costs_and_coverage_use_actual_executions_only(self):
        rows = samples(4)
        rows[0]["grossPnl"] = None
        result = metrics(rows, [.9, .9, .9, .1])
        self.assertEqual(result["coverage"], .75)
        self.assertEqual(result["executedCostObservations"], 2)
        self.assertEqual(result["netPnl"], 26)
        self.assertEqual(result["worstLosingStreak"], 1)
        self.assertIsNone(metrics([], [])["brier"])

    def test_real_lightgbm_training_and_unseen_labels_do_not_change_tuning(self):
        from train import train
        with tempfile.TemporaryDirectory() as directory, warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            rows = samples()
            report = train(rows, Path(directory)/"a")
            altered = copy.deepcopy(rows)
            for row in altered[320:]:
                row["label"] = 1-row["label"]
            other = train(altered, Path(directory)/"b")
            self.assertFalse(report["approvedForServing"])
            self.assertFalse(report["validated"])
            self.assertEqual(set(report["variants"]), {"full", "withoutVolume", "withoutNews", "withoutVolumeOrNews"})
            self.assertEqual(report["calibration"], other["calibration"])
            for name in report["variants"]:
                self.assertEqual(report["variants"][name]["hyperparameters"], other["variants"][name]["hyperparameters"])
                self.assertEqual(report["variants"][name]["walkForwardBrier"], other["variants"][name]["walkForwardBrier"])
            self.assertLess(report["trainingRange"][1]+report["embargoMs"], report["calibrationRange"][0])
            self.assertLess(report["calibrationRange"][1]+report["embargoMs"], report["unseenStart"])
            self.assertEqual(report["variants"]["full"]["unseen"]["eligibleOpportunities"], 80)
            self.assertTrue((Path(directory)/"a"/"model.txt").exists())


class ArchiveTests(unittest.TestCase):
    def bundle(self, directory):
        source = Path(directory)/"source.jsonl"
        data = b'{"id":"one","instrumentKey":"TEST","sourceTs":1000,"volume":42}\n'
        source.write_bytes(data)
        manifest = {"count": 1, "sha256": hashlib.sha256(data).hexdigest(), "timestampUnit": "milliseconds", "sourceRecordsDeleted": False}
        Path(str(source)+".manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        return source

    def test_parquet_roundtrip_and_sources_preserved(self):
        from archive import export
        with tempfile.TemporaryDirectory() as directory:
            source = self.bundle(directory)
            destination = Path(directory)/"history.parquet"
            result = export(source, destination)
            self.assertTrue(result["roundTripVerified"])
            self.assertFalse(result["sourceRecordsDeleted"])
            self.assertTrue(source.exists())
            self.assertEqual(result["parquetSha256"], hashlib.sha256(destination.read_bytes()).hexdigest())
            with self.assertRaises(ValueError):
                export(source, destination)

    def test_corruption_never_produces_a_verified_archive(self):
        from archive import export
        with tempfile.TemporaryDirectory() as directory:
            source = self.bundle(directory)
            source.write_text('{"id":"changed","instrumentKey":"TEST","sourceTs":1000}\n')
            destination = Path(directory)/"bad.parquet"
            with self.assertRaises(ValueError):
                export(source, destination)
            self.assertFalse(destination.exists())
            self.assertFalse(Path(str(destination)+".verified.json").exists())
            self.assertTrue(source.exists())


class ServiceTests(unittest.TestCase):
    def test_unconfigured_models_fail_explicitly_and_finbert_contract(self):
        from fastapi.testclient import TestClient
        from model_service import app
        with patch.dict(os.environ, {"FINBERT_ENABLED": "false", "LIGHTGBM_BUNDLE": ""}), TestClient(app) as client:
            self.assertEqual(client.get('/health').json(), {"finbert": False, "lightgbm": False})
            self.assertEqual(client.post('/sentiment', json={"text": "Policy announcement"}).status_code, 503)
            self.assertEqual(client.post('/predict', json={"modelVersion": "unknown", "asOf": 100, "features": {}}).status_code, 503)
            app.state.sentiment = lambda *args, **kwargs: [{"label": "positive"}]
            app.state.sentiment_version = "fixture-model"
            self.assertEqual(client.post('/sentiment', json={"text": "Policy announcement"}).json(), {"label": "positive", "modelVersion": "fixture-model"})
            app.state.sentiment = lambda *args, **kwargs: [{"label": "LABEL_0"}]
            self.assertEqual(client.post('/sentiment', json={"text": "Policy announcement"}).status_code, 503)


if __name__ == '__main__':
    unittest.main()
