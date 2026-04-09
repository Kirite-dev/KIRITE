<div align="center">

> [English](README.md) · [日本語](README.ja.md)

![KIRITE](./assets/banner.png)

# 切手 — KIRITE Protocol

**Solana 向けプライバシーレイヤー**

<a href="https://github.com/KIRITE-labs/kirite-protocol/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-c8ff00?style=flat-square" alt="MIT License"/></a>
<a href="https://github.com/KIRITE-labs/kirite-protocol/actions"><img src="https://img.shields.io/badge/build-passing-c8ff00?style=flat-square" alt="build"/></a>
<a href="https://github.com/KIRITE-labs/kirite-protocol/releases"><img src="https://img.shields.io/badge/version-v0.1.0-c8ff00?style=flat-square" alt="version"/></a>
<a href="https://x.com/kiriteprotocol"><img src="https://img.shields.io/badge/x-@kiriteprotocol-c8ff00?style=flat-square" alt="x"/></a>
<a href="https://kirite-web.vercel.app"><img src="https://img.shields.io/badge/website-kirite--web.vercel.app-c8ff00?style=flat-square" alt="website"/></a>

</div>

> Solana Devnet にデプロイ済み: [`4bUHrDPuRcoYPU7UTLojXtxJsWoCj3HJbKX9oLnEnYy6`](https://explorer.solana.com/address/4bUHrDPuRcoYPU7UTLojXtxJsWoCj3HJbKX9oLnEnYy6?cluster=devnet)

KIRITE は Solana 向けのプライバシー決済レイヤーで、取引額・送信者と受信者の関連性・受信先アドレスを隠蔽します。SPL Token-2022 の Confidential Balances 拡張をベースに、Anchor と Rust で構築されています。クライアント SDK は TypeScript。

## 三層構造

| レイヤー | 説明 | ステータス |
|---|---|---|
| Confidential Transfer | Twisted ElGamal 暗号化による金額秘匿 | stable |
| Shield Pool | Pedersen コミットメント + Merkle ツリー | beta |
| Stealth Address | ECDH 二重鍵によるアドレス秘匿 | beta |

## ビルド

```bash
git clone https://github.com/KIRITE-labs/kirite-protocol.git
cd kirite-protocol
anchor build
```

## ドキュメント

- [プロトコル仕様](docs/protocol-spec.md)
- [アーキテクチャ](docs/architecture.md)
- [セキュリティモデル](SECURITY.md)
- [貢献方法](CONTRIBUTING.md)

## デプロイメント

| ネットワーク | プログラム ID | エクスプローラ |
|---|---|---|
| Devnet  | `4bUHrDPuRcoYPU7UTLojXtxJsWoCj3HJbKX9oLnEnYy6` | [Explorer](https://explorer.solana.com/address/4bUHrDPuRcoYPU7UTLojXtxJsWoCj3HJbKX9oLnEnYy6?cluster=devnet) |
| Mainnet | _監査待ち_ | — |

## リンク

- Website: https://kirite-web.vercel.app
- X: @kiriteprotocol
- GitHub: KIRITE-labs/kirite-protocol
- Ticker: $KIRITE

## ライセンス

MIT License — 詳細は [LICENSE](LICENSE) を参照。

---

<div align="center">

**署名は存在する。しかし、その手は誰にも見えない。**

</div>
