# kirite CLI

Command-line tool for interacting with the KIRITE privacy protocol on Solana.

## Build

```bash
git clone https://github.com/Kirite-dev/KIRITE-layer.git
cd KIRITE-layer/cli
npm install
npm run build
```

## Commands

| Command | Purpose |
|---|---|
| `kirite config` | View or edit network / wallet settings |
| `kirite deposit <mint> <amount>` | Deposit into a shield pool |
| `kirite withdraw <note>` | Withdraw using a saved note |
| `kirite transfer <mint> <recipient> <amount>` | Confidential transfer |
| `kirite pool <mint>` | Inspect a shield pool state |
| `kirite stealth` | Generate or scan stealth addresses |

## Configuration

CLI reads from `~/.config/kirite/config.json`. Override with `--config <path>` or env vars:

```bash
KIRITE_RPC_URL=https://api.devnet.solana.com
KIRITE_KEYPAIR_PATH=~/.config/solana/id.json
KIRITE_NETWORK=devnet
```

## License

MIT
