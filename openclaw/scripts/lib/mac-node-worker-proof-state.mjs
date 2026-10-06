import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Replay the frozen pre-worker native DDL to preserve historical bootstrap
// compatibility coverage after removing the native clients.
export function seedMacNodeWorkerProofState(databasePath) {
  const statements = JSON.parse(
    fs.readFileSync(new URL("../../test/fixtures/native-node-bootstrap-ddl.json", import.meta.url), "utf8"),
  );
  assert.equal(statements.length, 4, "Legacy native bootstrap fixture must remain complete");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  try {
    for (const sql of statements) {
      db.exec(sql);
    }
    db.prepare("INSERT INTO device_identities VALUES (?, ?, ?, ?, ?, ?)").run(
      "node",
      "synthetic-native-device",
      "synthetic-public",
      "synthetic-private",
      1,
      1,
    );
    db.prepare("INSERT INTO device_auth_tokens VALUES (?, ?, ?, ?, ?)").run(
      "synthetic-native-device",
      "node",
      "synthetic-native-token",
      "[]",
      1,
    );
    db.prepare("INSERT INTO exec_approvals_config VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "current",
      '{"version":1,"defaults":{"security":"deny"},"agents":{}}',
      null,
      0,
      "deny",
      null,
      null,
      null,
      0,
      0,
      1,
    );
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 0);
    return readMacNodeWorkerProofRows(db);
  } finally {
    db.close();
  }
}

export function readMacNodeWorkerProofRows(db) {
  return ["device_identities", "device_auth_tokens", "exec_approvals_config"].map((table) =>
    db.prepare(`SELECT * FROM ${table}`).all(),
  );
}
