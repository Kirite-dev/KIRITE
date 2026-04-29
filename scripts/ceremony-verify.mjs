/**
 * KIRITE ceremony — verify a contribution.
 *
 * Reads ceremony/rounds/round_<N>.zkey, runs snarkjs zkey verify against
 * the powers-of-tau and the membership.r1cs constraint system, and
 * confirms the chain is valid up to that point. Also checks that the
 * accompanying round_<N>.attestation.txt records the matching sha256
 * of the zkey on disk.
 *
 * Usage:
 *   node scripts/ceremony-verify.mjs <N>
 *   node scripts/ceremony-verify.mjs --all
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const ROUNDS_DIR = path.join(ROOT, "ceremony", "rounds");
const R1CS = path.join(ROOT, "circuits", "build", "membership.r1cs");
const PTAU = path.join(ROOT, "circuits", "build", "pot14_final.ptau");

function sha256(p) {
  const h = createHash("sha256");
  h.update(fs.readFileSync(p));
  return h.digest("hex");
}

function verifyOne(round) {
  const zkey = path.join(ROUNDS_DIR, `round_${round}.zkey`);
  const att = path.join(ROUNDS_DIR, `round_${round}.attestation.txt`);

  console.log(`\n=== round ${round} ===`);
  if (!fs.existsSync(zkey)) {
    console.log(`  ✗ ${zkey} not found`);
    return false;
  }
  const onDiskSha = sha256(zkey);
  console.log(`  zkey sha256: ${onDiskSha}`);

  if (fs.existsSync(att)) {
    const txt = fs.readFileSync(att, "utf8");
    const m = /sha256\(zkey\):\s*([0-9a-f]{64})/.exec(txt);
    if (!m) {
      console.log(`  ⚠ attestation has no sha256(zkey) line`);
    } else if (m[1] !== onDiskSha) {
      console.log(`  ✗ attestation sha256 ${m[1]} does not match disk ${onDiskSha}`);
      return false;
    } else {
      console.log(`  ✓ attestation sha256 matches`);
    }
  } else {
    console.log(`  ⚠ no attestation file`);
  }

  try {
    execSync(
      `npx --yes snarkjs zkey verify "${R1CS}" "${PTAU}" "${zkey}"`,
      { stdio: "pipe" },
    );
    console.log(`  ✓ snarkjs zkey verify: OK`);
    return true;
  } catch (e) {
    console.log(`  ✗ snarkjs zkey verify failed`);
    console.log(`  ${e.stderr?.toString().slice(0, 200) ?? e.message}`);
    return false;
  }
}

function listRounds() {
  return fs
    .readdirSync(ROUNDS_DIR)
    .filter((f) => /^round_\d+\.zkey$/.test(f))
    .map((f) => Number(f.match(/^round_(\d+)\.zkey$/)[1]))
    .sort((a, b) => a - b);
}

function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: node scripts/ceremony-verify.mjs <N> | --all");
    process.exit(1);
  }
  const rounds = arg === "--all" ? listRounds() : [Number(arg)];
  if (rounds.length === 0) {
    console.error("no rounds found in ceremony/rounds/");
    process.exit(1);
  }
  console.log(`verifying ${rounds.length} round(s): ${rounds.join(", ")}`);
  let allOk = true;
  for (const r of rounds) {
    if (!verifyOne(r)) allOk = false;
  }
  console.log(`\n${allOk ? "✓ all rounds verified" : "✗ at least one round failed"}`);
  process.exit(allOk ? 0 : 1);
}

main();
