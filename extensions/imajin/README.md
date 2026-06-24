# @openclaw/imajin-plugin

OpenClaw plugin for the [Imajin](https://jin.imajin.ai) sovereign identity and settlement network.

## What it does

Gives your OpenClaw agent access to the Imajin network through five tools mapping to Imajin's five primitives:

| Tool              | Primitive   | What it does                                                 |
| ----------------- | ----------- | ------------------------------------------------------------ |
| `imajin_identity` | Identity    | Look up DIDs, resolve handles, check trust graph connections |
| `imajin_attest`   | Attestation | List and create signed attestations                          |
| `imajin_transact` | Settlement  | Check MJNx/MJN balances, view transaction history            |
| `imajin_fair`     | Attribution | Inspect .fair manifests — who made what and who gets paid    |
| `imajin_discover` | Discovery   | Search the network for people, businesses, events, stubs     |

## Configuration

In `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "imajin": {
        "enabled": true,
        "config": {
          "nodeUrl": "https://jin.imajin.ai",
          "did": "did:imajin:...",
          "keypairPath": "/path/to/.jin-identity.json"
        }
      }
    }
  }
}
```

- **`nodeUrl`** (required) — URL of the Imajin node
- **`did`** (optional) — Agent's DID for authenticated requests
- **`keypairPath`** (optional) — Path to Ed25519 keypair for signing attestations

## Entity context decorator

Before each turn, the plugin scans the latest user message for `@handle`
mentions and resolves them against the Imajin identity graph. Resolved entries
are prepended to the prompt with DID, scope/subtype, and tier so the model
has the right context without having to call `imajin_identity` first.

Failure modes are silent; lookups are cached in-memory for 5 minutes; capped
at 5 lookups per turn.

## Roadmap

- [x] Channel — Imajin chat as a first-class OpenClaw messaging channel
- [x] Background service — persistent node connection, auth refresh
- [x] Entity context hook — auto-decorate prompts with Imajin identity context
- [ ] Memory corpus supplement — agent's attestation chain as searchable memory
- [ ] Webhook receiver — push Imajin events (messages, transactions) into agent sessions

## About Imajin

Imajin (今人) is sovereign technology infrastructure — federated identity, .fair attribution, MJN/MJNx settlement, and discovery. No subscriptions, no cloud dependency, no vendor lock-in.

- **Network:** [jin.imajin.ai](https://jin.imajin.ai)
- **Protocol:** [protocol.dfos.com](https://protocol.dfos.com)
- **Code:** [github.com/ima-jin/imajin-ai](https://github.com/ima-jin/imajin-ai)
