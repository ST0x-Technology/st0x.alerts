# st0x Alerts — Tenderly Actions

Monitors the St0x bot wallets on Base Mainnet and sends Telegram alerts when
equity prices are not pushed on-chain during US trading hours, or when a
wallet's ETH balance is too low.

---

## Actions

### `equityPricePushMonitor` (production)

- **Bot wallet:** `0x08b20026003f3dF0E699D30B76E69C368dd2aa6c`
- **Oracle contract:** `0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a`
- Runs every 5 minutes via Tenderly periodic trigger

### `equityPricePushMonitorTest` (test)

- **Bot wallet:** `0x82245c7b71871D1A5b3FeBc161437fcE872E1817`
- Same logic as production with isolated storage keys
- Disable or remove after validation

---

## Alert conditions

| Alert              | Condition                                                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Missing price push | Bot wallet has not sent a transaction to the oracle contract within the current trading session window, past the grace period |
| Low ETH balance    | Bot wallet balance on Base falls below `MIN_ETH_BALANCE_ETH` (default: 0.01 ETH)                                              |

### Trading session windows (US Eastern)

| Session     | Hours (ET)    |
| ----------- | ------------- |
| Pre-market  | 04:00 – 09:30 |
| Regular     | 09:30 – 16:00 |
| Post-market | 16:00 – 20:00 |

Market holidays (NYSE calendar) and weekends are excluded automatically.

---

## How it works

1. Checks if today is a trading day and which session is currently active
2. Waits for the grace period (5 min from session open) before alerting
3. Queries the last 10 minutes of `eth_getLogs` from the oracle contract via
   Base RPC
4. If no transaction from the bot wallet is found → Telegram alert
5. Checks wallet ETH balance; if below threshold → Telegram alert

---

## Required secrets (Tenderly dashboard → Project → Secrets)

| Secret                    | Description                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------- |
| `TENDERLY_ACCESS_KEY`     | Tenderly API key                                                                        |
| `TENDERLY_ACCOUNT_SLUG`   | Tenderly account slug (`MrFlourite`)                                                    |
| `TENDERLY_PROJECT_SLUG`   | Tenderly project slug (`project`)                                                       |
| `TELEGRAM_BOT_TOKEN`      | Telegram bot token                                                                      |
| `TELEGRAM_CHAT_ID`        | Telegram chat/channel ID                                                                |
| `ORACLE_CONTRACT_ADDRESS` | Oracle contract to monitor (`0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a`)               |
| `BASE_RPC_URL`            | Base RPC endpoint (recommended: Alchemy/QuickNode; default: `https://mainnet.base.org`) |
| `MIN_ETH_BALANCE_ETH`     | Low balance alert threshold in ETH (default: `0.01`)                                    |

---

## Deployment

Deployment is via GitHub Actions (manual trigger):

```
Actions → Deploy Tenderly Actions → Run workflow
```

The Tenderly CLI compiles and deploys TypeScript directly — no local build step
needed.

### Local build (for testing only)

```bash
cd actions
npm install
npm run build        # both actions
npm run build:prod   # production only
npm run build:test   # test only
```

---

## Tenderly project setup

For `eth_getLogs` to find oracle transactions, the oracle contract must be added
to the Tenderly project for indexing:

**Tenderly Dashboard → Project → Contracts → Add Contract →
`0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a` (Base)**
