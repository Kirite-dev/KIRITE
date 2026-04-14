// Convert snarkjs verification_key.json (BN254 / Groth16) to Rust byte
// arrays consumable by the groth16-solana crate. Field elements are
// emitted as big-endian 32-byte words. G2 points use the BN254 syscall
// convention: x_c0 || x_c1 || y_c0 || y_c1.
//
// Handles arbitrary public input count (n_public) by emitting an IC
// array of n_public + 1 entries.
//
// Usage: node vk-to-rust-v2.js build/verification_key.json > membership_vk.rs

const fs = require("fs");

const path = process.argv[2] || "build/verification_key.json";
const vk = JSON.parse(fs.readFileSync(path, "utf8"));

function toBE32(decStr) {
  let n = BigInt(decStr);
  const buf = Buffer.alloc(32);
  for (let i = 31; i >= 0; i--) {
    buf[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return buf;
}

function g1ToBytes(pt) {
  return Buffer.concat([toBE32(pt[0]), toBE32(pt[1])]);
}

function g2ToBytes(pt) {
  // snarkjs stores G2 as [[x_c1, x_c0], [y_c1, y_c0]] internally.
  // Solana's alt_bn128 syscall consumes G2 as x_c0 || x_c1 || y_c0 || y_c1.
  return Buffer.concat([
    toBE32(pt[0][1]),
    toBE32(pt[0][0]),
    toBE32(pt[1][1]),
    toBE32(pt[1][0]),
  ]);
}

function bytesToRustLines(buf, indent) {
  const hex = [...buf].map((b) => `0x${b.toString(16).padStart(2, "0")}`);
  const lines = [];
  for (let i = 0; i < hex.length; i += 12) {
    lines.push(indent + hex.slice(i, i + 12).join(", ") + ",");
  }
  return lines.join("\n");
}

const alpha = g1ToBytes(vk.vk_alpha_1);
const beta = g2ToBytes(vk.vk_beta_2);
const gamma = g2ToBytes(vk.vk_gamma_2);
const delta = g2ToBytes(vk.vk_delta_2);

const icPoints = vk.IC.map((p) => g1ToBytes(p));
const nIc = icPoints.length;

let out = "";
out += "// Auto-generated from circuits/build/verification_key.json.\n";
out += "// DO NOT EDIT BY HAND. Run `node vk-to-rust-v2.js` to regenerate.\n";
out += `// Public inputs: ${vk.nPublic}. IC entries: ${nIc}.\n\n`;
out += "pub mod membership_vk {\n";
out += `    pub const N_PUBLIC: usize = ${vk.nPublic};\n\n`;

const emit = (name, buf) => {
  out += `    pub const ${name}: [u8; ${buf.length}] = [\n`;
  out += bytesToRustLines(buf, "        ") + "\n";
  out += "    ];\n\n";
};

emit("ALPHA_G1", alpha);
emit("BETA_G2", beta);
emit("GAMMA_G2", gamma);
emit("DELTA_G2", delta);

out += `    pub const IC: [[u8; 64]; ${nIc}] = [\n`;
for (const p of icPoints) {
  out += "        [\n";
  out += bytesToRustLines(p, "            ") + "\n";
  out += "        ],\n";
}
out += "    ];\n";
out += "}\n";

process.stdout.write(out);
