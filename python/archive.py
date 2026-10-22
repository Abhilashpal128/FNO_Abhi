"""Verified ZSTD Parquet export of a Node-generated JSONL history bundle; no MongoDB access."""
import argparse
import hashlib
import json
from pathlib import Path


def export(source, destination):
    import pyarrow as pa
    import pyarrow.parquet as pq
    source, destination = Path(source), Path(destination)
    manifest = json.loads(Path(str(source)+".manifest.json").read_text(encoding="utf-8"))
    temporary = Path(str(destination)+".partial")
    if destination.exists() or temporary.exists() or Path(str(destination)+".verified.json").exists():
        raise ValueError("Archive output must be new; existing files are never overwritten")
    digest, count = hashlib.sha256(), 0
    schema = pa.schema([("id", pa.string()), ("instrumentKey", pa.string()), ("timestamp", pa.int64()), ("record_json", pa.string())],
                       metadata={b"archive_manifest": json.dumps(manifest, sort_keys=True).encode()})
    with pq.ParquetWriter(temporary, schema, compression="zstd") as writer:
        batch = []
        with source.open("rb") as handle:
            for line in handle:
                digest.update(line)
                record = json.loads(line)
                batch.append({"id": record["id"], "instrumentKey": record["instrumentKey"], "timestamp": record.get("start", record.get("sourceTs", record.get("receivedAt"))), "record_json": line.decode("utf-8").rstrip("\n")})
                count += 1
                if len(batch) >= 1000:
                    writer.write_table(pa.Table.from_pylist(batch, schema=schema))
                    batch = []
        if batch:
            writer.write_table(pa.Table.from_pylist(batch, schema=schema))
    if count != manifest["count"] or digest.hexdigest() != manifest["sha256"]:
        raise ValueError("Source export failed integrity verification; partial archive retained for inspection")
    restored, restored_count = hashlib.sha256(), 0
    for batch in pq.ParquetFile(temporary).iter_batches(batch_size=1000, columns=["record_json"]):
        for row in batch.to_pylist():
            restored.update((row["record_json"]+"\n").encode())
            restored_count += 1
    if restored_count != count or restored.hexdigest() != manifest["sha256"]:
        raise ValueError("Parquet roundtrip failed; source records must be retained")
    temporary.rename(destination)
    checksum = hashlib.sha256()
    with destination.open("rb") as handle:
        for block in iter(lambda: handle.read(1024*1024), b""):
            checksum.update(block)
    verified = {**manifest, "parquetSha256": checksum.hexdigest(), "roundTripVerified": True, "sourceRecordsDeleted": False}
    Path(str(destination)+".verified.json").write_text(json.dumps(verified, indent=2), encoding="utf-8")
    return verified


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("jsonl")
    parser.add_argument("parquet")
    args = parser.parse_args()
    print(json.dumps(export(args.jsonl, args.parquet)))
