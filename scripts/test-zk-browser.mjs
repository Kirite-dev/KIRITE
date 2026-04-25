/**
 * Headless-browser test for the miniapp ZK client.
 *
 * Loads the deployed Vercel build, waits for KZK to mount, runs a
 * commitment + Groth16 proof in the browser, then takes the resulting
 * proof + public inputs and verifies them via snarkjs locally to
 * confirm cross-environment parity (Node ↔ Chromium).
 *
 * If this passes, the miniapp can produce on-chain-acceptable proofs
 * inside a real Telegram WebView.
 */

import { chromium } from "playwright-core";
import { groth16 } from "snarkjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VK = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../circuits/build/verification_key.json"), "utf-8"),
);

const MINIAPP_URL = process.env.MINIAPP_URL || "https://kirite-tg.vercel.app";

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, info = "") {
  console.log(`  ✓ ${name}${info ? "  " + info : ""}`);
  pass++;
}
function ko(name, err) {
  console.log(`  ✗ ${name} — ${err?.message || err}`);
  fail++;
  failures.push({ name, err: err?.message || String(err) });
}

async function main() {
  console.log("KIRITE v3 browser test");
  console.log("======================");
  console.log("miniapp:", MINIAPP_URL);
  console.log();

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e?.message || e)));
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  try {
    console.log("[1] page loads");
    await page.goto(MINIAPP_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    ok("page load");

    console.log("\n[2] core globals registered");
    const globals = await page.evaluate(() => ({
      KZK: !!window.KZK,
      KA: !!window.KiriteAnchor,
      keccak: !!(window.keccak_256 || window.keccak256),
      solanaWeb3: typeof solanaWeb3 !== "undefined",
    }));
    if (!globals.KZK) ko("window.KZK missing");
    else ok("window.KZK present");
    if (!globals.KA) ko("window.KiriteAnchor missing");
    else ok("window.KiriteAnchor present");
    if (!globals.keccak) ko("keccak_256 missing");
    else ok("keccak_256 present");
    if (!globals.solanaWeb3) ko("solanaWeb3 missing");
    else ok("solanaWeb3 present");

    console.log("\n[3] /zk/ assets reachable from page origin");
    const assetCheck = await page.evaluate(async () => {
      const wasm = await fetch("/zk/membership.wasm").then((r) => ({ ok: r.ok, size: r.headers.get("content-length") }));
      const zkey = await fetch("/zk/membership_final.zkey").then((r) => ({ ok: r.ok, size: r.headers.get("content-length") }));
      return { wasm, zkey };
    });
    if (assetCheck.wasm.ok) ok("membership.wasm fetched", `(${assetCheck.wasm.size}b)`);
    else ko("membership.wasm not reachable");
    if (assetCheck.zkey.ok) ok("membership_final.zkey fetched", `(${assetCheck.zkey.size}b)`);
    else ko("zkey not reachable");

    console.log("\n[4] CDN ZK deps load (circomlibjs + snarkjs)");
    const warm = await page.evaluate(async () => {
      const t0 = Date.now();
      try {
        await window.KZK.warmUp();
        return { ok: true, elapsedMs: Date.now() - t0 };
      } catch (e) {
        return { ok: false, error: String(e?.message || e), elapsedMs: Date.now() - t0 };
      }
    });
    if (warm.ok) ok("CDN warm-up", `(${warm.elapsedMs}ms)`);
    else ko("CDN warm-up failed: " + warm.error);

    if (!warm.ok) {
      // Without ZK deps loaded the rest can't run.
      throw new Error("CDN load failure aborts proof tests");
    }

    console.log("\n[5] Poseidon commitment computation");
    const commitTest = await page.evaluate(async () => {
      const KZK = window.KZK;
      const ns = new Uint8Array(32); ns[31] = 1; // tiny deterministic secret
      const bf = new Uint8Array(32); bf[31] = 2;
      const c1 = await KZK.computeCommitment(ns, 5_000_000n, bf, 0);
      const c2 = await KZK.computeCommitment(ns, 5_000_000n, bf, 0);
      return {
        c1: Array.from(c1),
        c2: Array.from(c2),
        equal: KZK.bytesToHex(c1) === KZK.bytesToHex(c2),
      };
    });
    if (commitTest.equal) ok("Poseidon deterministic across browser calls");
    else ko("Poseidon non-deterministic in browser");

    console.log("\n[6] Groth16 proof generation in browser");
    const proofTest = await page.evaluate(async () => {
      const KZK = window.KZK;
      const ns = KZK.randomFieldBytes();
      const bf = KZK.randomFieldBytes();
      const amount = 5_000_000n;
      const leafIndex = 0;
      const commitment = await KZK.computeCommitment(ns, amount, bf, leafIndex);
      // Single-leaf tree: pad with empty leaves, our leaf is at index 0.
      const allLeaves = [commitment];
      const fakeRecipient = new Uint8Array(32);
      fakeRecipient[0] = 0xab;
      fakeRecipient[31] = 0xcd;

      const t0 = Date.now();
      try {
        const r = await KZK.generateMembershipProof({
          nullifierSecret: ns,
          blindingFactor: bf,
          amount,
          leafIndex,
          allLeaves,
          recipientPubkey: fakeRecipient,
        });
        return {
          ok: true,
          elapsedMs: Date.now() - t0,
          proofHex: KZK.bytesToHex(r.proof),
          publicInputs: {
            root: KZK.bytesToHex(r.publicInputs.root),
            nullifierHash: KZK.bytesToHex(r.publicInputs.nullifierHash),
            amount: KZK.bytesToHex(r.publicInputs.amount),
            recipientHash: KZK.bytesToHex(r.publicInputs.recipientHash),
          },
          rawPublicSignals: r.rawPublicSignals,
        };
      } catch (e) {
        return { ok: false, error: String(e?.message || e), elapsedMs: Date.now() - t0 };
      }
    });

    if (!proofTest.ok) {
      ko("browser proof gen: " + proofTest.error);
      throw new Error("proof gen aborts further tests");
    }
    ok(`browser proof gen succeeded (${proofTest.elapsedMs}ms)`);
    console.log(`    root:           ${proofTest.publicInputs.root}`);
    console.log(`    nullifier_hash: ${proofTest.publicInputs.nullifierHash}`);

    console.log("\n[7] Verify browser-generated proof with snarkjs in Node");
    // We need to reconstruct the snarkjs-format proof from our packed
    // proof bytes. The browser also returns rawPublicSignals which are
    // exactly what snarkjs needs.
    // We rebuilt proofHex in pi_a / pi_b / pi_c order using BigEndian.
    // To convert back we feed snarkjs the raw publicSignals + we
    // reconstruct the original snarkjs proof shape.
    const proofBytes = hexToBytes(proofTest.proofHex);
    const pi_a = [bigintFromBE(proofBytes.slice(0, 32)).toString(), bigintFromBE(proofBytes.slice(32, 64)).toString(), "1"];
    const pi_b = [
      [bigintFromBE(proofBytes.slice(96, 128)).toString(), bigintFromBE(proofBytes.slice(64, 96)).toString()],   // [c1, c0] of x
      [bigintFromBE(proofBytes.slice(160, 192)).toString(), bigintFromBE(proofBytes.slice(128, 160)).toString()], // [c1, c0] of y
      ["1", "0"],
    ];
    const pi_c = [bigintFromBE(proofBytes.slice(192, 224)).toString(), bigintFromBE(proofBytes.slice(224, 256)).toString(), "1"];
    const proof = { pi_a, pi_b, pi_c, protocol: "groth16", curve: "bn128" };
    const verified = await groth16.verify(VK, proofTest.rawPublicSignals, proof);
    if (verified) ok("browser proof verifies with snarkjs+VK");
    else ko("browser proof FAILED snarkjs verification");

    console.log("\n[8] page console errors");
    if (consoleErrors.length === 0) {
      ok("no console errors during the run");
    } else {
      ko("console errors detected (" + consoleErrors.length + ")");
      for (const e of consoleErrors) console.log("    [console] " + e.slice(0, 200));
    }
  } catch (e) {
    ko("test runner crashed", e);
  } finally {
    await browser.close();
  }

  console.log("\n======================");
  console.log(`PASS: ${pass}  FAIL: ${fail}`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f.name}: ${f.err}`);
  }
  process.exit(fail === 0 ? 0 : 1);
}

function hexToBytes(hex) {
  if (hex.startsWith("0x")) hex = hex.slice(2);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function bigintFromBE(bytes) {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
