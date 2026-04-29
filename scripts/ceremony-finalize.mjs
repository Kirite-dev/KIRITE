/**
 * KIRITE ceremony — finalize.
 *
 * Takes the highest-numbered ceremony/rounds/round_<N>.zkey, validates
 * it, copies it into circuits/build/membership_final.zkey, exports the
 * verification key into circuits/build/verification_key.json, and
 * regenerates programs/kirite/src/utils/membership_vk.rs from it via
 * the existing vk-to-rust-v2.js helper.
 *
 * After running this, rebuild the on-chain program (anchor build) and
 * redeploy it to update the embedded verifier key.
 *
 * Usage:
 *   node scripts/ceremony-finalize.mjs
 *   node scripts/ceremony-finalize.mjs --round <N>   (use a specific round)
 *   node scripts/ceremony-finalize.mjs --dry-run
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const ROUNDS_DIR = path.join(ROOT, "ceremony", "rounds");
const R1CS = path.join(ROOT, "circuits", "build", "membership.r1cs");
const PTAU = path.join(ROOT, "circuits", "build", "pot14_final.ptau");
const FINAL_ZKEY = path.join(ROOT, "circuits", "build", "membership_final.zkey");
const VK_JSON = path.join(ROOT, "circuits", "build", "verification_key.json");
const VK_RUST = path.join(ROOT, "programs", "kirite", "src", "utils", "membership_vk.rs");
const VK_TO_RUST = path.join(ROOT, "circuits", "vk-to-rust-v2.js");

function listRounds() {
  return fs
    .readdirSync(ROUNDS_DIR)
    .filter((f) => /^round_\d+\.zkey$/.test(f))
    .map((f) => Number(f.match(/^round_(\d+)\.zkey$/)[1]))
    .sort((a, b) => a - b);
}

function pickRound() {
  const idx = process.argv.indexOf("--round");
  if (idx !== -1 && process.argv[idx + 1]) {
    return Number(process.argv[idx + 1]);
  }
  const rounds = listRounds();
  if (rounds.length === 0) {
    console.error("no rounds in ceremony/rounds/");
    process.exit(1);
  }
  return rounds[rounds.length - 1];
}

function main() {
  const round = pickRound();
  const dryRun = process.argv.includes("--dry-run");
  const zkey = path.join(ROUNDS_DIR, `round_${round}.zkey`);

  console.log(`finalize from round ${round}: ${zkey}${dryRun ? " (dry run)" : ""}`);

  console.log("[1/4] verifying chain");
  execSync(
    `npx --yes snarkjs zkey verify "${R1CS}" "${PTAU}" "${zkey}"`,
    { stdio: "inherit" },
  );

  if (dryRun) {
    console.log("\ndry run, not writing files. exiting.");
    return;
  }

  console.log("\n[2/4] copying to circuits/build/membership_final.zkey");
  fs.copyFileSync(zkey, FINAL_ZKEY);

  console.log("[3/4] exporting verification_key.json");
  execSync(
    `npx --yes snarkjs zkey export verificationkey "${FINAL_ZKEY}" "${VK_JSON}"`,
    { stdio: "inherit" },
  );

  console.log("[4/4] regenerating membership_vk.rs");
  const out = execSync(`node "${VK_TO_RUST}" "${VK_JSON}"`, { stdio: ["ignore", "pipe", "inherit"] });
  fs.writeFileSync(VK_RUST, out);

  console.log("\n✓ ceremony finalized.");
  console.log("\nnext steps:");
  console.log("  1. cargo fmt --all  (rustfmt the regenerated vk file)");
  console.log("  2. anchor build  (rebuild the on-chain program)");
  console.log("  3. solana program deploy --program-id FjYwYT9PDcW2UmM2siXpURjSSCDoXTvviqb3V8amzusL ...");
  console.log("  4. update SDK if any constants changed and publish");
}

main();
