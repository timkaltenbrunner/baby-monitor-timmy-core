# WebRTC Security in Baby Monitor Timmy

## How WebRTC Encryption Works

### DTLS (Datagram Transport Layer Security)
WebRTC mandates DTLS for all connections. Before any media data flows, both devices perform a DTLS handshake to:
1. Authenticate each other's identity (via self-signed certificates)
2. Negotiate encryption keys for the session
3. Establish a secure channel

### SRTP (Secure Real-time Transport Protocol)
All audio and video data is encrypted using SRTP with keys derived from the DTLS handshake. This means:
- **Every audio packet** from Baby to Parent is encrypted
- **Every video frame** from Baby to Parent is encrypted
- **PTT audio** from Parent to Baby is encrypted
- **DataChannel messages** (camera state, PTT signals) are encrypted via DTLS/SCTP

### Encryption Algorithms
- **Key exchange:** ECDHE (Elliptic Curve Diffie-Hellman Ephemeral) – new keys per session
- **Media encryption:** AES-128-CM or AES-256-CM (Counter Mode) via SRTP
- **Integrity:** HMAC-SHA1 for SRTP packet authentication
- **DataChannel:** AES-GCM via DTLS 1.2+

## Can Connections Be Intercepted?

### What an attacker CANNOT do
1. **Read audio/video in transit** – SRTP encryption prevents eavesdropping on the media stream
2. **Inject audio/video** – SRTP authentication prevents packet injection
3. **Read DataChannel messages** – DTLS encryption protects all control messages
4. **Decrypt past sessions** – ECDHE provides forward secrecy (compromising today's keys doesn't decrypt yesterday's session)

### What an attacker COULD theoretically do

#### 1. Man-in-the-Middle at Signaling Level (MITIGATED in v1.7.0)
**Attack:** An attacker with access to the Firestore database could replace the SDP offer/answer with their own, effectively inserting themselves between Baby and Parent.

**Our mitigation (v1.8.0):** All signaling data (SDP offers, SDP answers, ICE candidates) is encrypted with AES-256-GCM using a key derived from a 256-bit pairing key. The pairing key is:
- Derived from an ECDH P-256 key exchange (not from a short code)
- Computed independently on both devices from the ECDH shared secret
- **Never sent to the backend** — only its SHA-256 hash is used as the Firestore document key

An attacker who compromises Firestore sees only encrypted SDP/ICE data and cannot perform MITM without knowing the ECDH shared secret.

#### 2. Compromised Device
If an attacker has root access to either the Baby or Parent device, they could extract the pairing key from secure storage and decrypt all signaling data. This is outside our threat model – a compromised device can access microphone/camera directly.

#### 3. Short Code Brute-Force
The 4-character code from alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (30 chars) provides ~20 bits of entropy (30^4 ≈ 810K possibilities). However, the code is **only a Firebase meeting point** — it is NOT the encryption key. Even if an attacker guesses the code:
- They see only ECDH public keys (mathematically useless without private keys)
- Codes expire after 5 minutes (Cloud Function cleanup)
- The actual encryption key comes from ECDH (256-bit entropy)

#### 4. ECDH Key Exchange over Firebase
Pairing uses **Elliptic Curve Diffie-Hellman (ECDH)** key exchange with the P-256 (secp256r1) curve over Firebase:

1. Each device generates an ephemeral ECDH key pair (private + public)
2. A short 4-character code serves as the Firebase meeting point
3. Both devices write their **public key** to `pairing_codes/{meetingKey}` under their Firebase UID
4. Both devices watch the document; when 2 pubkeys exist, ECDH completes
5. Both compute: `sharedSecret = ECDH(myPrivate, theirPublic)` → identical 32-byte secret
6. A **Short Authentication String (SAS)** is derived: `SHA-256("sas:" + sharedSecret) → 2-digit number`
7. User visually compares SAS on both screens
8. The `pairingKey` (256-bit) is derived from the shared secret and stored permanently

**Why this is secure:**
- An eavesdropper sees only public keys and the short code — they cannot compute the shared secret (ECDLP is computationally hard on P-256)
- A MITM attacker replacing pubkeys in Firebase creates separate shared secrets → different SAS → user detects mismatch (1% collision probability per attempt)
- Private keys are ephemeral and never transmitted
- Fresh key pairs generated on each pairing attempt
- The short code has no cryptographic value — it's purely a routing mechanism

**Unified flow:** Both automatic (Nearby BLE) and manual pairing use the same ECDH + SAS verification. Nearby only helps with code delivery — all cryptography happens over Firebase.

## Security Architecture Summary

```
┌──────────┐                  ┌──────────────┐                  ┌──────────┐
│  Baby    │ ──── SRTP ──────│   Network    │ ──── SRTP ─────│  Parent  │
│  Device  │ ──── DTLS ──────│  (WiFi/TURN) │ ──── DTLS ─────│  Device  │
└──────────┘                  └──────────────┘                  └──────────┘
     │                                                               │
     │                     ┌──────────────┐                          │
     └─ AES-256-GCM ─────│   Firestore   │ ──── AES-256-GCM ──────┘
       (encrypted SDP,    │  (signaling)  │   (encrypted SDP,
        ICE candidates)   └──────────────┘    ICE candidates)
```

**Layer 1 – Signaling (Firestore):** AES-256-GCM with ECDH-derived pairing key (256-bit)
**Layer 2 – Media (WebRTC):** DTLS + SRTP with per-session ECDHE keys

## Recommendations

1. **Use manual code entry** in public or shared spaces (more secure than Nearby)
2. **Keep devices updated** to receive security patches
3. **Use strong network security** (WPA3 WiFi preferred)
4. **TURN server** (Cloudflare) adds no additional risk – media is encrypted end-to-end via SRTP regardless of relay

## TURN Bandwidth & Egress/Ingress Ratio

When using TURN relay, all media flows through the Cloudflare TURN server. The egress/ingress ratio depends on the traffic pattern:

### Why Egress > Ingress is Normal

- **Baby→Parent (dominant flow):** Baby sends audio (~32kbps Opus) + video (~200-400kbps at 320x240@15fps). TURN receives this as Ingress, then relays it to Parent as Egress.
- **Parent→Baby (minimal):** Parent sends audio only during PTT (typically <5% of session time). Almost no Ingress from Parent.
- **Result:** TURN Ingress ≈ Baby's upload. TURN Egress ≈ relay to Parent ≈ roughly equal to Ingress for the active flow.

### Expected Ratios
| Scenario | Expected Egress:Ingress |
|---|---|
| Audio only, no PTT | ~1:1 |
| Audio + Video (320x240) | ~1:1 |
| Camera default OFF (v1.7.0+) | ~1:1 (only audio) |
| Camera auto-enabled on connect | ~1:1 (audio + video) |

A ratio significantly higher than 1:1 (e.g., 7:1) indicates:
1. **ICE keepalives/STUN bindings** counted as Egress but not Ingress
2. **Multiple reconnection attempts** creating duplicate TURN allocations
3. **Dashboard counting methodology** (Cloudflare may count control plane overhead)

### Optimizations (v1.7.1)
- `replaceTrack(null)` stops video RTP entirely when camera is OFF
- NoiseGate disables audio track during silence (sends comfort noise ~1kbps)
- Signaling data cleaned up after connection, reducing Firestore reads
- Stale TURN credential cache cleared on network change
