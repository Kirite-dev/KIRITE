// Convert snarkjs verification_key.json to Rust byte arrays for groth16-solana.
// Points are converted from decimal field elements to 32-byte big-endian representation.
// G2 points interleave x/y components as expected by the alt_bn128 precompile.

const fs = require("fs");

const vk = JSON.parse(fs.readFileSync("build/verification_key.json", "utf8"));

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
  // G2 point: [[x_c1, x_c0], [y_c1, y_c0]]
  // alt_bn128 expects: x_c0 || x_c1 || y_c0 || y_c1
  return Buffer.concat([
    toBE32(pt[0][1]), toBE32(pt[0][0]),
    toBE32(pt[1][1]), toBE32(pt[1][0]),
  ]);
}

function toRustArray(buf, name) {
  const hex = [...buf].map(b => `0x${b.toString(16).padStart(2, "0")}`);
  const lines = [];
  for (let i = 0; i < hex.length; i += 14) {
    lines.push("        " + hex.slice(i, i + 14).join(", ") + ",");
  }
  return `    pub const ${name}: [u8; ${buf.length}] = [\n${lines.join("\n")}\n    ];`;
}

const alpha = g1ToBytes(vk.vk_alpha_1);
const beta = g2ToBytes(vk.vk_beta_2);
const gamma = g2ToBytes(vk.vk_gamma_2);
const delta = g2ToBytes(vk.vk_delta_2);
const ic0 = g1ToBytes(vk.IC[0]);
const ic1 = g1ToBytes(vk.IC[1]);

console.log(`pub mod range_vk {`);
console.log(`    // Generated from circuits/range64.circom trusted setup.`);
console.log(`    // Ceremony: powers of tau (bn128, 2^12) + circuit-specific phase 2 + beacon.`);
console.log(``);
console.log(toRustArray(alpha, "ALPHA_G1"));
console.log(``);
console.log(toRustArray(beta, "BETA_G2"));
console.log(``);
console.log(toRustArray(gamma, "GAMMA_G2"));
console.log(``);
console.log(toRustArray(delta, "DELTA_G2"));
console.log(``);
console.log(`    pub const IC: [[u8; 64]; 2] = [`);
console.log(`        [`);
const ic0hex = [...ic0].map(b => `0x${b.toString(16).padStart(2, "0")}`);
for (let i = 0; i < ic0hex.length; i += 14) {
  console.log(`            ${ic0hex.slice(i, i + 14).join(", ")},`);
}
console.log(`        ],`);
console.log(`        [`);
const ic1hex = [...ic1].map(b => `0x${b.toString(16).padStart(2, "0")}`);
for (let i = 0; i < ic1hex.length; i += 14) {
  console.log(`            ${ic1hex.slice(i, i + 14).join(", ")},`);
}
console.log(`        ],`);
console.log(`    ];`);
console.log(`}`);
